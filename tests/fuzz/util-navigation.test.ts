import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkNavigation } from '@ai-bdd/sdk';
import type { Policy } from '@ai-bdd/sdk/contracts';
import { hostileString, params } from './helpers.ts';

const POLICY: Policy = { allowHosts: ['localhost', '127.0.0.1', '[::1]', 'App.Example.com', '*.example.org'], denyVerbs: [] };
const ALLOW = POLICY.allowHosts.map((h) => h.toLowerCase());

function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ALLOW.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) : h === a));
}

/**
 * Second, independent reading of a *normalized* URL (no userinfo, no backslashes, no tabs): scheme://host[:port][/?#...].
 * checkNavigation hands this string to the browser, so any parser must agree on the host.
 */
function authorityHost(url: string): string {
  const m = /^(https?):\/\/([^/?#\\@]*)/i.exec(url);
  if (m === null) throw new Error(`not a normalized http(s) URL: ${url}`);
  const authority = m[2] as string;
  if (authority.startsWith('[')) return authority.slice(0, authority.indexOf(']') + 1);
  const colon = authority.indexOf(':');
  return colon < 0 ? authority : authority.slice(0, colon);
}

function expectContract(raw: string, base: string | undefined): void {
  const verdict = checkNavigation(raw, base, POLICY);
  if (!verdict.ok) {
    expect(typeof verdict.reason).toBe('string');
    expect(verdict.reason.length).toBeGreaterThan(0);
    return;
  }
  // The verdict is defined by WHATWG URL semantics: re-derive it with `new URL` and compare.
  const u = base === undefined ? new URL(raw) : new URL(raw, base);
  expect(['http:', 'https:']).toContain(u.protocol);
  expect(u.username).toBe('');
  expect(u.password).toBe('');
  expect(hostAllowed(u.hostname)).toBe(true);
  expect(verdict.url).toBe(u.toString());
  // The URL that is handed to the browser is a fixed point and names the same host to an independent reader.
  const again = new URL(verdict.url);
  expect(again.toString()).toBe(verdict.url);
  expect(again.hostname).toBe(u.hostname);
  expect(hostAllowed(authorityHost(verdict.url))).toBe(true);
  expect(authorityHost(verdict.url).toLowerCase()).toBe(u.hostname.toLowerCase());
  const second = checkNavigation(verdict.url, undefined, POLICY);
  expect(second).toEqual({ ok: true, url: verdict.url });
}

describe('fuzz: checkNavigation', () => {
  it('differential against WHATWG URL: an allowed verdict always means a http(s) URL, no credentials, hostname in allowHosts (random strings)', () => {
    fc.assert(
      fc.property(fc.oneof(hostileString({ maxLength: 120 }), fc.webUrl({ withFragments: true, withQueryParameters: true }), fc.string()), fc.constantFrom(undefined, 'http://localhost:3000', 'https://app.example.com/base/'), (raw, base) => {
        expectContract(raw, base);
      }),
      params(),
    );
  });

  // Hosts spelled in ways that WHATWG URL normalizes to an allowed host, and hosts that merely look allowed.
  const allowedSpellings = [
    'localhost', 'LOCALHOST', 'LocalHost', '%6cocalhost', '%6Cocal%68ost', 'ｌｏｃａｌｈｏｓｔ', 'ⓛocalhost', 'lo\tcal\nhost',
    '127.0.0.1', '127.1', '0x7f.0.0.1', '0177.0.0.1', '2130706433', '0x7f000001', '127.0.0.01',
    '[::1]', '[0:0:0:0:0:0:0:1]', '[::0001]', '[0::1]', '[0000:0000:0000:0000:0000:0000:0000:0001]',
    'app.example.com', 'APP.EXAMPLE.COM', 'a%70p.example.com', 'x.example.org', 'X.EXAMPLE.ORG', 'a.b.example.org',
  ];
  const lookalikes = [
    'localhost.', 'localhost.evil.com', 'evil-localhost', 'xlocalhost', 'localhost%2eevil.com', 'localhost。evil.com', 'example.org', 'evil-example.org',
    'a.example.org.evil.com', '128.0.0.1', '127.0.0.2', '[::2]', '[::1]x', 'app.example.com.evil.net', 'evilapp.example.com', 'xn--localhost-9ua',
    'localhost%00', '', '.', 'example.org.',
  ];
  const evil = ['evil.com', 'attacker.example.net', '1.2.3.4', '[2001:db8::1]', 'EVIL.COM', 'xn--e1afmkfd.xn--p1ai'];
  const scheme = fc.constantFrom('http', 'https', 'HTTP', 'HtTpS');
  const port = fc.oneof(fc.constant(''), fc.integer({ min: 0, max: 65535 }).map((n) => `:${n}`), fc.constant(':'));
  const tail = fc.oneof(fc.constant(''), fc.constantFrom('/', '/a/b', '/?q=1', '#frag', '/..;/x', '/%2e%2e/x', '?x=@evil.com', '/\\evil.com'));

  it('a known-allowed host spelling is allowed with any scheme case, port and path; a lookalike host never is', () => {
    fc.assert(
      fc.property(scheme, fc.constantFrom(...allowedSpellings), port, tail, (s, host, p, t) => {
        const raw = `${s}://${host}${p}${t}`;
        expect(checkNavigation(raw, undefined, POLICY).ok, raw).toBe(true);
        expectContract(raw, undefined);
      }),
      params(),
    );
    fc.assert(
      fc.property(scheme, fc.constantFrom(...lookalikes), port, tail, (s, host, p, t) => {
        const raw = `${s}://${host}${p}${t}`;
        expect(checkNavigation(raw, undefined, POLICY).ok, raw).toBe(false);
      }),
      params(),
    );
  });

  it('userinfo, backslash, ? and # tricks: the host is whatever the authority really says, never the allowed name hidden elsewhere', () => {
    const trick = fc.record({
      s: scheme,
      allowed: fc.constantFrom(...allowedSpellings.filter((h) => !/[\t\n]/.test(h))),
      bad: fc.constantFrom(...evil),
      sep: fc.constantFrom('@', ':pw@', ':@', '\\@', '/@', '?@', '#@', '\\', '/', '?', '#', ' @', '%40', '∕', '／', '\\\\', '\t@'),
      outerFirst: fc.boolean(),
    });
    fc.assert(
      fc.property(trick, ({ s, allowed, bad, sep, outerFirst }) => {
        const raw = outerFirst ? `${s}://${allowed}${sep}${bad}/x` : `${s}://${bad}${sep}${allowed}/x`;
        const verdict = checkNavigation(raw, undefined, POLICY);
        // Never allowed when the actual host is the evil one or when credentials are present.
        const u = (() => {
          try {
            return new URL(raw);
          } catch {
            return undefined;
          }
        })();
        if (verdict.ok) {
          expect(u).toBeDefined();
          expect(hostAllowed((u as URL).hostname)).toBe(true);
          expect((u as URL).username + (u as URL).password).toBe('');
        }
        // Authority terminators make the real host the part before them.
        if (!outerFirst && ['\\', '/', '?', '#', '\\\\'].includes(sep)) expect(verdict.ok, raw).toBe(false);
        if (outerFirst && ['\\', '/', '?', '#', '\\\\'].includes(sep)) expect(verdict.ok, raw).toBe(allowedSpellings.includes(allowed));
        // Anything before an @ is userinfo: it is either denied as credentials or names an evil host.
        if (sep.includes('@') && !sep.startsWith(' ') && sep !== '%40') {
          const hasAt = u !== undefined && (u.username !== '' || u.password !== '');
          if (hasAt) expect(verdict.ok, raw).toBe(false);
        }
        expectContract(raw, undefined);
      }),
      params(),
    );
  });

  it('relative and scheme-relative references resolve against baseURL: only same-host paths are allowed', () => {
    const base = 'http://localhost:3000/app/index.html';
    const hostile = fc.constantFrom('//', '\\\\', '/\\', '\\/', '///', '/\t/', '/\n/', '\r//', '////');
    fc.assert(
      fc.property(hostile, fc.constantFrom(...evil), fc.constantFrom('', '/x', '?q', '#h', '/..'), (prefix, host, rest) => {
        expect(checkNavigation(`${prefix}${host}${rest}`, base, POLICY).ok, `${prefix}${host}${rest}`).toBe(false);
      }),
      params(),
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9._~/-]{0,30}$/), fc.constantFrom('', '?a=b', '#frag'), (path, qs) => {
        const raw = path.startsWith('/') && path.startsWith('//') ? `/${path.replace(/^\/+/, '')}` : path;
        const v = checkNavigation(`${raw}${qs}`, base, POLICY);
        // Path-only references never leave the base host. (A first segment containing ':' would read as a scheme; the alphabet excludes it.)
        expect(v.ok, raw).toBe(true);
        if (v.ok) expect(new URL(v.url).host).toBe('localhost:3000');
      }),
      params(),
    );
  });

  it('non-http(s) schemes, credentials and malformed URLs are rejected with a reason, never thrown', () => {
    const schemes = ['javascript', 'data', 'file', 'ftp', 'ws', 'wss', 'blob', 'about', 'chrome', 'view-source', 'mailto', 'http\u0000', '\u0000http', ' http', 'ht tp', 'JaVaScRiPt'];
    fc.assert(
      fc.property(fc.constantFrom(...schemes), fc.constantFrom('localhost', '//localhost', '//localhost/x', 'alert(1)', ',x', '//evil.com'), (sch, rest) => {
        const raw = `${sch}:${rest}`;
        const v = checkNavigation(raw, undefined, POLICY);
        // ' http://...' with leading spaces would be trimmed by WHATWG; only the explicit schemes below may pass
        if (v.ok) expect(['http:', 'https:']).toContain(new URL(v.url).protocol);
      }),
      params(),
    );
    fc.assert(
      fc.property(fc.constantFrom('localhost', '127.0.0.1', '[::1]'), fc.stringMatching(/^[a-z0-9:%]{0,8}$/), fc.stringMatching(/^[a-z0-9:%]{0,8}$/), (host, user, pass) => {
        const creds = pass === '' ? user : `${user}:${pass}`;
        const raw = `http://${creds}@${host}/`;
        const v = checkNavigation(raw, undefined, POLICY);
        const u = new URL(raw);
        expect(v.ok).toBe(u.username === '' && u.password === '');
      }),
      params(),
    );
  });

  it('IPv6 literals and bracket tricks never admit a host outside allowHosts', () => {
    const v6 = fc.oneof(
      fc.array(fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16)), { minLength: 1, maxLength: 8 }).map((g) => `[${g.join(':')}]`),
      fc.constantFrom('[::1]', '[::]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]', '[fe80::1%25eth0]', '[::1', '::1]', '[::1]]', '[[::1]]', '[::1]:80', '[::1]:', '[::1]x'),
    );
    fc.assert(
      fc.property(v6, port, (host, p) => {
        const raw = `http://${host}${p}/`;
        expectContract(raw, undefined);
      }),
      params(),
    );
  });
});
