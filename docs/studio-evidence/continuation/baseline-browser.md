# Integrated baseline browser regression

On 2026-10-30, all **43 standard Studio browser cases passed in 2.0 minutes**, with one worker and zero retries, from source `ec2894d`. This worktree merged root `c6cf24f` and retained the strict mobile fixture corrections `45b999e` and `de1e23a`. The production client/server and portable connector build passed before the run.

The run started its own built application on port 8877 with `reuseExistingServer: false` and a fresh isolated SQL data directory. No other agent used that listener. The four self-hosted `final-product.spec.ts` cases were excluded from this baseline run because they already had their own separately recorded full-application acceptance run; see [their source and evidence](full-product/README.md). Audio and MIDI canvas acceptance is recorded by their dedicated workflows; merely including those dispatch modules in this build is not claimed as editor acceptance.

The 43 cases span fourteen files: exact CAD/history/STEP import, GLB scene hierarchy and read-only tools; actual React/TypeScript editing, project ZIP roundtrip, compiler recovery and Pact provider-state switching; Word/restricted-MDX interchange, PDF pagination, questionnaire answer/ADR acceptance, suggestions, standard authoring, durable anchors and fresh viewer permissions; authenticated issuer/GitHub identity boundaries; implementation DAG authoring, explicit model transport and independent review; connected-machine approval and fresh mobile viewer access; paginated chat; collaborative document history and mobile focus; multitrack video/keyframes/source trims, encoded MP4 audio, portable projects and actual WebM; authored font/vector/raster interchange; 3D parameters/actual worker subtraction and interactive rich document blocks.

The mobile fixture opens the artifact panel before choosing Connections and locates the native participation picker by its exact accessible combobox role. Its assertions still require paused state, a disabled picker and Resume action, absent machine write/pair controls, and HTTP 403 on a viewer mutation request. [The reviewed mobile capture](baseline-connections-viewer-mobile.png) shows the View only header, Paused state, disabled participation controls and honest offline provider status. The panel was scrolled to those controls before capture. The image was opened and visually checked for matching claims, readable controls, page overflow and exposed credentials.

A separate document history regression (`f6c9b77`) passed as part of **20 real SQLite/PostgreSQL document checks**. It inserts 5,000 actual retained answer rows, verifies that a byte-for-byte current answer retry still returns HTTP 200 and the same attributed record across instances, and rejects a genuinely new answer with HTTP 409 while retaining exactly 5,000 rows. It neither mocks the count nor changes the production quota. The minimal quota guard is `737b670`; root already retained the equivalent guard in its integrated source.

The baseline used the standard Playwright config with only these isolation overrides:

```ts
{
  testIgnore: '**/final-product.spec.ts',
  retries: 0,
  webServer: {
    ...base.webServer,
    reuseExistingServer: false,
    env: { ...base.webServer.env, STUDIO_DATA_DIR: freshDirectory },
  },
}
```

The retained execution log is `work/baseline-qa-browser-complete.log` in the shared execution workspace. Local model, identity, connected-machine and other protocol fixtures remain explicit fixtures; these tests do not assert live vendor credentials or production deployment certification.
