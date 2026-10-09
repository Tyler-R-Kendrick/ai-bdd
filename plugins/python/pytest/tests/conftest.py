"""Fixtures for the pytest-bdd plugin conformance run."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[4]
KIT = REPO / "packages" / "conformance" / "plugin"
CLI = REPO / "packages" / "cli" / "dist" / "bin.js"
FIXTURES = Path(__file__).resolve().parent / "kit"
SRC = Path(__file__).resolve().parents[1] / "src"

sys.path.insert(0, str(SRC))

ALIASES = json.loads((KIT / "status-aliases.json").read_text(encoding="utf-8"))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="session")
def scripted_daemon(tmp_path_factory):
    project = tmp_path_factory.mktemp("ai-bdd-daemon")
    port = free_port()
    process = subprocess.Popen(  # noqa: S603 - fixed argv
        ["node", str(CLI), "serve", "--fake-script", "--port", str(port)],
        cwd=project,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    daemon_file = project / ".ai-bdd" / "daemon.json"
    for _ in range(100):
        if daemon_file.exists():
            break
        if process.poll() is not None:
            raise RuntimeError(f"the scripted daemon exited early: {process.stdout.read()}")
        time.sleep(0.1)
    payload = json.loads(daemon_file.read_text(encoding="utf-8"))
    yield {"url": payload["url"], "token": payload["token"], "project": project}
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:  # pragma: no cover
        process.kill()


def make_workspace(root: Path, daemon: dict, feature: Path) -> Path:
    """A minimal pytest-bdd project: one conftest with the user steps and one test module."""
    features = root / "features"
    features.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(feature, features / feature.name)
    shutil.copyfile(FIXTURES / "user_steps.py", root / "conftest.py")
    (root / "test_cases.py").write_text(
        "from pytest_bdd import scenarios\n\nscenarios('features')\n",
        encoding="utf-8",
    )
    return root


def run_pytest(workspace: Path, daemon: dict) -> tuple[list[dict], str]:
    environment = dict(os.environ)
    environment["AI_BDD_DAEMON_URL"] = daemon["url"]
    environment["AI_BDD_DAEMON_TOKEN"] = daemon["token"]
    environment["PYTHONPATH"] = str(SRC)
    output = workspace / "cucumber.json"
    process = subprocess.run(  # noqa: S603 - fixed argv
        [
            sys.executable,
            "-m",
            "pytest",
            str(workspace / "test_cases.py"),
            "-q",
            "-p",
            "no:cacheprovider",
            f"--cucumberjson={output}",
        ],
        cwd=workspace,
        env=environment,
        capture_output=True,
        text=True,
        timeout=180,
    )
    if not output.exists():
        raise AssertionError(f"pytest produced no cucumber json: {process.stdout}\n{process.stderr}")
    return json.loads(output.read_text(encoding="utf-8")), process.stdout
