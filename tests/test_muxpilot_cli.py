"""Focused control contracts: identity, authorization and lost-response recovery."""

from __future__ import annotations

import json
import subprocess
import time
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any, ClassVar

import pytest

from muxpilot.cli import main, parser
from muxpilot.config import Config, private_write
from muxpilot.multica import MulticaClient, MulticaError
from muxpilot.project import AuthorizationError, ProjectController, ProjectError
from muxpilot.store import JournalStore


class FakeMultica:
    effects: ClassVar[list[dict[str, Any]]] = []
    generations: ClassVar[dict[str, int]] = {}
    receipts: ClassVar[dict[str, dict[str, Any]]] = {}
    lost_register = False

    def __init__(self, *args: Any, **kwargs: Any):
        self.generation = kwargs.get("generation")

    project_path = staticmethod(MulticaClient.project_path)

    def capabilities(self) -> dict[str, Any]:
        return {"protocol": "muxpilot-v1"}

    def request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        if method == "GET" and path.endswith("/recovery"):
            return {
                "issues": [],
                "runs": [],
                "generation": self.generations[path.split("/")[-2]],
            }
        assert payload
        identifier = payload["operation_id"]
        if identifier not in self.receipts:
            self.effects.append(payload)
            self.receipts[identifier] = {"project_id": path.split("/")[-2]}
        if self.lost_register:
            type(self).lost_register = False
            raise MulticaError("lost reply", uncertain=True)
        return self.receipts[identifier]

    def lease(
        self, project_id: str, operation_id: str, **kwargs: Any
    ) -> dict[str, Any]:
        if operation_id not in self.receipts:
            generation = self.generations.get(project_id, 0) + 1
            self.generations[project_id] = generation
            self.receipts[operation_id] = {
                "generation": generation,
                "token": "coordinator-secret-sentinel",
                "expires_at": time.time() + 1800,
            }
        return self.receipts[operation_id]

    def command(self, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        assert self.generation == self.generations[project_id]
        identifier = payload["operation_id"]
        if identifier not in self.receipts:
            self.effects.append(payload)
            self.receipts[identifier] = {
                "issue_id": str(uuid.uuid4()),
                "accepted": True,
            }
        return self.receipts[identifier]

    def snapshot(self, project_id: str) -> dict[str, Any]:
        return {"issues": [], "runs": [], "cursor": 0}

    def events(self, project_id: str, after: int) -> dict[str, Any]:
        return {
            "events": [],
            "cursor": after,
            "prev_cursor": after,
            "page_complete": True,
        }

    def operation(self, project_id: str, operation_id: str) -> dict[str, Any]:
        return {"status": 200, "response": self.receipts[operation_id]}


class FakeMuxdeck:
    workspace: dict[str, Any] | None = None

    def __init__(self, *args: Any, **kwargs: Any):
        pass

    def request(
        self, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        if path == "/api/sessions":
            return {
                "sessions": [
                    {
                        "name": name,
                        "id": "$" + str(index),
                        "created": 100,
                        "serverStarted": 50,
                        "serverPid": 1,
                        "activePaneId": "%" + str(index),
                        "panes": [{"id": "%" + str(index), "panePid": index + 100}],
                    }
                    for index, name in ((1, "main"), (2, "other"))
                ]
            }
        if path == "/api/workspaces" and method == "POST":
            type(self).workspace = {
                "id": str(uuid.uuid4()),
                "tabs": payload["tabs"] if payload else [],
                "groups": [],
            }
            return {"workspace": self.workspace}
        if path.startswith("/api/workspaces/"):
            return {"workspace": self.workspace}
        if path == "/api/capabilities":
            return {"version": "fixture"}
        raise AssertionError(path)


@pytest.fixture
def controller(tmp_path: Path) -> tuple[ProjectController, Path]:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.name", "Fixture"], check=True
    )
    subprocess.run(
        ["git", "-C", str(repo), "config", "user.email", "fixture@example.test"],
        check=True,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "--allow-empty",
            "-qm",
            "baseline",
        ],
        check=True,
    )
    token = tmp_path / "private/token"
    private_write(token, "human-token-sentinel")
    config = Config(
        tmp_path / "state",
        tmp_path / "state/projectd.sock",
        multica_token_file=token,
        multica_workspace_id=str(uuid.uuid4()),
        muxdeck_token_file=token,
    )
    FakeMultica.effects, FakeMultica.generations, FakeMultica.receipts = [], {}, {}
    FakeMultica.lost_register = False
    FakeMuxdeck.workspace = None
    return ProjectController(
        config, multica_factory=FakeMultica, muxdeck_factory=FakeMuxdeck
    ), repo


