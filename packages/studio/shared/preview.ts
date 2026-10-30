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
const matcherSchema = z
  .object({
    match: z.enum([
      'type',
      'regex',
      'integer',
      'decimal',
      'number',
      'boolean',
      'null',
      'equality',
      'include',
    ]),
    regex: z.string().max(300).optional(),
    value: z.json().optional(),
    min: z.number().int().min(0).max(10000).optional(),
    max: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
const ruleSchema = z
  .object({
    matchers: z.array(matcherSchema).min(1).max(10),
    combine: z.enum(['AND', 'OR']).default('AND'),
  })
  .strict();
const matchingRulesSchema = z
  .object({
    body: z.record(z.string().max(300), ruleSchema).optional(),
    path: z.record(z.string().max(300), ruleSchema).optional(),
    query: z.record(z.string().max(300), ruleSchema).optional(),
    headers: z.record(z.string().max(300), ruleSchema).optional(),
  })
  .strict();
const interactionSchema = z
  .object({
    description: z.string().min(1).max(300),
    providerStates: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            params: z.record(z.string(), z.json()).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
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
        headers: z.record(z.string().max(100), z.string().max(1000)).optional(),
        body: z.json().optional(),
        matchingRules: matchingRulesSchema.optional(),
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
      .object({
        pactSpecification: z.object({ version: z.string().max(30) }).strict(),
      })
      .passthrough()
      .optional(),
  })
  .strict();
function normalizeHeaders(headers: any) {
  if (headers === undefined) return undefined;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers))
    throw new Error('Pact headers must be an object');
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(', ') : value,
    ]),
  );
}
function normalizeRules(rules: any) {
  if (!rules) return undefined;
  const normalized: Record<string, Record<string, unknown>> = {};
  const add = (category: string, path: string, rule: any) => {
    if (!['body', 'path', 'query', 'header', 'headers'].includes(category))
      throw new Error(
        `Pact preview does not support request matching category ${category}`,
      );
    category = category === 'header' ? 'headers' : category;
    const matchers = Array.isArray(rule?.matchers) ? rule.matchers : [rule];
    if (category === 'query' && path !== '$' && !path.endsWith(']'))
      path += '[*]';
    (normalized[category] ??= {})[path] = {
      matchers,
      combine: rule.combine ?? 'AND',
    };
  };
  for (const [key, value] of Object.entries(rules)) {
    if (key.startsWith('$.')) {
      const match = /^\$\.(body|path|query|headers?)(.*)$/.exec(key);
      if (!match) throw new Error('Unsupported Pact matching path');
      add(match[1]!, '$' + match[2], value);
    } else
      for (const [path, rule] of Object.entries(value as any))
        add(key, path.startsWith('$') ? path : '$.' + path, rule);
  }
  return matchingRulesSchema.parse(normalized);
}
function normalizePact(raw: any) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.interactions))
    throw new Error('Choose a Pact HTTP contract with an interactions array');
  const version = String(raw.metadata?.pactSpecification?.version ?? '2.0.0');
  const unwrap = (body: any) => {
    if (body === undefined) return undefined;
    if (
      version.startsWith('4') &&
      body &&
      typeof body === 'object' &&
      Object.hasOwn(body, 'content') &&
      Object.hasOwn(body, 'contentType')
    ) {
      if (body.encoded)
        throw new Error(
          'Encoded binary Pact bodies cannot be replayed as JSON preview responses',
        );
      return body.content;
    }
    return body;
  };
  return {
    consumer: { name: raw.consumer?.name },
    provider: { name: raw.provider?.name },
    interactions: raw.interactions.map((value: any) => {
      if (value.type && value.type !== 'Synchronous/HTTP')
        throw new Error(
          'Only synchronous HTTP Pact interactions can be replayed in a browser preview',
        );
      let query = value.request?.query;
      if (typeof query === 'string') {
        const params = new URLSearchParams(query);
        query = Object.fromEntries(
          [...new Set(params.keys())].map((key) => [key, params.getAll(key)]),
        );
      }
      const requestBody = unwrap(value.request?.body),
        responseBody = unwrap(value.response?.body);
      return {
        description: value.description,
        providerStates:
          value.providerStates ??
          (value.providerState ? [{ name: value.providerState }] : undefined),
        request: {
          method: String(value.request?.method ?? 'GET').toUpperCase(),
          path: value.request?.path,
          query,
          headers: normalizeHeaders(value.request?.headers),
          ...(requestBody === undefined ? {} : { body: requestBody }),
          matchingRules: normalizeRules(
            value.request?.matchingRules ?? value.matchingRules,
          ),
        },
        response: {
          status: value.response?.status,
          headers: normalizeHeaders(value.response?.headers),
          ...(responseBody === undefined ? {} : { body: responseBody }),
        },
      };
    }),
    metadata: { ...raw.metadata, pactSpecification: { version } },
  };
}
export function previewProviderState(source: string | undefined) {
  if (!source?.trim()) return '';
  return z
    .object({ providerState: z.string().max(200).default('') })
    .strict()
    .parse(JSON.parse(source)).providerState;
}
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
  const contract = contractsSchema.parse(normalizePact(JSON.parse(source)));
  for (const interaction of contract.interactions) {
    for (const rules of Object.values(interaction.request.matchingRules ?? {}))
      for (const rule of Object.values(rules))
        for (const matcher of rule.matchers) {
          if (matcher.match === 'regex') {
            if (!matcher.regex)
              throw new Error('Pact regex matchers need a regular expression');
            try {
              new RegExp(matcher.regex);
            } catch {
              throw new Error('Pact regular expression is invalid');
            }
          }
        }
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
  const providerState = previewProviderState(
    contracts?.metadata?.studioPreview
      ? JSON.stringify(contracts.metadata.studioPreview)
      : files['preview.config.json'],
  );
  if (
    providerState &&
    !contracts?.interactions.some((item) =>
      item.providerStates?.some((state) => state.name === providerState),
    )
  )
    throw new Error(
      'The selected provider state is missing from contracts.json',
    );
  const runtime = `(() => {
    const channel = ${scriptData(channel)};
    const fixtures = ${scriptData((contracts?.interactions ?? []).filter((value) => !providerState || value.providerStates?.some((state) => state.name === providerState)))};
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
    const pathParts = path => {const result=[];let token='';for(let i=0;i<path.length;i++){const char=path[i];if(char==='.') {if(token)result.push(token);token='';}else if(char==='['){if(token)result.push(token);token='';let end=path.indexOf(']',i);if(end<0)return [];let part=path.slice(i+1,end);if(part[0]==="'"||part[0]==='"')part=part.slice(1,-1);result.push(part);i=end;}else token+=char;}if(token)result.push(token);return result;};
    const ruleAt = (rules, path) => Object.entries(rules || {}).filter(([key]) => {const parts=pathParts(key), actual=pathParts(path);return parts.length===actual.length&&parts.every((part,i)=>part==='*'||part===actual[i]);}).sort(([a],[b])=>b.split('*').join('').length-a.split('*').join('').length)[0]?.[1];
    const isType = (value, expected) => expected===null?value===null:Array.isArray(expected)?Array.isArray(value):typeof value===typeof expected && !Array.isArray(value);
    const match = (actual, expected, path, rules) => {
      const rule = ruleAt(rules,path);
      if(rule){
        const passes=rule.matchers.map(m=>{
          if(m.match==='equality')return stable(actual)===stable(expected);
          if(m.match==='regex')return typeof actual==='string'&&new RegExp(m.regex).test(actual);
          if(m.match==='integer')return Number.isInteger(actual);
          if(m.match==='decimal')return typeof actual==='number'&&Number.isFinite(actual)&&!Number.isInteger(actual);
          if(m.match==='number')return typeof actual==='number'&&Number.isFinite(actual);
          if(m.match==='boolean')return typeof actual==='boolean';
          if(m.match==='null')return actual===null;
          if(m.match==='include')return typeof actual==='string'&&actual.includes(String(m.value??expected));
          return isType(actual,expected)&&(!Array.isArray(actual)||((m.min===undefined||actual.length>=m.min)&&(m.max===undefined||actual.length<=m.max)));
        });
        if(!(rule.combine==='OR'?passes.some(Boolean):passes.every(Boolean)))return false;
        if(rule.matchers.some(m=>m.match!=='type'))return true;
      }
      if(Array.isArray(expected)){
        if(!Array.isArray(actual)||(!rule&&actual.length!==expected.length))return false;
        return actual.every((item,i)=>expected.length?match(item,expected[Math.min(i,expected.length-1)],path+'['+i+']',rules):!!rule);
      }
      if(expected&&typeof expected==='object'){
        if(!actual||typeof actual!=='object'||Array.isArray(actual))return false;
        if(!rule&&Object.keys(actual).length!==Object.keys(expected).length)return false;
        return Object.entries(expected).every(([key,value])=>Object.prototype.hasOwnProperty.call(actual,key)&&match(actual[key],value,path+'.'+key,rules));
      }
      return rule?true:stable(actual)===stable(expected);
    };
    window.fetch = async (input, options = {}) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), 'https://preview.invalid');
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new TypeError('Preview requests require an HTTP boundary URL without credentials');
      const method = String(options.method || (request && request.method) || 'GET').toUpperCase();
      const signal = options.signal || (request && request.signal);
      if(signal?.aborted)throw new DOMException('The request was aborted','AbortError');
      const rawBody = options.body !== undefined ? options.body : request ? await request.clone().text() : undefined;
      if(['GET','HEAD'].includes(method)&&rawBody!==undefined&&rawBody!==null)throw new TypeError('GET and HEAD requests cannot contain a body');
      const body = rawBody === undefined || rawBody === null ? undefined : typeof rawBody === 'string' ? rawBody : rawBody instanceof Blob ? await rawBody.text() : String(rawBody);
      const requestHeaders = new Headers(options.headers || (request && request.headers) || {});
      const query = Object.fromEntries([...new Set(url.searchParams.keys())].sort().map(key => [key, url.searchParams.getAll(key)]));
      const fixture = fixtures.find(({request: spec}) => {
        if (spec.method !== method || !match(url.pathname,spec.path,'$',spec.matchingRules?.path)) return false;
        const expectedQuery = Object.fromEntries(Object.entries(spec.query || {}).sort().map(([key, value]) => [key, Array.isArray(value) ? value : [value]]));
        if (!match(query,expectedQuery,'$',spec.matchingRules?.query)) return false;
        if(!Object.entries(spec.headers||{}).every(([name,value])=>match(requestHeaders.get(name),value,'$.'+name.toLowerCase(),Object.fromEntries(Object.entries(spec.matchingRules?.headers||{}).map(([key,value])=>[key.toLowerCase(),value])))))return false;
        if (Object.prototype.hasOwnProperty.call(spec, 'body')) {
          let actual = body;
          try { actual = JSON.parse(body); } catch {}
          if (!match(actual,spec.body,'$',spec.matchingRules?.body)) return false;
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
    // HTTP clients using XMLHttpRequest share the same contract boundary; no real request is issued.
    window.XMLHttpRequest = class extends EventTarget {
      static UNSENT=0;static OPENED=1;static HEADERS_RECEIVED=2;static LOADING=3;static DONE=4;UNSENT=0;OPENED=1;HEADERS_RECEIVED=2;LOADING=3;DONE=4;
      constructor(){super();this.readyState=0;this.status=0;this.statusText='';this.response=null;this.responseText='';this.responseType='';this.responseURL='';this.timeout=0;this.withCredentials=false;this.upload=new EventTarget();this._headers={};this._responseHeaders=new Headers();this._aborted=false;}
      _emit(type){const event=new Event(type);this.dispatchEvent(event);if(typeof this['on'+type]==='function')this['on'+type](event);}
      open(method,url,async=true){if(!async)throw new Error('Synchronous XMLHttpRequest is unavailable in previews');this._method=method;this._url=url;this.readyState=1;this._emit('readystatechange');}
      setRequestHeader(name,value){if(this.readyState!==1)throw new Error('Call open before setting headers');this._headers[name]=value;}
      getResponseHeader(name){return this._responseHeaders.get(name);}
      getAllResponseHeaders(){return [...this._responseHeaders].map(([name,value])=>name+': '+value).join('\\r\\n');}
      overrideMimeType(){}
      abort(){this._aborted=true;this.status=0;this.readyState=0;this._emit('abort');this._emit('loadend');}
      send(body){if(this.readyState!==1)throw new Error('Call open before send');this._emit('loadstart');window.fetch(this._url,{method:this._method,headers:this._headers,body}).then(async response=>{if(this._aborted)return;this.status=response.status;this.statusText=response.statusText;this.responseURL=this._url;this._responseHeaders=response.headers;this.readyState=2;this._emit('readystatechange');this.responseText=await response.text();if(this._aborted)return;this.readyState=3;this._emit('readystatechange');this.response=this.responseType==='json'?JSON.parse(this.responseText):this.responseType==='arraybuffer'?new TextEncoder().encode(this.responseText).buffer:this.responseType==='blob'?new Blob([this.responseText],{type:response.headers.get('Content-Type')||''}):this.responseText;this.readyState=4;this._emit('readystatechange');this._emit('load');this._emit('loadend');}).catch(error=>{if(this._aborted)return;this.status=0;this.readyState=4;this._emit('readystatechange');this._emit('error');this._emit('loadend');send('error',[String(error)]);});}
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
