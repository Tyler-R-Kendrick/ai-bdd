# Studio review evidence

These captures use synthetic local review content. They contain no deployment credentials and do not represent customer activity.

| Capture | Source | What it establishes |
| --- | --- | --- |
| 01-artifact-api.png | Chromium's built-in JSON viewer, authenticated `GET /api/artifacts/:id`, backend code c4cfe7e | One stored artifact and its directly related discussion thread, persisted message, dedicated ADR, and version. Empty runs and inactive agents are visible. |

The API capture was generated from an archived build of the foundation PR, without the UI layer. Automated checks establish persistence, collaboration and authorization behavior; a static screenshot alone does not prove those behaviors.
