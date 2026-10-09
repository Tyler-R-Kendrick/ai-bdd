"""Plugin conformance: pytest-bdd against the scripted daemon, compared to the kit."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import ALIASES, KIT, make_workspace, run_pytest

EXPECTED = sorted((KIT / "expected").glob("*.json"))


def statuses_of(report: list[dict]) -> list[str]:
    statuses: list[str] = []
    for feature in report:
        for element in feature.get("elements", []):
            for step in element.get("steps", []):
                statuses.append(step.get("result", {}).get("status", "undefined"))
    return statuses


@pytest.mark.parametrize("expected_file", EXPECTED, ids=[path.stem for path in EXPECTED])
def test_kit_case(expected_file: Path, tmp_path: Path, scripted_daemon) -> None:
    expected = json.loads(expected_file.read_text(encoding="utf-8"))
    workspace = make_workspace(tmp_path, scripted_daemon, KIT / "features" / expected["feature"])
    report, stdout = run_pytest(workspace, scripted_daemon)
    statuses = statuses_of(report)
    assert len(statuses) == len(expected["steps"]), f"expected {len(expected['steps'])} steps, got {statuses}: {stdout}"
    for index, step in enumerate(expected["steps"]):
        wanted, got = step["status"], statuses[index]
        assert wanted == got or got in ALIASES.get(wanted, []), (
            f"{expected['feature']} step {index}: expected {wanted}, pytest-bdd reported {got}"
        )