def start(controller: ProjectController, repo: Path, **extra: Any) -> dict[str, Any]:
    return controller.dispatch(
        "start",
        {
            "repo": str(repo),
            "goal": "Implement tested feature",
            "main_session": "main",
            "_credential": controller.credential_for("start"),
            **extra,
        },
    )


def scoped(
    controller: ProjectController, tool_action: str, project: str, **extra: Any
) -> dict[str, Any]:
    return controller.dispatch(
        tool_action,
        {
            "project": project,
            "_credential": controller.credential_for(tool_action, project),
            **extra,
        },
    )


def test_start_reuses_uuid_board_and_rejects_second_main(
    controller: tuple[ProjectController, Path],
) -> None:
    tool, repo = controller
    first = start(tool, repo)
    again = start(tool, repo)
    assert first["project"]["project_id"] == again["project"]["project_id"]
    assert len(FakeMultica.effects) == 1
    with pytest.raises(ProjectError, match="different main incarnation"):
        start(tool, repo, main_session="other")
    assert len(FakeMultica.effects) == 1


def test_unknown_main_has_no_project_or_backend_effect(
    controller: tuple[ProjectController, Path],
) -> None:
    tool, repo = controller
    with pytest.raises(ProjectError, match="verified visible"):
        start(tool, repo, main_session="missing")
    assert tool.registry.records() == []
    assert not FakeMultica.effects


def test_lost_registration_reply_reuses_exact_receiver_identity(
    controller: tuple[ProjectController, Path],
) -> None:
    tool, repo = controller
    FakeMultica.lost_register = True
    with pytest.raises(MulticaError):
        start(tool, repo)
    result = start(tool, repo)
    assert result["generation"] == 1
    assert len(FakeMultica.effects) == 1


