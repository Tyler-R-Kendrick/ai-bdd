# Evidence and verification

Every run writes a directory:

```
.ai-bdd/runs/<runId>/            runId is a UUIDv7
  artifacts/<sha256>.<ext>       content-addressed artifacts
  manifest.jsonl                 one record per artifact, hash chained
  manifest.json                  { runId, rootHash, count, signature? }
```

## Artifacts

An artifact is written to a temp file, fsynced, and renamed to its content address. Text
content is **redacted before hashing**, so the hash commits to what a reader will see; pixel
content is masked by the driver (password inputs and `[data-ai-bdd-secret]` elements) and the
observation records `maskingProven`.

Kinds: `screenshot`, `observation`, `video`, `judge-request`, `judge-response`, `action-log`,
`check-result`, `act-program`, `check-program`, `log`, `attachment`, `tree`, `dom`.

## The hash chain

```
record.chainHash = H(prevChainHash + canonical(record without chainHash))
```

`prevChainHash` starts at 64 zeros. `manifest.json` holds the final chain hash as `rootHash`,
optionally signed with ed25519 (PKCS8 PEM from `AI_BDD_SIGNING_KEY`).

```bash
ai-bdd verify-evidence .ai-bdd/runs/<runId>
```

re-hashes every artifact, recomputes the chain, verifies the signature when present, and exits
`0` (ok) or `1` with a list of mismatches naming the offending record. It detects: modified
artifact bytes, a deleted record, a reordered record, a swapped artifact, and a modified
`manifest.json`.

## Threat model

State it plainly: this detects **post-hoc modification of a run directory**. It does not prove
that the application was in the recorded state, and it cannot defend against a malicious
runner host that fabricates the whole directory. If you need that, sign on a machine the
runner cannot write to, or reproduce the run on trusted hardware.

## Secrets

Secrets are declared by name and never by value in the spec:

```ts
secrets: { adminPassword: { env: 'ADMIN_PASSWORD' } }
```

```markdown
* Sign in as "admin" with <secret:adminPassword>
```

- the value is filled only by the driver (`typeSecret`), never by the model or the runtime;
- the value, its `encodeURIComponent` form and its base64 form are replaced with
  `<secret:name>` in observations, logs, the lockfile, reports, evidence text and prompts;
- values shorter than 4 characters are rejected at config load (`SECRET_TOO_SHORT`) to avoid
  mass redaction;
- after a secret fill in a session, observations are **tainted**: their pixels are withheld
  from every model (act and judge) unless the driver reports `maskingProven: true` for that
  capture;
- videos recorded across a secret fill are flagged `containsUnmaskedSecrets: true`.

A byte-search test (`scripts/check-secrets.mjs`) asserts that no declared secret value or
encoding appears anywhere under `.ai-bdd/`.

## Reports and evidence by reference

Reports reference evidence by id, relative path, sha256 and media type; they never inline
pixels unless a plugin's attach API requires bytes (`attachInline: true`). That keeps
`report.json`, the JUnit XML, the markdown summary and the Cucumber Messages NDJSON small and
diff-friendly.
