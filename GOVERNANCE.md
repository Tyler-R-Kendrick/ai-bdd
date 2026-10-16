# Governance

ai-bdd is a single-maintainer project. There is no foundation, no company board, and no steering committee.

## Maintainer

**Tyler Kendrick** ([@Tyler-R-Kendrick](https://github.com/Tyler-R-Kendrick)) is the benevolent dictator for life (BDFL) and the only person with commit rights.

## How decisions are made

The maintainer decides what lands on `main`: design, public API, defaults, and which pull requests merge. Issues and pull requests are the place to make a technical argument. Agreement is welcome. It is not required for a decision.

A decision that changes contributor-facing rules (this file, [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md)) is made in a pull request so the history stays public.

## Becoming a committer or maintainer

Commit access is earned by the quality of contributions already in the tree, and it is granted only by invitation from the maintainer. Opening issues or pull requests does not by itself add a committer. There is no nomination committee and no automatic promotion after a number of pull requests.

## Disputes

Discuss the disagreement on the issue or pull request. Keep the thread about the change. If the discussion does not settle it, the maintainer makes the final call and writes the reason on that thread.

Conduct complaints are handled under [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), not as a design vote.

## Releases

Releases are git tags cut from `main`. The maintainer decides when to tag and what the tag names. There is no release committee.

Tags are the release. Publishing packages to npm is a separate step and is not part of tagging today. The packages are not published to npm yet; see the README.

## Continuity

If the maintainer steps down, they appoint a successor and say so in this file. If they cannot appoint anyone, the project has no official successor. The license is MIT, so anyone may fork the repository and continue the work. A fork is a community fork. It is an official continuation only when the maintainer has named it as one.