def test_credential_required_project_scoped_expired_and_revoked(
    controller: tuple[ProjectController, Path],
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    with pytest.raises(AuthorizationError):
        tool.dispatch("hold", {"project": project})
    with pytest.raises(AuthorizationError):
        tool.dispatch(
            "hold", {"project": project, "_credential": tool.credential_for("start")}
        )
    credentials_path = tool.config.state_root / project / "coordinator.json"
    credential = json.loads(credentials_path.read_text())
    credential["local_expires_at"] = 0
    private_write(credentials_path, json.dumps(credential))
    with pytest.raises(AuthorizationError, match="expired"):
        scoped(tool, "status", project)
    credential["local_expires_at"] = time.time() + 60
    credential["local_revoked"] = True
    private_write(credentials_path, json.dumps(credential))
    with pytest.raises(AuthorizationError, match="revoked"):
        scoped(tool, "hold", project)
    assert len(FakeMultica.effects) == 1


def test_plan_preflight_replay_and_literal_acceptance_array(
    controller: tuple[ProjectController, Path],
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    invalid = {
        "completion_criteria": ["Feature tested"],
        "stages": [
            {
                "stage": 1,
                "tasks": [
                    {"title": "valid", "acceptance": ["pass"]},
                    {"title": "missing"},
                ],
            }
        ],
    }
    with pytest.raises(ProjectError, match="acceptance"):
        scoped(tool, "plan", project, plan=invalid)
    assert len(FakeMultica.effects) == 1
    plan = {
        "completion_criteria": ["Feature tested"],
        "stages": [
            {
                "stage": 1,
                "tasks": [
                    {"title": "implementation", "acceptance": ["pass", "evidence"]}
                ],
            }
        ],
    }
    scoped(tool, "plan", project, plan=plan)
    second = scoped(tool, "plan", project, plan=plan)
    assert second["reused"] is True
    assert len(FakeMultica.effects) == 3
    assert FakeMultica.effects[-1]["acceptance"] == "pass\nevidence"
    assert FakeMultica.effects[-1]["status"] == "backlog"
    assert FakeMultica.effects[-1]["no_start"] is True


def test_operation_admission_distinguishes_first_effect_from_replay(
    controller: tuple[ProjectController, Path],
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    operation_id = str(uuid.uuid4())
    first = scoped(
        tool,
        "operation",
        project,
        operation_id=operation_id,
        kind="publish.pr",
        payload={"base": "main"},
    )
    second = scoped(
        tool,
        "operation",
        project,
        operation_id=operation_id,
        kind="publish.pr",
        payload={"base": "main"},
    )
    assert first["execute_allowed"] is True
    assert second["execute_allowed"] is False
    prepared_id = str(uuid.uuid4())
    credentials = tool._credentials(tool.registry.resolve(project))
    with tool._store(tool.registry.resolve(project)) as store:
        store.prepare_operation(
            prepared_id,
            "publish.pr",
            {"base": "main"},
            credentials["owner"],
            credentials["generation"],
        )
    admitted = scoped(
        tool,
        "operation",
        project,
        operation_id=prepared_id,
        kind="publish.pr",
        payload={"base": "main"},
    )
    assert admitted["execute_allowed"] is True
    tool.dispatch(
        "resume", {"project": project, "_credential": tool.credential_for("resume")}
    )
    confirmed = scoped(
        tool,
        "operation",
        project,
        operation_id=operation_id,
        kind="publish.pr",
        payload={"base": "main"},
        receipt={"url": "https://example.test/pr/1", "revision": "verified"},
    )
    assert confirmed["state"] == "confirmed"


def test_audit_excludes_private_tokens(
    controller: tuple[ProjectController, Path], tmp_path: Path
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    token = tool.credential_for("decision", project)
    scoped(
        tool,
        "decision",
        project,
        message="Private "
        + token
        + " human-token-sentinel coordinator-secret-sentinel",
        ack=0,
    )
    destination = tmp_path / "audit"
    scoped(tool, "audit", project, destination=str(destination))
    text = (destination / "events.jsonl").read_text()
    assert token not in text
    assert "human-token-sentinel" not in text
    assert "coordinator-secret-sentinel" not in text


def test_control_requires_exact_run_and_closure_requires_evidence(
    controller: tuple[ProjectController, Path],
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    with pytest.raises(ProjectError, match="exact --run"):
        scoped(
            tool,
            "control",
            project,
            action="supplement",
            task=str(uuid.uuid4()),
            message="hello",
        )
    with pytest.raises(ProjectError, match="integration revision"):
        scoped(tool, "close", project, evidence={})


def test_worker_cli_does_not_load_operator_credentials(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("MUXPILOT_ROLE", "worker")
    assert main(["resume", str(uuid.uuid4()), "--takeover"]) == 1
    assert "cannot acquire coordinator" in capsys.readouterr().err


def test_cli_parser_documents_alias_and_bounded_await() -> None:
    assert parser().parse_args(["await", "project-name"]).wait == 30
    assert (
        parser().parse_args(["main", "--repo", "/tmp/repo", "--goal", "goal"]).model
        == "gpt-6.1-sol"
    )


def test_incompatible_backend_capabilities_fail_closed() -> None:
    client = MulticaClient("http://127.0.0.1:1234")
    client.request = lambda *args, **kwargs: {}  # type: ignore[method-assign]
    with pytest.raises(MulticaError, match="incompatible"):
        client.capabilities()


def test_project_token_cannot_read_another_project(
    controller: tuple[ProjectController, Path], tmp_path: Path
) -> None:
    tool, repo = controller
    first = start(tool, repo)["project"]["project_id"]
    other = tmp_path / "other-repo"
    subprocess.run(["git", "clone", "-q", str(repo), str(other)], check=True)
    second = start(tool, other)["project"]["project_id"]
    with pytest.raises(AuthorizationError, match="does not authorize"):
        tool.dispatch(
            "status",
            {"project": second, "_credential": tool.credential_for("status", first)},
        )


def test_resume_recovers_lost_private_credential_commit(
    controller: tuple[ProjectController, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    old_token = tool.credential_for("status", project)
    import muxpilot.project as project_module

    original = project_module.private_write
    failed = False

    def fail_once(path: Path, data: str) -> None:
        nonlocal failed
        if path.name == "coordinator.json" and not failed:
            failed = True
            raise OSError("injected credential receipt failure")
        original(path, data)

    monkeypatch.setattr(project_module, "private_write", fail_once)
    payload = {
        "project": project,
        "_credential": tool.credential_for("resume", project),
    }
    with pytest.raises(OSError):
        tool.dispatch("resume", payload)
    result = tool.dispatch("resume", payload)
    assert result["generation"] == 2
    assert FakeMultica.generations[project] == 2
    with pytest.raises(AuthorizationError):
        tool.dispatch("status", {"project": project, "_credential": old_token})


def test_archive_preserves_resources_and_restore_requires_reconciliation(
    controller: tuple[ProjectController, Path], tmp_path: Path
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    result = scoped(tool, "archive", project)
    assert result["sessions_preserved"] and result["worktrees_preserved"]
    with pytest.raises(ProjectError, match="archived"):
        scoped(tool, "activate", project, stage=1)
    backup = tmp_path / "backup"
    scoped(tool, "backup", project, destination=str(backup))
    restored = tool.dispatch(
        "restore",
        {
            "backup": str(backup),
            "destination": str(tmp_path / "restored"),
            "_credential": tool.credential_for("restore"),
        },
    )
    assert restored["requires_resume"] is True
    assert restored["external_state_overwritten"] is False
    assert restored["evidence"]["complete"] is True


def test_expired_lease_resume_acquires_new_fenced_generation(
    controller: tuple[ProjectController, Path],
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    with (
        tool._store(tool.registry.resolve(project)) as store,
        store.transaction() as database,
    ):
        database.execute("UPDATE lease SET expires_at=0")
    result = tool.dispatch(
        "resume", {"project": project, "_credential": tool.credential_for("resume")}
    )
    assert result["generation"] == 2
    assert FakeMultica.generations[project] == 2


def test_goal_amendment_versions_requested_delivery_endpoint(
    controller: tuple[ProjectController, Path],
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    start(tool, repo, goal="Implement tested feature and open a PR")
    with tool._store(tool.registry.resolve(project)) as store:
        assert store.get_mapping("project", "goal")["payload"]["delivery"] == "pr"  # type: ignore[index]
        assert (
            len([event for event in store.events() if event["kind"] == "input.amended"])
            == 1
        )


def test_feed_adapter_preserves_sparse_project_cursor_and_event_identity(
    controller: tuple[ProjectController, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    event_id = str(uuid.uuid4())

    def events(self: FakeMultica, project_id: str, after: int) -> dict[str, Any]:
        return {
            "events": [
                {
                    "id": event_id,
                    "sequence": 9,
                    "type": "human.comment",
                    "actor_type": "human",
                    "actor_id": "member",
                    "payload": {"text": "prioritize API"},
                }
            ]
            if after == 0
            else [],
            "prev_cursor": after,
            "page_complete": True,
            "cursor": 9,
        }

    monkeypatch.setattr(FakeMultica, "events", events)
    scoped(tool, "events", project, after=0)
    scoped(tool, "events", project, after=0)
    with tool._store(tool.registry.resolve(project)) as store:
        assert store.source_cursor("multica") == 9
        assert (
            len(
                [
                    event
                    for event in store.events()
                    if event.get("source_event_id") == event_id
                ]
            )
            == 1
        )


def test_completed_runtime_first_observation_links_to_history_not_live(
    controller: tuple[ProjectController, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    run_id, issue_id, execution_id = (str(uuid.uuid4()) for _ in range(3))

    def snapshot(self: FakeMultica, project_id: str) -> dict[str, Any]:
        return {
            "issues": [],
            "runs": [{"id": run_id, "issue_id": issue_id, "status": "succeeded"}],
        }

    monkeypatch.setattr(FakeMultica, "snapshot", snapshot)
    directory = (
        tool.config.state_root / project / "runs" / run_id / "executions" / execution_id
    )
    identity = {
        "sessionId": "$1",
        "sessionCreated": 100,
        "serverStarted": 50,
        "serverPid": 1,
        "paneId": "%1",
        "panePid": 101,
    }
    private_write(
        directory / "session.json",
        json.dumps(
            {
                "project_id": project,
                "task_id": issue_id,
                "run_id": run_id,
                "execution_id": execution_id,
                "started_at": 1,
                "placement": "confirmed",
                "identity": identity,
                "terminal_url": "http://127.0.0.1/worker?historyId=history",
            }
        ),
    )
    private_write(
        directory / "execution.json",
        json.dumps({"state": "completed", "exit_status": 0}),
    )
    scoped(tool, "status", project)
    bindings = [
        effect
        for effect in FakeMultica.effects
        if effect.get("action") == "bind_terminal"
    ]
    assert bindings[-1]["terminal_state"] == "history"
    scoped(tool, "status", project)
    assert (
        len(
            [
                effect
                for effect in FakeMultica.effects
                if effect.get("action") == "bind_terminal"
            ]
        )
        == 1
    )


def test_operator_recovery_reads_expired_authority_without_mutating(
    controller: tuple[ProjectController, Path],
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    path = tool.config.state_root / project / "coordinator.json"
    credentials = json.loads(path.read_text())
    credentials["local_expires_at"] = 0
    private_write(path, json.dumps(credentials))
    result = tool.dispatch(
        "recovery", {"project": project, "_credential": tool.credential_for("recovery")}
    )
    assert result["mutation_attempted"] is False
    assert result["backend"]["generation"] == 1
    assert len(FakeMultica.effects) == 1


@pytest.mark.parametrize(
    "status",
    [
        "queued",
        "dispatched",
        "running",
        "waiting_local_directory",
        "deferred",
        "succeeded",
        "failed",
        "cancelled",
    ],
)
def test_resume_adopts_every_native_active_state_without_retrying_terminal_runs(
    controller: tuple[ProjectController, Path],
    monkeypatch: pytest.MonkeyPatch,
    status: str,
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    run_id = str(uuid.uuid4())
    monkeypatch.setattr(
        FakeMultica,
        "snapshot",
        lambda self, project_id: {
            "issues": [],
            "runs": [{"id": run_id, "issue_id": str(uuid.uuid4()), "status": status}],
        },
    )
    tool.dispatch(
        "resume", {"project": project, "_credential": tool.credential_for("resume")}
    )
    adopted = [
        effect for effect in FakeMultica.effects if effect.get("action") == "adopt_run"
    ]
    expected = status in {
        "queued",
        "dispatched",
        "running",
        "waiting_local_directory",
        "deferred",
    }
    assert bool(adopted) is expected
    if expected:
        assert adopted[0]["task_id"] == run_id


@pytest.mark.parametrize("lose_receipt", [False, True])
def test_entire_worker_commit_range_integrates_and_recovers_without_duplicates(
    controller: tuple[ProjectController, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    lose_receipt: bool,
) -> None:
    tool, repo = controller
    project = start(tool, repo)["project"]["project_id"]
    baseline = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
    ).strip()
    worker = tmp_path / "worker"
    subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "worktree",
            "add",
            "-qb",
            "worker",
            str(worker),
            baseline,
        ],
        check=True,
    )
    for name in ("first.txt", "second.txt"):
        (worker / name).write_text(name)
        subprocess.run(["git", "-C", str(worker), "add", name], check=True)
        subprocess.run(["git", "-C", str(worker), "commit", "-qm", name], check=True)
    tip = subprocess.check_output(
        ["git", "-C", str(worker), "rev-parse", "HEAD"], text=True
    ).strip()
    unrelated = repo / "unrelated.txt"
    unrelated.write_text("keep this user's unrelated work")
    operation_id = str(uuid.uuid4())
    original = JournalStore.complete_operation

    def fail_receipt(
        self: JournalStore,
        identifier: str,
        receipt: dict[str, Any],
        owner: str,
        generation: int,
    ) -> dict[str, Any]:
        if identifier == operation_id:
            raise OSError("injected post-Git receipt failure")
        return original(self, identifier, receipt, owner, generation)

    if lose_receipt:
        monkeypatch.setattr(JournalStore, "complete_operation", fail_receipt)
        with pytest.raises(OSError):
            scoped(
                tool,
                "integrate",
                project,
                commit=tip,
                base=baseline,
                operation_id=operation_id,
            )
        monkeypatch.setattr(JournalStore, "complete_operation", original)
        resumed = tool.dispatch(
            "resume", {"project": project, "_credential": tool.credential_for("resume")}
        )
        assert operation_id in resumed["reconciled"]
        with tool._store(tool.registry.resolve(project)) as store:
            result = store.get_mapping("project", "integration")["payload"]  # type: ignore[index]
    else:
        result = scoped(
            tool,
            "integrate",
            project,
            commit=tip,
            base=baseline,
            operation_id=operation_id,
        )
    integration = Path(result["path"])
    assert (integration / "first.txt").read_text() == "first.txt"
    assert (integration / "second.txt").read_text() == "second.txt"
    assert len(result["source_commits"]) == 2
    retry = scoped(
        tool, "integrate", project, commit=tip, base=baseline, operation_id=operation_id
    )
    assert retry["integration_sha"] == result["integration_sha"]
    assert (
        subprocess.check_output(
            ["git", "-C", str(integration), "rev-list", "--count", "HEAD"], text=True
        ).strip()
        == "3"
    )
    assert unrelated.read_text() == "keep this user's unrelated work"


def test_existing_main_session_link_uses_public_origin_and_encodes_name(
    controller: tuple[ProjectController, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    tool, _repo = controller
    tool.config = replace(tool.config, muxdeck_public_url="https://example.test/mux")
    original = FakeMuxdeck.request

    def renamed(
        self: FakeMuxdeck, method: str, path: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        result = original(self, method, path, payload)
        if path == "/api/sessions":
            result["sessions"][0]["name"] = "main & # room"
        return result

    monkeypatch.setattr(FakeMuxdeck, "request", renamed)
    assert (
        tool._main_identity("main & # room")["terminal_url"]
        == "https://example.test/mux/session/main%20%26%20%23%20room"
    )
