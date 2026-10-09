# Build notes for agents working in this sandbox

Read `docs/INTERFACES.md` first. It fixes the public API of every package.
The normative product specification is the implementation prompt that created this repo;
the relevant sections are summarized per work package in your task brief.

## Environment

- Node `v24.21.0`, pnpm `12.10.1` (workspace root `/workspace`).
- The registry is behind a TLS-intercepting proxy. The proxy CA is already configured:
  `~/.npmrc` contains `cafile=/workspace/.certs/ca-bundle.crt`. If a `pnpm` command ever
  fails with `UnknownIssuer`, re-run it as
  `SSL_CERT_FILE=/workspace/.certs/ca-bundle.crt pnpm ...`.
- `pnpm install` is already done. Only run it again after adding a dependency to a
  package's `package.json` (allowed; the registry is reachable).
- Node type stripping is on, so `node script.ts` works for small scripts.

## Commands

```bash
npx tsc -b packages/<pkg>          # build/typecheck one package and its deps
pnpm -F @ai-bdd/<pkg> test         # vitest for one package
pnpm -F @ai-bdd/<pkg> lint         # oxlint
cd packages/<pkg> && npx tsc -b    # equivalent to the first command
```

`tsc -b tsconfig.build.json` (repo root) only succeeds once every referenced package
exists, so create your package skeleton (package.json, tsconfig.json, vitest.config.ts,
`src/index.ts`) **first**, even if the implementation comes after.

## Rules

- Never edit `packages/contracts/**`. If you need a contract change, write
  `contracts-proposals/<your-agent-id>.md` and code against the current contract with an
  adapter.
- Never edit `tsconfig.build.json`, `vitest.alias.ts`, `vitest.config.ts`, `package.json`
  at the root, `pnpm-workspace.yaml`, or another swarm's package. Root files are owned by
  the foundations agent.
- Do not run `git` commands; the orchestrator commits.
- `exactOptionalPropertyTypes: true`, `module: NodeNext` (relative imports need `.js`),
  `verbatimModuleSyntax` (use `import type` for types).
- Deterministic behaviour only: no wall-clock or random values in golden outputs. Where a
  timestamp is part of a schema, make it injectable.
- Tests must not require network access or model API keys.
