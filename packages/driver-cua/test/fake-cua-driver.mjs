// A tiny stand-in for `cua-driver mcp` that speaks MCP (newline-delimited JSON-RPC) on stdio. It exists to exercise the real
// McpStdioCuaClient (process spawn, handshake, tool listing, calls, exits) without a desktop. The first argument picks a mode:
//   ok          full handshake; tools: echo, structured, fail, refuse, slow (never answers), die (exits), many_lines (stderr noise)
//   no-tools    handshake succeeds, tools/list is empty
//   list-error  initialize succeeds, tools/list answers with a JSON-RPC error
//   exit-now    writes to stderr and exits with code 7 before answering anything
//   desktop     serves the tools the driver needs (list_windows, get_window_state, click, type_text, press_key, scroll,
//               health_report) for one fake browser window; FAKE_CUA_LOG=<file> receives every tool call as a JSON line
// FAKE_CUA_REPORT=<file> makes it write {argv, env} there at start, so tests can see how it was launched.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'ok';
if (process.env.FAKE_CUA_REPORT) {
  writeFileSync(process.env.FAKE_CUA_REPORT, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
}

if (mode === 'exit-now') {
  process.stderr.write('cua-driver: no display available\nsecond line\nthird line\nfourth line\n');
  setTimeout(() => process.exit(7), 150); // let the parent read stderr first
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

const TOOLS = ['echo', 'structured', 'fail', 'refuse', 'slow', 'die', 'many_lines', 'rpc_error'];
const DESKTOP_TOOLS = ['list_windows', 'get_window_state', 'click', 'type_text', 'press_key', 'scroll', 'health_report'];
const ROWS = [
  { element_index: 0, element_token: 't:0', role: 'frame', label: 'Fake - Chromium' },
  { element_index: 1, element_token: 't:1', role: 'document web', label: 'Fake', parent_index: 0, in_web_content: true },
  { element_index: 2, element_token: 't:2', role: 'push button', label: 'Go', parent_index: 1, in_web_content: true, actions: ['doDefault'] },
];
const text = (t, structuredContent) => ({ content: [{ type: 'text', text: t }], ...(structuredContent === undefined ? {} : { structuredContent }) });
function desktop(name, args) {
  switch (name) {
    case 'list_windows':
      return text('1 window', { windows: [{ pid: 4242, window_id: 9, title: 'Fake - Chromium', app_name: 'Fake', z_index: 1, is_on_screen: true }] });
    case 'get_window_state':
      return text('state', { window_title: 'Fake - Chromium', truncated: false, elements: ROWS });
    case 'health_report':
      return text('ok', { overall: 'ok', checks: [{ name: 'ax', status: 'pass', message: 'fine' }] });
    default:
      return text('done', { delivery: { mode: args.delivery_mode } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (mode === 'exit-now' || line.trim() === '') return; // exit-now never answers
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notifications (initialized)
  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-cua-driver', version: '0.0.0' } } });
      return;
    case 'tools/list':
      if (mode === 'list-error') {
        send({ id: msg.id, error: { code: -32603, message: 'tool registry exploded\nsecond line of the explosion' } });
        return;
      }
      send({ id: msg.id, result: { tools: mode === 'no-tools' ? [] : (mode === 'desktop' ? DESKTOP_TOOLS : TOOLS).map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) } });
      return;
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (mode === 'desktop') {
        if (process.env.FAKE_CUA_LOG) appendFileSync(process.env.FAKE_CUA_LOG, `${JSON.stringify({ name, args })}\n`);
        send({ id: msg.id, result: desktop(name, args) });
        return;
      }
      switch (name) {
        case 'rpc_error':
          send({ id: msg.id, error: { code: -32603, message: 'internal failure\nsecond line' } });
          return;
        case 'echo':
          send({ id: msg.id, result: { content: [{ type: 'text', text: `echo ${JSON.stringify(args)}` }, { type: 'image', data: Buffer.from([137, 80, 78, 71]).toString('base64'), mimeType: 'image/png' }] } });
          return;
        case 'structured':
          send({ id: msg.id, result: { content: [{ type: 'text', text: 'has structure' }], structuredContent: { windows: [{ pid: 1 }], args } } });
          return;
        case 'fail':
          send({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'it broke\nwith detail' }], structuredContent: { code: 'broken' } } });
          return;
        case 'refuse':
          send({ id: msg.id, result: { content: [], structuredContent: { status: 'refused', refusal: { code: 'stale_element_token', message: 'token is stale' } } } });
          return;
        case 'slow':
          return; // never answers
        case 'die':
          process.stderr.write('dying on request\n');
          process.exit(9);
          return;
        case 'many_lines':
          for (let i = 0; i < 30; i += 1) process.stderr.write(`noise ${i}\n`);
          send({ id: msg.id, result: { content: [{ type: 'text', text: 'noisy' }] } });
          return;
        default:
          send({ id: msg.id, error: { code: -32601, message: `unknown tool ${name}` } });
          return;
      }
    }
    default:
      send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});
