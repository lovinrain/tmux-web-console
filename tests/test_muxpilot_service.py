from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
import threading
from pathlib import Path

import pytest

from muxpilot import service
from muxpilot.service import ProjectService, ServiceError, ensure_service, request


def mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


async def exchange(path: Path, raw: bytes) -> dict:
    reader, writer = await asyncio.open_unix_connection(str(path))
    writer.write(raw)
    await writer.drain()
    response = await reader.readline()
    writer.close()
    await writer.wait_closed()
    return json.loads(response)


async def test_private_socket_gateway_dispatches_and_restarts_without_owning_workers(
    tmp_path: Path,
) -> None:
    path = tmp_path / "private" / "projectd.sock"
    calls = []

    def dispatch(action: str, payload: dict) -> dict:
        calls.append((action, payload))
        return {"receipt": "confirmed", **payload}

    async with ProjectService(path, dispatch) as first:
        assert mode(path.parent) == 0o700
        assert mode(path) == 0o600
        assert mode(path.with_name(path.name + ".lock")) == 0o600
        health = await asyncio.to_thread(request, path, "service.health")
        assert health["instance_id"] == first.instance_id
        assert health["uid"] == os.getuid()
        result = await asyncio.to_thread(
            request, path, "project.status", {"project_id": "one"}
        )
        assert result == {"receipt": "confirmed", "project_id": "one"}
    assert not path.exists()
    assert calls == [("project.status", {"project_id": "one"})]
    async with ProjectService(path, dispatch) as second:
        assert second.instance_id != first.instance_id
        assert (await asyncio.to_thread(request, path, "service.health"))[
            "pid"
        ] == os.getpid()


@pytest.mark.parametrize(
    "raw,code",
    [
        (b"not json\n", "invalid_request"),
        (
            b'{"schema_version":1,"action":"project.status","payload":{"cursor":NaN}}\n',
            "invalid_request",
        ),
        (
            b'{"schema_version":1,"action":"project.status","action":"task.cancel","payload":{}}\n',
            "invalid_request",
        ),
        (
            b'{"schema_version":2,"action":"project.status","payload":{}}\n',
            "schema_mismatch",
        ),
        (
            b'{"schema_version":true,"action":"project.status","payload":{}}\n',
            "schema_mismatch",
        ),
        (
            b'{"schema_version":1,"action":"project.status","payload":{},"unexpected":1}\n',
            "invalid_request",
        ),
        (
            b'{"schema_version":1,"action":"project.status","payload":[]}\n',
            "invalid_request",
        ),
        (
            b'{"schema_version":1,"action":"../project","payload":{}}\n',
            "invalid_request",
        ),
        (b"x" * (service.MAX_REQUEST_BYTES + 10) + b"\n", "request_too_large"),
    ],
)
async def test_invalid_and_oversized_envelopes_never_dispatch(
    tmp_path: Path, raw: bytes, code: str
) -> None:
    calls = []
    async with ProjectService(
        tmp_path / "projectd.sock", lambda *args: calls.append(args)
    ) as server:
        response = await exchange(server.socket_path, raw)
        assert response["ok"] is False
        assert response["code"] == code
        assert not calls


async def test_partial_request_times_out_and_does_not_dispatch(tmp_path: Path) -> None:
    calls = []
    async with ProjectService(
        tmp_path / "projectd.sock",
        lambda *args: calls.append(args),
        request_timeout=0.02,
    ) as server:
        response = await exchange(server.socket_path, b'{"schema_version":1')
        assert response["code"] == "request_timeout"
        assert not calls


async def test_peer_uid_rejection_happens_before_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = []
    async with ProjectService(
        tmp_path / "projectd.sock", lambda *args: calls.append(args)
    ) as server:
        monkeypatch.setattr(service, "_peer_uid", lambda sock: os.getuid() + 1)
        response = await exchange(
            server.socket_path,
            b'{"schema_version":1,"action":"project.status","payload":{}}\n',
        )
        assert response["code"] == "unauthorized_peer"
        assert not calls


