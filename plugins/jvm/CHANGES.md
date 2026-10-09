# Changelog

## 0.1.0

- `BackendProviderService` + `Backend` for Cucumber-JVM 8.x (and the 7.x `loadGlue` overload).
- `@AiBddStep` annotated methods registered natively (arity-aware, incl. DataTable/DocString) and
  published to the daemon.
- Catch-all with a negative lookahead over native patterns; daemon dispatch for everything else.
- Dependency-free JSON reader/writer on the JDK; `java.net.http` client.
- Tests: 20 kit features plus 9 unit tests.
