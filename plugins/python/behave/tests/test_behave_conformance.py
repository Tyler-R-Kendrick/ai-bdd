"""Plugin conformance: behave against the scripted daemon, compared to the kit."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import KIT, copy_feature, make_workspace, run_behave

ALIASES = json.loads((KIT / "status-aliases.json").read_text(encoding="utf-8"))

EXPECTED = sorted((KIT / "expected").glob("*.json"))


@pytest.mark.parametrize("expected_file", EXPECTED, ids=[path.stem for path in EXPECTED])
def test_kit_case(expected_file: Path, tmp_path: Path, scripted_daemon) -> None:
    expected = json.loads(expected_file.read_text(encoding="utf-8"))
    workspace = make_workspace(tmp_path, scripted_daemon)
    feature = copy_feature(expected["feature"], workspace / "features" / expected["feature"])
    report = run_behave(workspace, feature, scripted_daemon)

    # behave's JSON formatter puts the status under `result`, not on the step.
    statuses: list[str] = []
    messages: list[str] = []
    for entry in report:
        for element in entry.get("elements", []):
            for step in element.get("steps", []):
                result = step.get("result", {})
                statuses.append(result.get("status", "undefined"))
                messages.append(str(result.get("error_message", "")))

    def matches(want: str, got: str) -> bool:
        return want == got or got in ALIASES.get(want, [])

    for index, step in enumerate(expected["steps"]):
        assert matches(step["status"], statuses[index]), (
            f"{expected['feature']} step {index}: expected {step['status']}, behave reported "
            f"{statuses[index]} (messages: {messages})"
        )
    for index, step in enumerate(expected["steps"]):
        if "errorCode" in step:
            assert step["errorCode"] in messages[index], (
                f"{expected['feature']}: step {index} should mention {step['errorCode']}, got {messages[index]}"
            )
