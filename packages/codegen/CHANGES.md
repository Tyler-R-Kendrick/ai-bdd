# Changelog

## 0.1.0

- `generate()`, `generateCucumberJs()`, `generatePlaywright()` with `style: 'delegate' | 'inline'`.
- Delegate output: one thin binding per recorded step, with the source cache key in a comment.
- Inline output: recorded Playwright actions, using the per-scenario `world.page`.
- `--framework e2e` routes to `ai-bdd e2e-host generate`, which emits the file e2e's runner collects.
- Evidence index records the style, act/check keys and the judge-only assertions.
