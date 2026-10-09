"""The HTTP JSON mirror client, on the standard library only.

Same contract as the Behave plugin's client: discover `.ai-bdd/daemon.json`, POST
`/v1/<tool>`, surface the AiBddError payload as a typed exception.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


class DaemonError(RuntimeError):
    """An AiBddError payload returned by the daemon."""

    def __init__(self, code: str, message: str, retryable: bool = False) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.retryable = retryable


@dataclass
class Connection:
    url: str
    token: str


class DaemonClient:
    def __init__(self, project_root: Optional[str] = None, url: Optional[str] = None, token: Optional[str] = None, timeout: float = 60.0) -> None:
        self.project_root = Path(project_root or os.environ.get("AI_BDD_PROJECT_ROOT", os.getcwd()))
        self._url = url or os.environ.get("AI_BDD_DAEMON_URL")
        self._token = token or os.environ.get("AI_BDD_DAEMON_TOKEN")
        self.timeout = timeout
        self._connection: Optional[Connection] = None

    def connection(self) -> Connection:
        if self._connection is not None:
            return self._connection
        if self._url:
            self._connection = Connection(self._url, self._token or "")
            return self._connection
        path = self.project_root / ".ai-bdd" / "daemon.json"
        if not path.exists():
            raise DaemonError(
                "DAEMON_UNAUTHORIZED",
                f"no daemon is running: {path} does not exist (start one with ai-bdd serve --http)",
            )
        parsed = json.loads(path.read_text(encoding="utf-8"))
        self._connection = Connection(parsed["url"], parsed["token"])
        return self._connection

    def available(self) -> bool:
        if self._url:
            return True
        return (self.project_root / ".ai-bdd" / "daemon.json").exists()

    def call(self, tool: str, body: Optional[dict[str, Any]] = None, traceparent: Optional[str] = None) -> Any:
        connection = self.connection()
        payload = json.dumps(body or {}).encode("utf-8")
        headers = {"content-type": "application/json"}
        if connection.token:
            headers["authorization"] = f"Bearer {connection.token}"
        if traceparent:
            headers["traceparent"] = traceparent
        request = urllib.request.Request(
            f"{connection.url.rstrip('/')}/v1/{tool}", data=payload, headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310 - explicit http(s) url
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body_text = error.read().decode("utf-8")
            try:
                payload_error = json.loads(body_text).get("error", {})
            except json.JSONDecodeError:
                payload_error = {}
            raise DaemonError(
                payload_error.get("code", "INTERNAL"),
                payload_error.get("message", f"HTTP {error.code}"),
                bool(payload_error.get("retryable", False)),
            ) from error