@pytest.mark.parametrize(
    "unsafe", ["directory", "symlink", "file", "socket_permissions"]
)
async def test_rejects_unsafe_paths_without_repairing_unrelated_resources(
    tmp_path: Path, unsafe: str
) -> None:
    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    path = directory / "projectd.sock"
    target = tmp_path / "retained"
    target.write_text("keep")
    listener = None
    if unsafe == "directory":
        directory.chmod(0o755)
    elif unsafe == "symlink":
        path.symlink_to(target)
    elif unsafe == "file":
        path.write_text("unrelated")
    else:
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path))
        path.chmod(0o666)
    try:
        with pytest.raises(ServiceError, match="mode"):
            await ProjectService(path, lambda *args: {}).start()
        assert target.read_text() == "keep"
        if unsafe == "directory":
            assert mode(directory) == 0o755
        elif unsafe == "file":
            assert path.read_text() == "unrelated"
        elif unsafe == "symlink":
            assert path.is_symlink()
        else:
            assert mode(path) == 0o666
    finally:
        if listener is not None:
            listener.close()


async def test_duplicate_service_does_not_unlink_live_owner(tmp_path: Path) -> None:
    path = tmp_path / "projectd.sock"
    async with ProjectService(path, lambda *args: {}) as first:
        inode = path.stat().st_ino
        with pytest.raises(ServiceError) as error:
            await ProjectService(path, lambda *args: {}).start()
        assert error.value.code == "already_running"
        assert path.stat().st_ino == inode
        assert (await asyncio.to_thread(request, path, "service.health"))[
            "instance_id"
        ] == first.instance_id


async def test_live_listener_without_lock_is_preserved(tmp_path: Path) -> None:
    path = tmp_path / "projectd.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    path.chmod(0o600)
    listener.listen()
    inode = path.stat().st_ino
    try:
        with pytest.raises(ServiceError) as error:
            await ProjectService(path, lambda *args: {}).start()
        assert error.value.code == "already_running"
        assert path.stat().st_ino == inode
    finally:
        listener.close()


async def test_dead_owned_socket_is_recovered(tmp_path: Path) -> None:
    path = tmp_path / "projectd.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    path.chmod(0o600)
    listener.close()
    async with ProjectService(path, lambda *args: {}) as server:
        assert (await asyncio.to_thread(request, path, "service.health"))[
            "instance_id"
        ] == server.instance_id


async def test_stop_waits_for_effect_receipt_before_releasing_gateway_lock(
    tmp_path: Path,
) -> None:
    started, finish = threading.Event(), threading.Event()
    path = tmp_path / "projectd.sock"

    def dispatch(action: str, payload: dict) -> dict:
        started.set()
        assert finish.wait(timeout=3)
        return {"state": "confirmed"}

    server = ProjectService(path, dispatch)
    await server.start()
    operation = asyncio.create_task(
        asyncio.to_thread(request, path, "task.cancel", {"operation_id": "one"})
    )
    assert await asyncio.to_thread(started.wait, 1)
    stopping = asyncio.create_task(server.stop())
    await asyncio.sleep(0.01)
    assert not stopping.done()
    with pytest.raises(ServiceError) as error:
        await ProjectService(path, lambda *args: {}).start()
    assert error.value.code == "already_running"
    finish.set()
    assert await operation == {"state": "confirmed"}
    await stopping
    assert not path.exists()


async def test_service_error_is_structured_and_credentials_are_not_echoed(
    tmp_path: Path,
) -> None:
    def dispatch(action: str, payload: dict) -> None:
        raise PermissionError(f"Denied credential {payload['token']}")

    async with ProjectService(tmp_path / "projectd.sock", dispatch) as server:
        with pytest.raises(ServiceError) as error:
            await asyncio.to_thread(
                request,
                server.socket_path,
                "project.status",
                {"token": "private-do-not-echo"},
            )
        assert error.value.code == "unauthorized"
        assert str(error.value) == "Denied credential [redacted]"


async def test_stop_preserves_replaced_socket_and_releases_old_lock(
    tmp_path: Path,
) -> None:
    path = tmp_path / "projectd.sock"
    server = ProjectService(path, lambda *args: {})
    await server.start()
    path.unlink()
    path.write_text("replacement belongs to another resource")
    await server.stop()
    assert path.read_text() == "replacement belongs to another resource"
    path.unlink()
    async with ProjectService(path, lambda *args: {}):
        assert path.exists()


