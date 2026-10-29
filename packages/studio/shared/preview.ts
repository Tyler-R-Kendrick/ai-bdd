import { z } from 'zod';

const methodSchema = z.enum([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);
const interactionSchema = z
  .object({
    description: z.string().min(1).max(300),
    request: z
      .object({
        method: methodSchema,
        path: z.string().regex(/^\/(?!\/)[^?#]{0,1000}$/),
        query: z
          .record(
            z.string().max(100),
            z.union([
              z.string().max(1000),
              z.array(z.string().max(1000)).max(20),
            ]),
          )
          .optional(),
        body: z.json().optional(),
      })
      .strict(),
    response: z
      .object({
        status: z.number().int().min(200).max(599),
        headers: z
          .record(
            z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
            z.string().max(1000),
          )
          .optional(),
        body: z.json().optional(),
      })
      .strict(),
  })
  .strict();
const contractsSchema = z
  .object({
    consumer: z.object({ name: z.string().min(1).max(200) }).strict(),
    provider: z.object({ name: z.string().min(1).max(200) }).strict(),
    interactions: z.array(interactionSchema).max(100),
    metadata: z
      .object({ pactSpecification: z.object({ version: z.string() }).strict() })
      .optional(),
  })
  .strict();
export type PreviewContract = z.infer<typeof contractsSchema>;
export const samplePreviewContract: PreviewContract = {
  consumer: { name: 'artifact-preview' },
  provider: { name: 'project-api' },
  interactions: [
    {
      description: 'List the preview project',
      request: { method: 'GET', path: '/api/project' },
      response: {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { title: 'A new idea', status: 'draft', tasks: [] },
      },
    },
  ],
  metadata: { pactSpecification: { version: '2.0.0' } },
};
export function parsePreviewContracts(
  source: string | undefined,
): PreviewContract | null {
  if (!source?.trim()) return null;
  if (source.length > 200000)
    throw new Error('Contract fixtures exceed the 200 KB preview limit');
  const contract = contractsSchema.parse(JSON.parse(source));
  for (const interaction of contract.interactions) {
    for (const value of Object.values(interaction.response.headers ?? {})) {
      if (/[\r\n]/.test(value))
        throw new Error('Contract response headers cannot contain line breaks');
    }
    if (
      [204, 205, 304].includes(interaction.response.status) &&
      interaction.response.body !== undefined
    ) {
      throw new Error(
        `Response ${interaction.response.status} must not contain a body`,
      );
    }
  }
  return contract;
}
const scriptData = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
const scriptSource = (source: string) =>
  source.replace(/<\/script/gi, '<\\/script');
const styleSource = (source: string) =>
  source.replace(/<\/style/gi, '<\\/style');

/**
 * A preview is an opaque-origin document, not a second authenticated application.
 * Its CSP blocks network, nested frames, workers, forms, and object embeds. Only
 * explicit Pact-shaped fixtures answer fetch calls; an unmatched call rejects.
 */
export function buildPreviewDocument(
  files: Record<string, string>,
  entry: string,
  channel: string,
): string {
  const html = files[entry];
  if (html === undefined || !/\.html?$/i.test(entry))
    throw new Error('Choose an existing HTML file as the preview entry');
  if (
    Object.keys(files).length > 50 ||
    Object.values(files).reduce((n, source) => n + source.length, 0) > 2000000
  )
    throw new Error('Code preview exceeds the 2 MB / 50 file limit');
  const contracts = parsePreviewContracts(files['contracts.json']);
  const runtime = `(() => {
    const channel = ${scriptData(channel)};
    const fixtures = ${scriptData(contracts?.interactions ?? [])};
    const send = (level, args) => {
      let text;
      try { text = args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '); }
      catch { text = '[Unserializable console output]'; }
      parent.postMessage({studioPreview: channel, level, text: String(text).slice(0, 4000)}, '*');
    };
    for (const level of ['log', 'info', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => { original(...args); send(level, args); };
    }
    addEventListener('error', event => send('error', [event.message]));
    addEventListener('unhandledrejection', event => send('error', [String(event.reason)]));
    const stable = value => JSON.stringify(value, function(key, item) {
      return item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item;
    });
    window.fetch = async (input, options = {}) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), 'https://preview.invalid');
      const method = String(options.method || (request && request.method) || 'GET').toUpperCase();
      const body = options.body !== undefined ? options.body : request ? await request.clone().text() : undefined;
      const query = Object.fromEntries([...new Set(url.searchParams.keys())].sort().map(key => [key, url.searchParams.getAll(key)]));
      const fixture = fixtures.find(({request: spec}) => {
        if (spec.method !== method || spec.path !== url.pathname) return false;
        const expectedQuery = Object.fromEntries(Object.entries(spec.query || {}).sort().map(([key, value]) => [key, Array.isArray(value) ? value : [value]]));
        if (stable(query) !== stable(expectedQuery)) return false;
        if (Object.prototype.hasOwnProperty.call(spec, 'body')) {
          let actual = body;
          try { actual = JSON.parse(body); } catch {}
          if (stable(actual) !== stable(spec.body)) return false;
        }
        return true;
      });
      if (!fixture) { const message = 'No preview contract for ' + method + ' ' + url.pathname; send('error', [message]); throw new TypeError(message); }
      const spec = fixture.response;
      const headers = new Headers(spec.headers || {});
      if (spec.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      send('info', ['Contract replay: ' + method + ' ' + url.pathname + ' → ' + spec.status]);
      return new Response(spec.body === undefined ? null : typeof spec.body === 'string' && !headers.get('Content-Type').includes('json') ? spec.body : JSON.stringify(spec.body), {status: spec.status, headers});
    };
  })();`;
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  // The policy/runtime are parsed before any authored HTML, including malformed HTML.
  const prelude = `<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><script>${runtime}</script>`;
  const styles = Object.entries(files)
    .filter(([path]) => /\.css$/i.test(path))
    .map(
      ([path, source]) =>
        `<style data-studio-file="${path.replace(/[^a-zA-Z0-9_./-]/g, '')}">${styleSource(source)}</style>`,
    )
    .join('\n');
  const scripts = Object.entries(files)
    .filter(([path]) => /\.js$/i.test(path))
    .map(([, source]) => `<script>${scriptSource(source)}</script>`)
    .join('\n');
  return `<!doctype html>${prelude}${styles}${html}${scripts}`;
}
