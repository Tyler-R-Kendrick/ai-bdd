#!/usr/bin/env node
/**
 * Minimal MCP stdio client used to snapshot a server's tools/list catalog.
 * Usage: node scripts/mcp-tools-snapshot.mjs <command> [args...]
 * Writes JSON to stdout: { serverInfo, tools: [...] }
 */
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('usage: mcp-tools-snapshot.mjs <command> [args...]\n');
  process.exit(2);
}

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  child.stdin.write(`${payload}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
}

try {
  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'ai-bdd-snapshot', version: '0.1.0' },
  });
  notify('notifications/initialized', {});
  const list = await send('tools/list', {});
  process.stdout.write(
    `${JSON.stringify(
      {
        serverInfo: init.result?.serverInfo ?? null,
        protocolVersion: init.result?.protocolVersion ?? null,
        tools: (list.result?.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(`snapshot failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
