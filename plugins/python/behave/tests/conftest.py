"""Shared fixtures: a scripted ai-bdd daemon and a behave workspace."""

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
SRC = Path(__file__).resolve().parents[1] / "src"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

sys.path.insert(0, str(SRC))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="session")
def scripted_daemon(tmp_path_factory):
    """Runs ``ai-bdd serve --fake-script`` for the whole test session."""
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
    assert payload["url"] == f"http://127.0.0.1:{port}"
    yield {"url": payload["url"], "token": payload["token"], "project": project}
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:  # pragma: no cover
        process.kill()


@pytest.fixture()
def behave_workspace(tmp_path: Path, scripted_daemon) -> Path:
    return make_workspace(tmp_path, scripted_daemon)


def make_workspace(root: Path, daemon: dict) -> Path:
    """A minimal behave project whose steps install the plugin."""
    features = root / "features"
    steps = features / "steps"
    steps.mkdir(parents=True, exist_ok=True)
    (features / "environment.py").write_text(
        "from ai_bdd_behave import after_scenario, before_scenario\n",
        encoding="utf-8",
    )
    shutil.copyfile(FIXTURES / "user_steps.py", steps / "a_user_steps.py")
    (steps / "zz_ai_bdd.py").write_text(
        "\n".join(
            [
                "import os",
                "import sys",
                f"sys.path.insert(0, {str(SRC)!r})",
                "from ai_bdd_behave import install",
                "install()",
                "",
            ]
        ),
        encoding="utf-8",
    )
    env = root / ".env"
    env.write_text(
        f"AI_BDD_DAEMON_URL={daemon['url']}\nAI_BDD_DAEMON_TOKEN={daemon['token']}\n", encoding="utf-8"
    )
    return root


def copy_feature(name: str, destination: Path) -> Path:
    source = KIT / "features" / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    return destination


def run_behave(workspace: Path, feature: Path, daemon: dict) -> list[dict]:
    """Runs behave with the JSON formatter and returns the parsed report."""
    environment = dict(os.environ)
    environment["AI_BDD_DAEMON_URL"] = daemon["url"]
    environment["AI_BDD_DAEMON_TOKEN"] = daemon["token"]
    environment["PYTHONPATH"] = str(SRC)
    output = workspace / "report.json"
    process = subprocess.run(  # noqa: S603 - fixed argv
        [
            sys.executable,
            "-m",
            "behave",
            str(feature),
            "-f",
            "json.pretty",
            "-o",
            str(output),
            "--no-summary",
            "--no-snippets",
        ],
        cwd=workspace,
        env=environment,
        capture_output=True,
        text=True,
        timeout=180,
    )
    if not output.exists():
        raise AssertionError(f"behave produced no report: {process.stdout}\n{process.stderr}")
    report = json.loads(output.read_text(encoding="utf-8"))
    if os.environ.get("AI_BDD_DEBUG_BEHAVE") == "1":
        print("--- behave stdout ---")
        print(process.stdout)
        print(process.stderr)
    return report
