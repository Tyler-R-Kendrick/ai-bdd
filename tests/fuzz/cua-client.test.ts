import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { desktopEnv, normalizeResult } from '@ai-bdd/driver-cua';
import { PROTO_KEYS, hostileKey, hostileString, jsonValue, params } from './helpers.ts';

// ───────────────────────── normalizeResult

const b64 = fc.uint8Array({ maxLength: 24 }).map((b) => Buffer.from(b).toString('base64'));
const textBlock = fc.record({ type: fc.constant('text'), text: hostileString({ maxLength: 40 }) });
const imageBlock = fc.record({ type: fc.constant('image'), data: b64, mimeType: fc.option(fc.constantFrom('image/png', 'image/jpeg', ''), { nil: undefined }) }, { requiredKeys: ['type', 'data'] });
const junkBlock = jsonValue({ maxDepth: 2, maxKeys: 3 });
const structured = fc.oneof(
  fc.record({ status: fc.constantFrom('ok', 'refused', 'REFUSED', 5, null), refusal: fc.option(fc.record({ code: fc.oneof(fc.string({ maxLength: 12 }), fc.integer(), fc.constant(null)), message: fc.oneof(fc.string({ maxLength: 20 }), fc.integer()) }, { requiredKeys: [] }), { nil: undefined }), code: fc.oneof(fc.string({ maxLength: 10 }), fc.integer()), detail: fc.oneof(fc.string({ maxLength: 10 }), fc.integer()), elements: jsonValue({ maxDepth: 2 }) }, { requiredKeys: [] }),
  jsonValue({ maxDepth: 3, maxKeys: 4 }),
);
const mcpShaped = fc.record({ content: fc.oneof(fc.array(fc.oneof(textBlock, imageBlock, junkBlock), { maxLength: 6 }), jsonValue({ maxDepth: 2 })), structuredContent: structured, isError: fc.oneof(fc.boolean(), fc.constantFrom('true', 1, null)) }, { requiredKeys: [] });

describe('fuzz: normalizeResult', () => {
  it('never throws on arbitrary values and always returns the documented shape', () => {
    fc.assert(
      fc.property(fc.oneof(mcpShaped, jsonValue({ maxDepth: 3, maxKeys: 5 }), fc.constantFrom(undefined, null, 0, '', 'x', true, Symbol.iterator as unknown as string)), (raw) => {
        const r = normalizeResult(raw);
        expect(typeof r.failed).toBe('boolean');
        expect(typeof r.text).toBe('string');
        expect(r.structured !== null && typeof r.structured === 'object' && !Array.isArray(r.structured)).toBe(true);
        expect(Array.isArray(r.images)).toBe(true);
        for (const img of r.images) {
          expect(img.data).toBeInstanceOf(Uint8Array);
          expect(typeof img.mimeType).toBe('string');
        }
        if (r.code !== undefined) {
          expect(r.failed).toBe(true);
          expect(typeof r.code).toBe('string');
        }
      }),
      params({ scale: 2 }),
    );
  });

  it('is failed exactly when isError is true or the driver refused; code and text follow the documented precedence', () => {
    fc.assert(
      fc.property(mcpShaped, (raw) => {
        const res = raw as { content?: unknown; structuredContent?: Record<string, unknown>; isError?: unknown };
        const r = normalizeResult(raw);
        const sc = res.structuredContent !== null && typeof res.structuredContent === 'object' && !Array.isArray(res.structuredContent) ? res.structuredContent : {};
        const refused = sc['status'] === 'refused';
        expect(r.failed).toBe(res.isError === true || refused);
        const blocks = Array.isArray(res.content) ? (res.content as unknown[]) : [];
        const texts = blocks.filter((b): b is { type: 'text'; text: string } => b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string').map((b) => b.text);
        const images = blocks.filter((b) => b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'image' && typeof (b as { data?: unknown }).data === 'string');
        expect(r.images).toHaveLength(images.length);
        r.images.forEach((img, i) => {
          expect(Buffer.from(img.data).toString('base64')).toBe(Buffer.from((images[i] as { data: string }).data, 'base64').toString('base64'));
        });
        const refusal = sc['refusal'] !== null && typeof sc['refusal'] === 'object' && !Array.isArray(sc['refusal']) ? (sc['refusal'] as Record<string, unknown>) : undefined;
        const joined = texts.join('\n');
        if (r.failed) {
          const message = typeof refusal?.['message'] === 'string' ? refusal['message'] : typeof sc['detail'] === 'string' ? sc['detail'] : undefined;
          expect(r.text).toBe(joined.length === 0 && message !== undefined ? message : joined);
          // the refusal's code wins when it is a string; otherwise the structured content's (a non-string refusal code hides nothing)
          const candidate = typeof refusal?.['code'] === 'string' ? refusal['code'] : sc['code'];
          if (typeof candidate === 'string') expect(r.code).toBe(candidate);
          else expect(r.code).toBeUndefined();
        } else {
          expect(r.text).toBe(joined);
          expect(r.code).toBeUndefined();
        }
      }),
      params(),
    );
  });
});

// ───────────────────────── desktopEnv

/** The documented policy, spelled out independently: names a desktop process needs, and nothing else. */
const EXACT = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'TZ', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'GTK_MODULES', 'ACCESSIBILITY_ENABLED', 'NO_AT_BRIDGE', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'WINDIR']);
const PREFIXES = ['LC_', 'XDG_', 'CUA_', 'AT_SPI_'];
const allowed = (k: string): boolean => EXACT.has(k) || PREFIXES.some((p) => k.startsWith(p));

