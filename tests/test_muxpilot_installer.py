"""Install into disposable roots; never modify the user's skills or services."""
from __future__ import annotations

import importlib.util
import json
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

REPOSITORY = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("muxpilot_installer", REPOSITORY / "scripts/install_muxpilot.py")
assert SPEC is not None and SPEC.loader is not None
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


@pytest.fixture
def arguments(tmp_path: Path) -> list[str]:
    return [
        "--repo", str(REPOSITORY), "--python", sys.executable,
        "--bin-dir", str(tmp_path / "bin"),
        "--skills-dir", str(tmp_path / "skills"),
        "--legacy-skills-dir", str(tmp_path / "legacy"),
        "--config", str(tmp_path / "config/config.json"),
        "--state-root", str(tmp_path / "state"),
    ]


def install(arguments: list[str], *extra: str) -> dict[str, Any]:
    return installer.install(installer.parser().parse_args([*arguments, *extra]))


def test_dry_run_does_not_create_files(arguments: list[str], tmp_path: Path) -> None:
    result = install(arguments, "--dry-run")
    assert result["dry_run"]
    assert list(tmp_path.iterdir()) == []


def test_private_idempotent_install_and_legacy_discovery(arguments: list[str], tmp_path: Path) -> None:
    first = install(arguments)
    assert first["services_started"] is False
    assert first["provider_runs_started"] is False
    for path in first["changed"]:
        expected = 0o700 if path.endswith(("/bin/muxpilot", "/bin/muxpilot-worker")) else 0o600
        assert stat.S_IMODE(Path(path).stat().st_mode) == expected
    for path in (tmp_path / "state", tmp_path / "config", tmp_path / "skills/muxpilot"):
        assert stat.S_IMODE(path.stat().st_mode) == 0o700
    second = install(arguments)
    assert second["changed"] == []
    skill = (tmp_path / "skills/muxpilot/SKILL.md").read_text()
    assert str(tmp_path / "bin/muxpilot") in skill
    assert skill == (tmp_path / "legacy/muxpilot/SKILL.md").read_text()
    assert "](AGENT_DEPLOYMENT_GUIDE.md)" in (tmp_path / "skills/muxpilot/references/OPERATIONS.md").read_text()


def test_unmanaged_command_collision_prevents_partial_install(arguments: list[str], tmp_path: Path) -> None:
    (tmp_path / "bin").mkdir(mode=0o700)
    collision = tmp_path / "bin/muxpilot"
    collision.write_text("keep this unrelated command")
    collision.chmod(0o700)
    with pytest.raises(installer.InstallationError, match="unmanaged or edited"):
        install(arguments, "--replace")
    assert collision.read_text() == "keep this unrelated command"
    assert not (tmp_path / "config").exists()


def test_user_edited_skill_is_preserved_during_upgrade(arguments: list[str], tmp_path: Path) -> None:
    install(arguments)
    skill = tmp_path / "skills/muxpilot/SKILL.md"
    skill.write_text(skill.read_text() + "\nUser customization\n")
    with pytest.raises(installer.InstallationError, match="unmanaged or edited"):
        install(arguments, "--replace")
    assert "User customization" in skill.read_text()


def test_symlink_target_cannot_replace_unrelated_file(arguments: list[str], tmp_path: Path) -> None:
    (tmp_path / "bin").mkdir(mode=0o700)
    other = tmp_path / "untouched"
    other.write_text("unrelated")
    (tmp_path / "bin/muxpilot").symlink_to(other)
    with pytest.raises(OSError):
        install(arguments, "--replace")
    assert other.read_text() == "unrelated"


