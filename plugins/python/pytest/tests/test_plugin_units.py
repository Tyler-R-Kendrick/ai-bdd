"""Unit tests for the pytest-bdd plugin: parser, client, describe and specificity."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from ai_bdd_pytest import AiBddParser, DaemonClient, DaemonError, describe
from ai_bdd_pytest import plugin as plugin_module

from conftest import KIT, make_workspace


class TestParser:
    def test_matches_everything_and_passes_the_text_through(self) -> None:
        parser = AiBddParser("ai_bdd")
        assert parser.is_matching("anything at all") is True
        assert parser.parse_arguments("Open billing settings") == {"text": "Open billing settings"}

    def test_names_itself_for_the_catch_all(self) -> None:
        assert AiBddParser("ai_bdd").name == "ai_bdd"


class TestDescribe:
    def test_attaches_metadata_as_a_decorator(self) -> None:
        @describe(description="Seeds a workspace", examples=["x"], kind="setup")
        def step():
            return None

        assert step.ai_bdd["description"] == "Seeds a workspace"
        assert step.ai_bdd["kind"] == "setup"

    def test_attaches_metadata_when_called_directly(self) -> None:
        def step():
            return None

        assert describe(step, description="y").ai_bdd["description"] == "y"


class TestClient:
    def test_reports_a_missing_daemon(self, tmp_path: Path) -> None:
        client = DaemonClient(project_root=str(tmp_path))
        assert client.available() is False
        with pytest.raises(DaemonError) as error:
            client.call("health", {})
        assert error.value.code == "DAEMON_UNAUTHORIZED"

    def test_uses_daemon_json(self, tmp_path: Path, scripted_daemon: dict) -> None:
        daemon_dir = tmp_path / ".ai-bdd"
        daemon_dir.mkdir()
        (daemon_dir / "daemon.json").write_text(
            json.dumps({"url": scripted_daemon["url"], "token": scripted_daemon["token"]}), encoding="utf-8"
        )
        client = DaemonClient(project_root=str(tmp_path))
        assert client.available() is True
        assert client.call("health", {})["protocol"] == 1

    def test_surfaces_a_typed_error(self, scripted_daemon: dict) -> None:
        client = DaemonClient(url=scripted_daemon["url"], token=scripted_daemon["token"])
        with pytest.raises(DaemonError) as error:
            client.call("resolve_step", {"unexpected": True})
        assert error.value.code == "INVALID_ARGUMENT"

    def test_rejects_a_wrong_token(self, scripted_daemon: dict) -> None:
        client = DaemonClient(url=scripted_daemon["url"], token="wrong")
        with pytest.raises(DaemonError) as error:
            client.call(
                "open_session",
                {"scenarioId": "s", "scenarioName": "n", "tags": [], "plugin": {"name": "p", "version": "1", "language": "python"}},
            )
        assert error.value.code == "DAEMON_UNAUTHORIZED"


class TestCoexistence:
    """A step defined by the project must win over the plugin's catch-all."""

    def test_user_step_wins_over_the_catch_all(self, tmp_path: Path, scripted_daemon: dict) -> None:
        feature = tmp_path / "features" / "exact-setup.feature"
        workspace = make_workspace(tmp_path, scripted_daemon, KIT / "features" / "exact-setup.feature")
        assert feature.exists()
        # A marker file proves the user function ran, and the daemon was not asked
        # to run the step: the user step is more specific than the catch-all.
        marker = workspace / "user-step-ran.txt"
        (workspace / "conftest.py").write_text(
            (workspace / "conftest.py").read_text(encoding="utf-8") + (
                "\n\n@given(parsers.parse('Seed a workspace \"{name}\" on the \"{plan}\" plan'))\n"
                f"def marking_seed(name, plan):\n    open({str(marker)!r}, 'w').write(name)\n"
            ),
            encoding="utf-8",
        )
        environment = {
            "AI_BDD_DAEMON_URL": scripted_daemon["url"],
            "AI_BDD_DAEMON_TOKEN": scripted_daemon["token"],
            "PATH": __import__("os").environ.get("PATH", ""),
        }
        subprocess.run(  # noqa: S603 - fixed argv
            [sys.executable, "-m", "pytest", str(workspace / "test_cases.py"), "-q", "-p", "no:cacheprovider"],
            cwd=workspace,
            env=environment,
            capture_output=True,
            text=True,
            timeout=120,
        )
        assert marker.exists(), "the project's own step definition did not run"

    def test_plugin_registers_four_catch_all_keywords(self) -> None:
        fixtures = [name for name in vars(plugin_module) if name.startswith("pytestbdd_stepdef_")]
        assert "pytestbdd_stepdef_given_ai_bdd" in fixtures
        assert "pytestbdd_stepdef_when_ai_bdd" in fixtures
        assert "pytestbdd_stepdef_then_ai_bdd" in fixtures
        assert "pytestbdd_stepdef_*_ai_bdd" in fixtures