async def test_internal_dispatch_failure_never_echoes_provider_or_credential_details(
    tmp_path: Path,
) -> None:
    def dispatch(action: str, payload: dict) -> None:
        raise RuntimeError("private-provider-secret")

    async with ProjectService(tmp_path / "projectd.sock", dispatch) as server:
        with pytest.raises(ServiceError) as error:
            await asyncio.to_thread(request, server.socket_path, "project.status", {})
        assert error.value.code == "internal_error"
        assert "private-provider-secret" not in str(error.value)


async def test_journal_generation_failure_reaches_client_as_fenced_receipt(
    tmp_path: Path,
) -> None:
    def dispatch(action: str, payload: dict) -> None:
        raise service.LeaseError("Coordinator generation no longer owns project")

    async with ProjectService(tmp_path / "projectd.sock", dispatch) as server:
        with pytest.raises(ServiceError) as error:
            await asyncio.to_thread(
                request, server.socket_path, "task.cancel", {"generation": 1}
            )
        assert error.value.code == "stale_generation"


async def test_bootstrap_reuses_live_service_without_starting_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unexpected(*args, **kwargs):
        pytest.fail("Healthy service must not be launched again")

    monkeypatch.setattr(service.subprocess, "Popen", unexpected)
    async with ProjectService(tmp_path / "projectd.sock", lambda *args: {}) as server:
        status = await asyncio.to_thread(ensure_service, server.socket_path)
        assert status["reused"] is True
        assert status["instance_id"] == server.instance_id
        assert (
            mode(
                server.socket_path.with_name(
                    server.socket_path.name + ".bootstrap.lock"
                )
            )
            == 0o600
        )


async def test_bootstrap_rejects_changed_configuration_and_preserves_service(
    tmp_path: Path,
) -> None:
    path = tmp_path / "projectd.sock"
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {"state_root": str(tmp_path), "socket_path": str(path), "worker_limit": 2}
        )
    )
    config_path.chmod(0o600)
    configuration = service._configuration_identity(config_path)
    async with ProjectService(
        path, lambda *args: {}, configuration=configuration
    ) as server:
        assert (await asyncio.to_thread(ensure_service, path, config_path))[
            "reused"
        ] is True
        config_path.write_text(
            json.dumps(
                {
                    "state_root": str(tmp_path),
                    "socket_path": str(path),
                    "worker_limit": 3,
                }
            )
        )
        with pytest.raises(ServiceError) as error:
            await asyncio.to_thread(ensure_service, path, config_path)
        assert error.value.code == "configuration_mismatch"
        assert "restart only" in str(error.value)
        assert (await asyncio.to_thread(request, path, "service.health"))[
            "instance_id"
        ] == server.instance_id
        assert not path.with_name(path.name + ".log").exists()


async def test_bootstrap_rejects_stale_code_without_restarting_live_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "projectd.sock"
    async with ProjectService(path, lambda *args: {}) as server:
        monkeypatch.setattr(service, "_package_identity", lambda: "changed-release")
        with pytest.raises(ServiceError) as error:
            await asyncio.to_thread(ensure_service, path)
        assert error.value.code == "service_version_mismatch"
        assert (await asyncio.to_thread(request, path, "service.health"))[
            "instance_id"
        ] == server.instance_id
        assert not path.with_name(path.name + ".log").exists()


async def test_bootstrap_rejects_stale_muxdeck_dependency_without_restarting_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    release = tmp_path / "release"
    pilot = release / "muxpilot" / "service.py"
    dependency = release / "tmux_console" / "control_cli.py"
    pilot.parent.mkdir(parents=True)
    dependency.parent.mkdir(parents=True)
    pilot.write_text("# unchanged project service\n")
    dependency.write_text("# original Muxdeck control client\n")
    monkeypatch.setattr(service, "_PACKAGE_ROOT", release)
    path = tmp_path / "projectd.sock"
    async with ProjectService(path, lambda *args: {}) as server:
        assert (await asyncio.to_thread(ensure_service, path))["reused"] is True
        dependency.write_text("# changed Muxdeck control client\n")
        with pytest.raises(ServiceError) as error:
            await asyncio.to_thread(ensure_service, path)
        assert error.value.code == "service_version_mismatch"
        assert pilot.read_text() == "# unchanged project service\n"
        assert (await asyncio.to_thread(request, path, "service.health"))[
            "instance_id"
        ] == server.instance_id
        assert not path.with_name(path.name + ".log").exists()