def test_credential_metadata_and_generated_secret_absence(arguments: list[str], tmp_path: Path) -> None:
    token = tmp_path / "credential"
    token.write_text("secret-sentinel-value")
    token.chmod(0o644)
    with pytest.raises(installer.InstallationError, match="private regular file"):
        install(arguments, "--muxdeck-token-file", str(token))
    token.chmod(0o600)
    result = install(arguments, "--muxdeck-token-file", str(token))
    generated = [path for path in tmp_path.rglob("*") if path.is_file() and path != token]
    assert "secret-sentinel-value" not in json.dumps(result)
    assert all("secret-sentinel-value" not in path.read_text() for path in generated)


def test_reuse_config_keeps_manual_settings(arguments: list[str], tmp_path: Path) -> None:
    install(arguments)
    config = tmp_path / "config/config.json"
    values = json.loads(config.read_text())
    values["worker_limit"] = 5
    config.write_text(json.dumps(values))
    before = config.read_bytes()
    install(arguments, "--replace", "--reuse-config")
    assert config.read_bytes() == before


def test_upgrade_changes_only_installer_managed_files(arguments: list[str], tmp_path: Path) -> None:
    install(arguments)
    install(arguments, "--replace", "--main-model", "another-explicit-model")
    assert "another-explicit-model" in (tmp_path / "skills/muxpilot/SKILL.md").read_text()


def test_wrapper_preserves_literal_paths_and_original_arguments(arguments: list[str], tmp_path: Path) -> None:
    # This executable validates argv without importing projectd or running a provider.
    fake = tmp_path / "fake python"
    fake.write_text(
        "#!" + sys.executable + "\nimport sys,json\n"
        'if sys.argv[1] == "-c": sys.exit(0)\nprint(json.dumps(sys.argv[1:]))\n'
    )
    fake.chmod(0o700)
    config = tmp_path / "config $(touch SHOULD_NOT_EXIST) `echo bad`/config.json"
    arguments[arguments.index("--python") + 1] = str(fake)
    arguments[arguments.index("--config") + 1] = str(config)
    install(arguments)
    supplied = ["literal $HOME `touch bad`", "two words", "line1\nline2"]
    result = subprocess.run(
        [str(tmp_path / "bin/muxpilot"), *supplied], cwd=tmp_path,
        capture_output=True, text=True, check=True,
    )
    assert json.loads(result.stdout) == ["-m", "muxpilot", "--config", str(config), *supplied]
    assert not (tmp_path / "SHOULD_NOT_EXIST").exists()


def test_existing_insecure_state_directory_is_refused(arguments: list[str], tmp_path: Path) -> None:
    (tmp_path / "state").mkdir(mode=0o700)
    (tmp_path / "state").chmod(0o755)
    with pytest.raises(installer.InstallationError, match="private directory"):
        install(arguments)


def test_unknown_reused_configuration_is_refused(arguments: list[str], tmp_path: Path) -> None:
    install(arguments)
    (tmp_path / "config/config.json").write_text('{"unknown": true}')
    with pytest.raises(installer.InstallationError, match="unsupported fields"):
        install(arguments, "--reuse-config")


def test_final_runtime_and_link_configuration_matches_service_schema(arguments: list[str], tmp_path: Path) -> None:
    from muxpilot.config import Config

    qualification = tmp_path / "synthetic-unqualified-record.json"
    qualification.write_text('{"protocol":"muxpilot-v1","passed":false}')
    qualification.chmod(0o600)
    result = install(
        arguments, "--runtime-profile-id", "profile-id", "--daemon-id", "daemon-id",
        "--multica-ui-url", "https://board.example.test/multica/",
        "--multica-workspace-slug", "shop-team",
        "--muxdeck-public-url", "https://console.example.test/mux",
        "--qualification-file", str(qualification),
    )
    config = Config.load(tmp_path / "config/config.json")
    assert config.runtime_profile_id == "profile-id"
    assert config.daemon_id == "daemon-id"
    assert config.multica_ui_url == "https://board.example.test/multica"
    assert config.multica_workspace_slug == "shop-team"
    assert config.muxdeck_public_url == "https://console.example.test/mux"
    assert config.qualification_file == qualification
    assert result["receiver_environment_required"] == {"MUXPILOT_STATE_ROOT": str(tmp_path / "state")}
    assert result["provider_qualification_record_configured"] is True
    assert "provider_qualified" not in result
    # A configuration-preserving upgrade accepts the same current schema.
    before = (tmp_path / "config/config.json").read_bytes()
    install(arguments, "--reuse-config", "--replace")
    assert (tmp_path / "config/config.json").read_bytes() == before


