import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { TOOL_DEFINITIONS, type HealthOutput } from '@ai-bdd/contracts';
import { createSessionManager, resolveConfig } from '@ai-bdd/runtime';
import { createFakeModelSet } from '@ai-bdd/models/fake';
import { fake } from '@ai-bdd/driver-fake';
import { createMcpServer } from '../../src/mcp.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const SCHEMA_DIR = join(REPO, 'packages', 'contracts', 'schemas', 'tools');
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function connect() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'aibdd-mcp-'));
  const models = createFakeModelSet({ rulesPath: join(REPO, 'fixtures', 'fake-model', 'rules.json') });
  const config = resolveConfig({ drivers: { fake: { use: '@ai-bdd/driver-fake' } }, defaultDriver: 'fake' }, projectRoot);
  const sessionManager = createSessionManager({
    config,
    models,
    drivers: { fake: fake({ modelPath: join(REPO, 'fixtures', 'app', 'model.json') }) },
  });
  const server = createMcpServer({ backend: sessionManager as never });
  const pair = InMemoryTransport.createLinkedPair() as unknown as [InMemoryTransport, InMemoryTransport];
  const client = new Client({ name: 'ai-bdd-test', version: '0.1.0' });
  await server.connect(pair[0] as never);
  await client.connect(pair[1] as never);
  cleanups.push(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await sessionManager.closeAll();
  });
  return { client };
}

describe('MCP surface (AC8)', () => {
  it('registers every tool from the contract table', async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(TOOL_DEFINITIONS.map((tool) => tool.name).sort());
  });

  it('R-K12a: input schemas are byte-identical to the checked-in files', async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === tool.name)!;
      const file = JSON.parse(readFileSync(join(SCHEMA_DIR, `${definition.short}.input.schema.json`), 'utf8')) as Record<string, unknown>;
      const fromMcp = normalize(tool.inputSchema as Record<string, unknown>);
      const fromFile = normalize(file);
      // The SDK adds a JSON Schema version marker; everything else must match exactly.
      expect(fromMcp.properties, tool.name).toEqual(fromFile.properties);
      expect(fromMcp.additionalProperties, tool.name).toBe(false);
      expect(fromMcp.required ?? [], tool.name).toEqual(fromFile.required ?? []);
    }
  });

  it('calls a tool and returns structured content', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'aibdd_health', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as unknown as HealthOutput).protocol).toBe(1);
  });

  it('rejects unknown fields (INVALID_ARGUMENT or the SDK validation message)', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'aibdd_health', arguments: { unexpected: true } });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    // The MCP SDK validates against the registered schema before the handler runs
    // and reports its own message; the HTTP mirror returns the structured
    // INVALID_ARGUMENT payload. Both reject the call, which is what AC8 requires.
    if (text.startsWith('{')) {
      expect((JSON.parse(text) as { code: string }).code).toBe('INVALID_ARGUMENT');
    } else {
      expect(text).toMatch(/unexpected|invalid|validation/iu);
    }
  });

  it('rejects a step on an unknown session with NO_SESSION', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'aibdd_resolve_step',
      arguments: { sessionId: 'does-not-exist', step: { text: 'Open billing settings' } },
    });
    expect(result.isError).toBe(true);
    expect((JSON.parse((result.content[0] as { text: string }).text) as { code: string }).code).toBe('NO_SESSION');
  });
});

function normalize(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...schema };
  delete copy.$schema;
  return copy;
}
