"""Non-destructive integration in a project-owned Git worktree."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from .config import private_read, private_write


class IntegrationError(RuntimeError):
    pass


def git(repo: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *arguments],
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )
    if result.returncode:
        # Git may include configured URL credentials in stderr; retain artifacts separately.
        raise IntegrationError(
            "git " + arguments[0] + " failed; inspect the owned worktree"
        )
    return result.stdout.strip()


def canonical_repository(value: str | Path) -> Path:
    candidate = Path(value).expanduser().resolve(strict=True)
    if not candidate.is_dir():
        raise IntegrationError("repository must be an existing directory")
    root = Path(git(candidate, "rev-parse", "--show-toplevel")).resolve(strict=True)
    return root


class Integrator:
    def __init__(self, repo_root: Path, project_id: str, project_directory: Path):
        self.repo_root, self.project_id = repo_root, project_id
        self.path = project_directory / "worktrees/integration"
        self.branch = "muxpilot/" + project_id + "/integration"
        self.marker = project_directory / "integration-ownership.json"

    def ensure(self, base: str | None = None) -> dict[str, Any]:
        baseline = git(self.repo_root, "rev-parse", (base or "HEAD") + "^{commit}")
        if self.path.exists():
            if not self.marker.exists():
                raise IntegrationError(
                    "integration ownership marker is missing; reconcile before adoption"
                )
            ownership = json.loads(private_read(self.marker))
            actual = git(self.path, "symbolic-ref", "--short", "HEAD")
            common = Path(git(self.path, "rev-parse", "--git-common-dir"))
            if not common.is_absolute():
                common = (self.path / common).resolve()
            expected_common = Path(git(self.repo_root, "rev-parse", "--git-common-dir"))
            if not expected_common.is_absolute():
                expected_common = (self.repo_root / expected_common).resolve()
            if (
                actual != self.branch
                or canonical_repository(self.path) != self.path.resolve()
                or common.resolve() != expected_common.resolve()
                or ownership.get("project_id") != self.project_id
                or ownership.get("repo_root") != str(self.repo_root.resolve())
            ):
                raise IntegrationError(
                    "integration path is not the owned branch/worktree"
                )
            baseline = ownership["base_sha"]
        else:
            # An existing branch is not ownership proof; refuse collisions.
            result = subprocess.run(
                [
                    "git",
                    "-C",
                    str(self.repo_root),
                    "show-ref",
                    "--verify",
                    "--quiet",
                    "refs/heads/" + self.branch,
                ],
                check=False,
            )
            if result.returncode == 0:
                raise IntegrationError(
                    "integration branch exists without owned worktree"
                )
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            git(
                self.repo_root,
                "worktree",
                "add",
                "-b",
                self.branch,
                str(self.path),
                baseline,
            )
            private_write(
                self.marker,
                json.dumps(
                    {
                        "project_id": self.project_id,
                        "repo_root": str(self.repo_root.resolve()),
                        "base_sha": baseline,
                    }
                ),
            )
        return {"path": str(self.path), "branch": self.branch, "base_sha": baseline}

    def integrate(self, commit: str, *, base: str | None = None) -> dict[str, Any]:
        if not re.fullmatch(r"[0-9a-fA-F]{40,64}", commit):
            raise IntegrationError("integration requires a full verified commit SHA")
        info = self.ensure(base)
        if git(self.path, "status", "--porcelain"):
            raise IntegrationError(
                "integration worktree has changes or unresolved conflicts"
            )
        resolved = git(self.repo_root, "rev-parse", commit + "^{commit}")
        if resolved.lower() != commit.lower():
            raise IntegrationError("commit identity does not match")
        before = git(self.path, "rev-parse", "HEAD")
        source_base = base or info["base_sha"]
        commits = self.source_commits(source_base, resolved)
        applied, retained = [], []
        for source in commits:
            # Every source commit has an independent durable Git receipt. A lost
            # journal receipt cannot duplicate already applied range members.
            if self.includes(source, git(self.path, "rev-parse", "HEAD")):
                retained.append(source)
                continue
            try:
                git(self.path, "cherry-pick", "--allow-empty", "-x", source)
                applied.append(source)
            except IntegrationError:
                conflicts = git(self.path, "diff", "--name-only", "--diff-filter=U")
                if not conflicts:
                    raise IntegrationError(
                        "integration failed without merge conflicts; inspect before retry"
                    )
                return {
                    **info,
                    "status": "conflict",
                    "commit": resolved,
                    "source_base_sha": source_base,
                    "source_commits": commits,
                    "applied_commits": applied,
                    "failed_commit": source,
                    "before_sha": before,
                    "conflict_files": conflicts,
                    "requires_resolution": True,
                }
        return {
            **info,
            "status": "integrated",
            "commit": resolved,
            "before_sha": before,
            "integration_sha": git(self.path, "rev-parse", "HEAD"),
            "source_base_sha": source_base,
            "source_commits": commits,
            "applied_commits": applied,
            "retained_commits": retained,
            "reconciled": not applied,
        }

    def source_commits(self, base: str, commit: str) -> list[str]:
        ancestor = subprocess.run(
            [
                "git",
                "-C",
                str(self.repo_root),
                "merge-base",
                "--is-ancestor",
                base,
                commit,
            ],
            capture_output=True,
            check=False,
            timeout=10,
        )
        if ancestor.returncode:
            raise IntegrationError("worker handoff base is not an ancestor of its tip")
        commits = git(
            self.repo_root,
            "rev-list",
            "--reverse",
            "--topo-order",
            base + ".." + commit,
        ).splitlines()
        if any(
            len(git(self.repo_root, "rev-list", "--parents", "-n", "1", source).split())
            > 2
            for source in commits
        ):
            raise IntegrationError(
                "merge-commit handoff requires explicit integration resolution"
            )
        return commits

    def includes_range(self, base: str, commit: str, revision: str) -> bool:
        return self.includes(base, revision) and all(
            self.includes(source, revision)
            for source in self.source_commits(base, commit)
        )

    def observe(
        self, commit: str, base: str, before_sha: str | None = None
    ) -> dict[str, Any] | None:
        """Look up a complete known range after a crash, without Git mutations."""
        if not self.path.exists() or not self.marker.exists():
            return None
        info = self.ensure(base)
        if git(self.path, "status", "--porcelain"):
            return None
        revision = git(self.path, "rev-parse", "HEAD")
        commits = self.source_commits(base, commit)
        if not self.includes_range(base, commit, revision):
            return None
        return {
            **info,
            "status": "integrated",
            "commit": commit,
            "source_base_sha": base,
            "source_commits": commits,
            "before_sha": before_sha or info["base_sha"],
            "integration_sha": revision,
            "applied_commits": [],
            "retained_commits": commits,
            "reconciled": True,
        }

    def verify_revision(self, revision: str) -> None:
        if git(self.path, "status", "--porcelain"):
            raise IntegrationError(
                "goal verification requires a clean integration worktree"
            )
        if git(self.path, "rev-parse", "HEAD") != revision:
            raise IntegrationError(
                "verification evidence does not match integration HEAD"
            )

    def includes(self, commit: str, revision: str) -> bool:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(self.path),
                "merge-base",
                "--is-ancestor",
                commit,
                revision,
            ],
            capture_output=True,
            check=False,
            timeout=10,
        )
        if result.returncode == 0:
            return True
        return "(cherry picked from commit " + commit + ")" in git(
            self.path, "log", "--format=%B", revision
        )
