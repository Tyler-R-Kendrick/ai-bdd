# Security policy

This file is how to report a vulnerability in the ai-bdd repository. What the software trusts when it runs (documents, pages, plans, secrets) is the product threat model in [docs/security.md](docs/security.md).

## Supported versions

Security fixes apply to the latest release on `main` and to recent release tags. Older branches may not receive patches.

There is no long-term support branch. If you are on an older tag or a feature branch, move to `main` or to a recent release tag to pick up fixes.

## Reporting a vulnerability

Report vulnerabilities through GitHub **Report a vulnerability** (Security Advisories / private reporting):

[https://github.com/Tyler-R-Kendrick/ai-bdd/security/advisories/new](https://github.com/Tyler-R-Kendrick/ai-bdd/security/advisories/new)

This project has no security email. Use the private reporting form above.

Include what you can:

- The commit, tag, or package version you tested.
- What the issue is and what an attacker could do with it.
- A minimal way to reproduce it, if you have one.
- Whether the issue is already public.

The maintainer will acknowledge a report within **3 business days**. A fix, when there is one, lands on `main` and is included in subsequent release tags. A public advisory is published when the report is confirmed and a fix or mitigation is ready. Please wait for that before discussing the details in a public issue, pull request, or chat.

Repository maintainers must enable private vulnerability reporting if it is not already on. In the repository settings, open **Code security** (some layouts call this **Code security and analysis** or **Advanced Security**) and turn on **Private vulnerability reporting**. Until that setting is enabled, the Report a vulnerability button is hidden and the link above does not accept reports.
