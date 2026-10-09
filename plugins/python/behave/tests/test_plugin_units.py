"""Unit tests for the matcher, the client and the describe helper."""

from __future__ import annotations

import json

import pytest

from ai_bdd_behave import DaemonClient, DaemonError, describe, install, installed
from ai_bdd_behave.matcher import AiBddMatcher, CATCH_ALL, register_matcher


class TestMatcher:
    def test_matches_everything_and_captures_the_text(self) -> None:
        matcher = AiBddMatcher(None, "{text}")
        arguments = matcher.check_match("Open billing settings")
        assert arguments is not None
        assert [(argument.name, argument.value) for argument in arguments] == [
            ("text", "Open billing settings")
        ]

    def test_compiles_and_captures_the_empty_text(self) -> None:
        matcher = AiBddMatcher(None, "{text}")
        assert matcher.compile() is matcher
        assert CATCH_ALL.match("").group("text") == ""

    def test_registers_with_behave(self) -> None:
        assert register_matcher() is True
        from behave import matchers

        assert "ai_bdd" in matchers.get_step_matcher_factory().step_matcher_class_mapping

    def test_registration_is_idempotent(self) -> None:
        assert register_matcher() is True
        assert register_matcher() is True


class TestDescribe:
    def test_attaches_resolver_metadata_as_a_decorator(self) -> None:
        @describe(
            description="Seeds a workspace",
            examples=["Seed a workspace"],
            counter_examples=["Seed an empty workspace"],
            kind="setup",
        )
        def step_function() -> None:
            return None

        assert step_function.ai_bdd["description"] == "Seeds a workspace"
        assert step_function.ai_bdd["counterExamples"] == ["Seed an empty workspace"]
        assert step_function.ai_bdd["kind"] == "setup"

    def test_attaches_metadata_when_called_directly(self) -> None:
        def step_function() -> None:
            return None

        assert describe(step_function, description="x").ai_bdd["description"] == "x"


class TestClient:
    def test_reports_a_missing_daemon(self, tmp_path) -> None:
        client = DaemonClient(project_root=str(tmp_path))
        assert client.available() is False
        with pytest.raises(DaemonError) as error:
            client.call("health", {})
        assert error.value.code == "DAEMON_UNAUTHORIZED"

    def test_uses_daemon_json(self, tmp_path, scripted_daemon) -> None:
        daemon_dir = tmp_path / ".ai-bdd"
        daemon_dir.mkdir()
        (daemon_dir / "daemon.json").write_text(
            json.dumps({"url": scripted_daemon["url"], "token": scripted_daemon["token"]}), encoding="utf-8"
        )
        client = DaemonClient(project_root=str(tmp_path))
        assert client.available() is True
        health = client.call("health", {})
        assert health["ok"] is True
        assert health["protocol"] == 1

    def test_surfaces_a_typed_error(self, scripted_daemon) -> None:
        client = DaemonClient(url=scripted_daemon["url"], token=scripted_daemon["token"])
        with pytest.raises(DaemonError) as error:
            client.call("resolve_step", {"unexpected": True})
        assert error.value.code == "INVALID_ARGUMENT"

    def test_rejects_a_wrong_token_for_a_stateful_tool(self, scripted_daemon) -> None:
        client = DaemonClient(url=scripted_daemon["url"], token="wrong-token")
        with pytest.raises(DaemonError) as error:
            client.call("open_session", {"scenarioId": "s", "scenarioName": "n", "tags": [], "plugin": {"name": "p", "version": "1", "language": "python"}})
        assert error.value.code == "DAEMON_UNAUTHORIZED"

    def test_rejects_an_unknown_tool(self, scripted_daemon) -> None:
        client = DaemonClient(url=scripted_daemon["url"], token=scripted_daemon["token"])
        with pytest.raises(DaemonError) as error:
            client.call("not_a_tool", {})
        assert error.value.code == "INVALID_ARGUMENT"


class TestInstall:
    def test_install_is_idempotent(self) -> None:
        assert install() is True
        assert install() is True
        assert installed() is True
