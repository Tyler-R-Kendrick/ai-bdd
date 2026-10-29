import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createStudioMcpServer, mcpSettings } from '../server/mcp.ts';

const token = 'a'.repeat(43);
const artifactId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(close.splice(0).map((fn) => fn()));
});

async function connect(
  handler: (input: URL, options: RequestInit) => Response | Promise<Response>,
) {
  const fetcher = vi.fn(handler);
  const server = createStudioMcpServer(
    { origin: 'http://127.0.0.1:8787', token },
    { fetch: fetcher as unknown as typeof fetch },
  );
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  close.push(
    () => client.close(),
    () => server.close(),
  );
  return { client, fetcher };
}

describe('Studio MCP adapter', () => {
  it('rejects insecure remote origins and credential-shaped URL configuration', () => {
    expect(mcpSettings({ STUDIO_API_TOKEN: token })).toEqual({
      origin: 'http://127.0.0.1:8787',
      token,
    });
    for (const origin of [
      'http://example.com',
      'https://example.com/path',
      'https://example.com/',
      'https://name:secret@example.com',
    ]) {
      expect(() =>
        mcpSettings({ STUDIO_API_URL: origin, STUDIO_API_TOKEN: token }),
      ).toThrow();
    }
    expect(() => mcpSettings({})).toThrow('STUDIO_API_TOKEN');
  });

  it('uses bearer authentication and preserves HTTP failures without leaking the token', async () => {
    const { client, fetcher } = await connect(() =>
      Response.json({ error: `Access denied ${token}` }, { status: 403 }),
    );
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'studio_update_adr')).toBe(
      true,
    );
    const result = await client.callTool({
      name: 'studio_read_artifact',
      arguments: { artifactId },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).toContain('403');
    expect(fetcher.mock.calls[0]?.[1].headers).toMatchObject({
      Authorization: `Bearer ${token}`,
    });
    expect(fetcher.mock.calls[0]?.[1].redirect).toBe('error');
  });

  it('posts main chat messages to the artifact-bound thread it read', async () => {
    const { client, fetcher } = await connect((input, options) =>
      options.method === 'GET'
        ? Response.json({ threads: [{ id: threadId, anchor: null }] })
        : Response.json({ id: 'message' }, { status: 201 }),
    );
    const result = await client.callTool({
      name: 'studio_comment',
      arguments: { artifactId, body: 'Keep this decision with this artifact.' },
    });
    expect(result.isError).not.toBe(true);
    expect(fetcher.mock.calls[1]?.[0].pathname).toBe(
      `/api/artifacts/${artifactId}/messages`,
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1].body))).toMatchObject({
      threadId,
      body: 'Keep this decision with this artifact.',
    });
  });

  it('forwards version-checked edits and sends bodyless run POSTs without JSON content type', async () => {
    const { client, fetcher } = await connect(() =>
      Response.json({ ok: true }),
    );
    await client.callTool({
      name: 'studio_update_artifact',
      arguments: {
        artifactId,
        version: 7,
        content: {
          files: { 'index.html': '<h1>Hello</h1>' },
          entry: 'index.html',
        },
      },
    });
    expect(fetcher.mock.calls[0]?.[1].method).toBe('PATCH');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body)).version).toBe(7);
    await client.callTool({
      name: 'studio_run_tests',
      arguments: { artifactId },
    });
    expect(fetcher.mock.calls[1]?.[1].method).toBe('POST');
    expect(fetcher.mock.calls[1]?.[1].headers).not.toHaveProperty(
      'Content-Type',
    );
  });

  it('retrieves bounded older thread history through artifact-scoped cursors', async () => {
    const before = '33333333-3333-4333-8333-333333333333';
    const { client, fetcher } = await connect(() =>
      Response.json({
        messages: [{ id: 'older', body: 'Original decision context', sequence: 3 }],
        nextCursor: before,
        hasMore: true,
      }),
    );
    const result = await client.callTool({
      name: 'studio_get_messages',
      arguments: { artifactId, threadId, limit: 25, before },
    });
    expect(result.isError).not.toBe(true);
    const target = fetcher.mock.calls[0]![0];
    expect(target.pathname).toBe(`/api/artifacts/${artifactId}/messages`);
    expect(target.searchParams.get('threadId')).toBe(threadId);
    expect(target.searchParams.get('before')).toBe(before);
    expect(target.searchParams.get('limit')).toBe('25');
    expect(JSON.stringify(result)).toContain('Original decision context');
    const invalid = await client.callTool({
      name: 'studio_get_messages',
      arguments: { artifactId, threadId, limit: 201 },
    });
    expect(invalid.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