const SECRET_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_BDD_CHROMIUM_PATH', 'ADMIN_PASSWORD', 'NODE_OPTIONS', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'LD_PRELOAD', 'path', 'Home', 'lc_all', 'xdg_runtime_dir', 'PATH ', ' PATH', 'LC', 'XDG', 'CUA', 'AT_SPI', 'PRE_LC_ALL', ...PROTO_KEYS];
const envName = fc.oneof(
  fc.constantFrom(...EXACT, ...SECRET_NAMES),
  fc.tuple(fc.constantFrom(...PREFIXES), fc.stringMatching(/^[A-Z_]{0,8}$/)).map(([p, s]) => `${p}${s}`),
  hostileKey,
  fc.stringMatching(/^[A-Z][A-Z0-9_]{0,12}$/),
);
const envValue = fc.oneof(fc.string({ maxLength: 12 }), hostileString({ maxLength: 12 }), fc.constant(undefined), fc.constant(''));

describe('fuzz: desktopEnv', () => {
  it('passes through exactly the allowed names with their values, and drops every other name (provider keys and secrets included)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(envName, envValue), { maxLength: 30 }), (entries) => {
        const source: Record<string, string | undefined> = Object.fromEntries(entries);
        const out = desktopEnv(source);
        for (const k of Object.keys(out)) {
          expect(allowed(k), `leaked ${k}`).toBe(true);
          expect(out[k]).toBe(source[k]);
        }
        for (const [k, v] of Object.entries(source)) {
          if (v === undefined) expect(k in out && Object.hasOwn(out, k)).toBe(false);
          else expect(Object.hasOwn(out, k)).toBe(allowed(k));
        }
        expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      }),
      params(),
    );
  });

  it('does not read inherited properties of the source, nor modify it', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(envName, fc.string({ maxLength: 6 })), { maxLength: 10 }), (entries) => {
        const proto = { PATH: '/inherited', ANTHROPIC_API_KEY: 'sk-inherited' };
        const source = Object.assign(Object.create(proto) as Record<string, string>, Object.fromEntries(entries));
        const before = JSON.stringify(source);
        const out = desktopEnv(source);
        if (!Object.hasOwn(source, 'PATH')) expect(out['PATH']).not.toBe('/inherited');
        expect(Object.hasOwn(out, 'ANTHROPIC_API_KEY')).toBe(false);
        expect(JSON.stringify(source)).toBe(before);
      }),
      params(),
    );
  });
});