def test_exact_managed_dependency_commands_are_installed_without_running_them(arguments: list[str], tmp_path: Path) -> None:
    result = install(
        arguments, "--multica-api-service", "muxpilot-multica-api.service",
        "--multica-daemon-service", "muxpilot-multica-daemon.service",
        "--service-manager", "user",
    )
    assert result["managed_service_commands"]["api"]["start"] == "systemctl --user start muxpilot-multica-api.service"
    assert result["services_started"] is False
    skill = (tmp_path / "skills/muxpilot/SKILL.md").read_text()
    assert "systemctl --user is-active --quiet muxpilot-multica-api.service" in skill
    assert "systemctl --user start muxpilot-multica-daemon.service" in skill
    assert "systemctl restart" not in skill
    upgraded = install(arguments, "--reuse-config", "--replace")
    assert upgraded["managed_service_commands"] == result["managed_service_commands"]


@pytest.mark.parametrize("unit", ["tmux.service", "multica.service;touch bad", "../multica.service"])
def test_managed_service_names_reject_tmux_and_shell_or_path_injection(arguments: list[str], unit: str) -> None:
    with pytest.raises(SystemExit):
        installer.parser().parse_args([*arguments, "--multica-api-service", unit])


def test_copilot_install_uses_copilot_discovery_and_worker_launcher(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from muxpilot.config import Config

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    provider = tmp_path / "copilot"
    provider.write_text("#!/bin/sh\nexit 0\n")
    provider.chmod(0o700)
    arguments = [
        "--repo", str(REPOSITORY), "--python", sys.executable,
        "--bin-dir", str(tmp_path / "bin"),
        "--config", str(tmp_path / "config/config.json"),
        "--state-root", str(tmp_path / "state"),
        "--provider", "copilot", "--main-model", "claude-opus-5.5",
        "--main-executable", str(provider), "--main-arg=--yolo",
    ]
    result = install(arguments)
    skill = home / ".copilot/skills/muxpilot/SKILL.md"
    assert result["skills"] == [str(skill)]
    assert not (home / ".agents").exists()
    assert "copilot skill list" in result["skill_loading"]
    assert (result["provider"], result["worker_provider"], result["main_model"]) == ("copilot", "copilot", "claude-opus-5.5")
    text = skill.read_text()
    assert "Main provider: `copilot`" in text and str(tmp_path / "bin/muxpilot-worker") in text
    config = Config.load(tmp_path / "config/config.json")
    assert (config.main_provider, config.worker_provider, config.main_model) == ("copilot", "copilot", "claude-opus-5.5")
    assert config.main_executable == str(provider) and config.main_args == ("--yolo",)
    worker = (tmp_path / "bin/muxpilot-worker").read_text()
    assert "-m muxpilot.worker --config" in worker
    assert stat.S_IMODE((tmp_path / "bin/muxpilot-worker").stat().st_mode) == 0o700
    # A configuration-preserving upgrade keeps the Copilot discovery root.
    arguments = [argument for argument in arguments if argument not in {"--provider", "copilot"}]
    assert install(arguments, "--reuse-config", "--replace")["skills"] == [str(skill)]


def test_copilot_launcher_options_are_validated(arguments: list[str], tmp_path: Path) -> None:
    with pytest.raises(installer.InstallationError, match="existing executable"):
        install(arguments, "--provider", "copilot", "--main-executable", str(tmp_path / "missing"))
    with pytest.raises(installer.InstallationError, match="nonempty literals"):
        install(arguments, "--provider", "copilot", "--main-arg=")
