# Connector setup evidence

Source: `48f25d9b32f4ef988f0b8202c672e63956bb963d`, following managed-clone foundation `ff7c0f3`.

`terminal.png` shows a browser-rendered transcript of actual local command stdout: the built standalone connector's help, status of an uninstalled isolated service profile, and three actual terminal-permission/ACP protocol checks. `transcript.json` contains the captured command results, timestamp and source revision. This is recorded console output, not a screenshot of a service running on an operating-system desktop. The screenshot was visually reviewed against the transcript before publication.

The focused connector suite passed 29 cases across five files, including actual Git clones of two local fixture repositories, dirty-checkout preservation, authorization/revocation, installed-agent argv through spawned ACP fixture processes, service configuration secrecy, a spawned standalone service bootstrap contacting a local HTTP fixture, and terminal permission/session/question behavior. Eleven account/catalogue cases also passed on actual PostgreSQL 17, including the standalone connector with two repositories. Full Studio TypeScript and owned-file lint checks passed.

Linux user-unit syntax was checked with actual `systemd-analyze verify`; macOS plist syntax was parsed with Python `plistlib`. Installation/status/uninstallation manager calls use a recording fixture. No host service was installed, no live Copilot/Atomic account was invoked, and these checks do not establish hosted GitHub authorization or a live macOS service session. Windows service installation fails visibly and retains foreground operation. T3 uses its existing documented thread/MCP adapter, not an ACP preset.

SHA-256:

- `terminal.png`: `ac971cc8afb531bc4491dd3e49e9d4df9c7e4a1e0cb185653e6bd2c095dafe57`
- `transcript.json`: `7b51b535f7c3be80c5154cbe07a56a8290d925e5b2e11b2f525e3c3af871d237`
