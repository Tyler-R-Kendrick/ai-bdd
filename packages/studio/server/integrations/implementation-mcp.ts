import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  implementationEditSchema,
  implementationClaimSchema,
  implementationReportSchema,
} from '../../shared/implementation.ts';

export function registerImplementationMcp(
  server: McpServer,
  call: (path: string, method?: string, body?: unknown) => Promise<unknown>,
  result: (value: unknown) => any,
) {
  const artifactId = z.string().uuid();
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  const write = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    'studio_read_implementation',
    {
      description:
        'Read the versioned implementation DAG, canonical plan revision, checkout provenance, active lock and durable task/run history. Read before claiming.',
      inputSchema: { artifactId },
      annotations: read,
    },
    async ({ artifactId }) =>
      result(await call(`/artifacts/${artifactId}/implementation`)),
  );
  server.registerTool(
    'studio_edit_implementation',
    {
      description:
        'Draft or revise an acyclic task graph against an exact plan and graph revision. Human approval is a separate browser action; an agent cannot approve its own graph.',
      inputSchema: { artifactId, ...implementationEditSchema.shape },
      annotations: write,
    },
    async ({ artifactId, ...body }) =>
      result(
        await call(
          `/artifacts/${artifactId}/implementation/graph`,
          'PUT',
          body,
        ),
      ),
  );
  server.registerTool(
    'studio_start_implementation',
    {
      description:
        'Atomically claim the human-approved exact graph with your repository, branch and commit. Verify those values against your checkout first. Claiming locks plan edits.',
      inputSchema: { artifactId, ...implementationClaimSchema.shape },
      annotations: write,
    },
    async ({ artifactId, ...body }) =>
      result(
        await call(
          `/artifacts/${artifactId}/implementation/claim`,
          'POST',
          body,
        ),
      ),
  );
  server.registerTool(
    'studio_report_implementation',
    {
      description:
        'Report dependency-ready task starts, blockers, PR state, completion with PR or no-change evidence, independent whole-graph criterion verification, or a revision request. Every report requires a stable idempotency key; reuse it only for identical input. Reported evidence is attributable external evidence, not a passing server test.',
      inputSchema: { artifactId, ...implementationReportSchema.shape },
      annotations: write,
    },
    async ({ artifactId, ...body }) =>
      result(
        await call(
          `/artifacts/${artifactId}/implementation/report`,
          'POST',
          body,
        ),
      ),
  );
}
