// Attack 9: bypass allowHosts (redirect, window.open, javascript:, data:, file:, credentials, IDN / punycode hosts, uppercase hosts, trailing dot).
// Layers under attack: checkNavigation (util), the fake driver, and the real Playwright driver against a hostile site.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkNavigation } from '@ai-bdd/sdk';
import type { Driver, DriverSession, Policy } from '@ai-bdd/sdk/contracts';
import { fakeDriver } from '@ai-bdd/testing';
import { playwright } from '@ai-bdd/driver-playwright';
import { playwrightUnavailableReason } from './helpers/kit.ts';
import { startHostileSite, type HostileSite } from './helpers/hostile-site.ts';

const policy: Policy = { allowHosts: ['localhost', '127.0.0.1', '[::1]', '*.example.com'], denyVerbs: [] };
const BASE = 'http://localhost:4173';

const denied: [string, string][] = [
  ['foreign host', 'https://evil.example/steal'],
  ['javascript: scheme', 'javascript:alert(1)'],
  ['javascript: with mixed case', 'JaVaScRiPt:alert(1)'],
  ['javascript: with embedded tab/newline', 'java\tscr\nipt:alert(1)'],
  ['javascript: with leading control chars and spaces', '\u0001  javascript:alert(1)'],
  ['data: scheme', 'data:text/html,<script>alert(1)</script>'],
  ['file: scheme', 'file:///etc/passwd'],
  ['file: scheme with allowed host in it', 'file://localhost/etc/passwd'],
  ['ftp: scheme', 'ftp://localhost/x'],
  ['blob: scheme', 'blob:http://localhost:4173/6f3a1f0e-0000-0000-0000-000000000000'],
  ['about:blank', 'about:blank'],
  ['view-source', 'view-source:http://localhost:4173/'],
  ['chrome://', 'chrome://settings'],
  ['ws: scheme', 'ws://localhost:4173/socket'],
  ['credentials', 'http://user:pw@localhost:4173/'],
  ['username only', 'http://admin@localhost:4173/'],
  ['empty password with username', 'http://admin:@localhost:4173/'],
  ['allowed host as the username of a foreign host', 'http://localhost@evil.example/'],
  ['allowed host as username with password', 'http://localhost:4173@evil.example/'],
  ['backslash before @', 'http://evil.example\\@localhost/'],
  ['allowed host as a subdomain label of a foreign host', 'http://localhost.evil.example/'],
  ['allowed host in the path', 'http://evil.example/localhost'],
  ['allowed host in the query', 'http://evil.example/?next=http://localhost/'],
  ['allowed host in the fragment', 'http://evil.example/#@localhost'],
  ['protocol-relative', '//evil.example/x'],
  ['protocol-relative with backslashes', '\\\\evil.example\\x'],
  ['uppercase foreign host', 'HTTP://EVIL.EXAMPLE/'],
  ['uppercase foreign host in allowed suffix', 'http://evil.EXAMPLE.com.evil.example/'],
  ['trailing dot on an allowed host', 'http://localhost./'],
  ['trailing dot on an allowed wildcard child', 'http://a.example.com./'],
  ['wildcard apex (subdomains only)', 'http://example.com/'],
  ['wildcard suffix without the dot', 'http://evilexample.com/'],
  ['wildcard suffix as prefix', 'http://a.example.com.evil.com/'],
  ['punycode lookalike', 'http://xn--localhost-9ve.example/'],
  ['cyrillic o homoglyph of localhost', 'http://lоcalhost/'],
  ['fullwidth foreign host', 'http://ｅｖｉｌ.example/'],
  ['IPv4-mapped IPv6 loopback not on the list', 'http://[::ffff:127.0.0.1]/'],
  ['another loopback address not on the list', 'http://127.0.0.2/'],
  ['public IP', 'http://93.184.216.34/'],
  ['zero address', 'http://0.0.0.0/'],
  ['garbage', 'http://'],
];

const allowed: [string, string][] = [
  ['plain localhost with port', 'http://localhost:4173/billing'],
  ['uppercase localhost', 'HTTP://LOCALHOST/x'],
  ['127.0.0.1', 'http://127.0.0.1:3000/'],
  ['IPv6 loopback', 'http://[::1]:3000/'],
  ['wildcard child', 'https://app.example.com/x'],
  ['wildcard grandchild', 'https://a.b.example.com/x'],
  ['relative path', '/settings/billing'],
  ['relative query', '?page=2'],
  ['decimal loopback is the same host as 127.0.0.1', 'http://2130706433/'],
  ['hex loopback is the same host as 127.0.0.1', 'http://0x7f.0.0.1/'],
];

describe('A9 R-AG3 checkNavigation', () => {
  for (const [label, url] of denied) {
    it(`A9 R-AG3: denies ${label}: ${JSON.stringify(url)}`, () => {
      const r = checkNavigation(url, BASE, policy);
      expect(r.ok, JSON.stringify(r)).toBe(false);
    });
  }
  for (const [label, url] of allowed) {
    it(`A9 R-AG3: allows ${label}: ${JSON.stringify(url)}`, () => {
      const r = checkNavigation(url, BASE, policy);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });
  }

  it('A9 R-AG3: with an empty allow list nothing, not even the base URL host, is allowed', () => {
    expect(checkNavigation('http://localhost:4173/', BASE, { allowHosts: [], denyVerbs: [] }).ok).toBe(false);
  });

  it('A9 R-AG3: a bare "*" or "*.com"-style entry is not a global allow (only "*.suffix" subdomain wildcards exist)', () => {
    expect(checkNavigation('https://evil.example/', BASE, { allowHosts: ['*'], denyVerbs: [] }).ok).toBe(false);
    expect(checkNavigation('https://evil.example/', BASE, { allowHosts: ['*.'], denyVerbs: [] }).ok).toBe(false);
    expect(checkNavigation('https://evil.example/', BASE, { allowHosts: ['**'], denyVerbs: [] }).ok).toBe(false);
  });

  it('A9 R-AG3: an allow-list entry is compared case-insensitively but never as a prefix or substring', () => {
    const p: Policy = { allowHosts: ['LocalHost'], denyVerbs: [] };
    expect(checkNavigation('http://localhost/', BASE, p).ok).toBe(true);
    expect(checkNavigation('http://localhostx/', BASE, p).ok).toBe(false);
    expect(checkNavigation('http://xlocalhost/', BASE, p).ok).toBe(false);
  });

  it('A9 R-AG3: the returned URL is the normalized one that was checked (no second parse can disagree)', () => {
    const r = checkNavigation('HTTP://LOCALHOST:80/a/../b?x=1#f', BASE, policy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(new URL(r.url).hostname).toBe('localhost');
      expect(r.url).toBe(new URL(r.url).toString());
    }
  });
});

describe('A9 R-AG3 the fake driver enforces the same policy', () => {
  async function session(): Promise<{ s: DriverSession; d: Driver }> {
    const factory = fakeDriver({});
    const dir = mkdtempSync(join(tmpdir(), 'a9-'));
    const d = await factory.create({ projectRoot: dir, baseURL: BASE, policy, artifactsDir: dir });
    rmSync(dir, { recursive: true, force: true });
    const s = await d.openSession({ scenarioId: 'a9', baseURL: BASE, policy, resolveValue: () => '' });
    return { s, d };
  }

  it('A9 R-AG3: every denied URL is refused with POLICY_DENIED and leaves the page where it was', async () => {
    const { s, d } = await session();
    expect((await s.perform({ verb: 'navigate', url: '/settings/billing' })).ok).toBe(true);
    const before = (await s.observe()).route;
    for (const [label, url] of denied) {
      const out = await s.perform({ verb: 'navigate', url });
      expect(out.ok, label).toBe(false);
      expect(['POLICY_DENIED', 'TARGET_NOT_FOUND', 'DRIVER_ERROR'], `${label}: ${JSON.stringify(out.error)}`).toContain(out.error?.code);
      expect((await s.observe()).route, label).toBe(before);
    }
    await s.close();
    await d.dispose();
  });

  it('A9 R-AG3: the app-level open redirect (/__redirect?to=...) is checked at every hop', async () => {
    const { s, d } = await session();
    for (const to of ['https://evil.example/steal', 'javascript:alert(1)', 'http://user:pw@localhost/', '//evil.example/x']) {
      const out = await s.perform({ verb: 'navigate', url: `/__redirect?to=${encodeURIComponent(to)}` });
      expect(out.ok, to).toBe(false);
      expect(out.error?.code, to).toBe('POLICY_DENIED');
    }
    // a chain of redirects that ends on an allowed page is fine
    const ok = await s.perform({ verb: 'navigate', url: `/__redirect?to=${encodeURIComponent('/__redirect?to=%2Fsettings%2Fbilling')}` });
    expect(ok.ok).toBe(true);
    await s.close();
    await d.dispose();
  });

  it('A9 R-AG3: denyVerbs is enforced by the driver even when a caller bypasses the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a9-'));
    const p: Policy = { ...policy, denyVerbs: ['navigate', 'fill'] };
    const d = await fakeDriver({}).create({ projectRoot: dir, baseURL: BASE, policy: p, artifactsDir: dir });
    const s = await d.openSession({ scenarioId: 'a9', baseURL: BASE, policy: p, resolveValue: () => '' });
    expect((await s.perform({ verb: 'navigate', url: '/login' })).error?.code).toBe('POLICY_DENIED');
    await s.close();
    await d.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
});

const skip = playwrightUnavailableReason();

describe.skipIf(skip !== null)(`A9 R-AG3 the Playwright driver against a hostile site${skip === null ? '' : ` (skipped: ${skip})`}`, () => {
  let site: HostileSite;
  let driver: Driver;
  let tmp: string;
  const pwPolicy: Policy = { allowHosts: ['localhost', '127.0.0.1', '[::1]'], denyVerbs: [] };

  beforeAll(async () => {
    site = await startHostileSite();
    tmp = mkdtempSync(join(tmpdir(), 'a9pw-'));
    driver = await playwright({ browser: 'chromium', headless: true }).create({ projectRoot: tmp, baseURL: site.origin, policy: pwPolicy, artifactsDir: tmp });
  }, 60_000);

  afterAll(async () => {
    await driver?.dispose();
    await site?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  async function open(path: string): Promise<DriverSession> {
    site.reset();
    const s = await driver.openSession({ scenarioId: 'a9pw', baseURL: site.origin, policy: pwPolicy, resolveValue: () => '' });
    const nav = await s.perform({ verb: 'navigate', url: `${site.origin}${path}` });
    expect(nav.ok, `${path}: ${JSON.stringify(nav.error)}`).toBe(true);
    return s;
  }

  const settle = (ms = 900): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Click the first node whose name matches, then wait. Returns the final observation. */
  async function clickAndWait(s: DriverSession, name: string): Promise<{ outcomeOk: boolean; code: string | undefined; url: string }> {
    const obs = await s.observe();
    const node = obs.nodes.find((n) => n.name === name && (n.role === 'link' || n.role === 'button'));
    expect(node, `node "${name}" in ${obs.treeText}`).toBeDefined();
    const out = await s.perform({ verb: 'click', target: { ref: (node as { ref: string }).ref } });
    await settle();
    const after = await s.observe();
    return { outcomeOk: out.ok, code: out.error?.code, url: after.url ?? '' };
  }

  const hostHostile = (url: string): boolean => {
    try {
      return new URL(url).hostname.startsWith('evil.');
    } catch {
      return false;
    }
  };

  const clicks: [string, string, string][] = [
    ['a link to the foreign origin', '/evil-link', 'Evil link'],
    ['a link with an upper case foreign host', '/upper-link', 'Upper link'],
    ['a target=_blank link to the foreign origin', '/blank-link', 'Evil blank link'],
    ['a javascript: link that assigns location', '/js-link', 'Evil script link'],
    ['window.open to the foreign origin', '/open', 'Open popup'],
    ['window.open into a named window after about:blank', '/open-named', 'Open named popup'],
    ['a form that POSTs to the foreign origin', '/form', 'Send'],
    ['a data: link', '/data-link', 'Data link'],
    ['a file: link', '/file-link', 'File link'],
    ['a link with credentials in the URL', '/creds-link', 'Credentials link'],
    ['a trailing-dot host link', '/dot-link', 'Trailing dot link'],
    ['a cyrillic homoglyph host link', '/idn-link', 'Cyrillic localhost link'],
  ];
  for (const [label, path, name] of clicks) {
    it(`A9 R-AG3: ${label}: the foreign origin never receives a request and the session stays on an allowed host`, async () => {
      const s = await open(path);
      const res = await clickAndWait(s, name);
      expect(site.evilHits(), `${label}: hits ${JSON.stringify(site.evilHits())}`).toEqual([]);
      expect(hostHostile(res.url), `session url ${res.url}`).toBe(false);
      // the document the session sits on is not the foreign page
      const obs = await s.observe();
      expect(obs.nodes.some((n) => n.name === 'EVIL' || n.name === 'DATA'), obs.treeText).toBe(false);
      await s.close();
    }, 30_000);
  }

  const automatic: [string, string][] = [
    ['a 302 redirect to the foreign origin', '/redirect302'],
    ['a 301 redirect chain ending on the foreign origin', '/redirect-chain'],
    ['a 307 redirect to the foreign origin', '/redirect-307'],
    ['a meta refresh to the foreign origin', '/meta'],
    ['a timer assigning location.href', '/timer'],
  ];
  for (const [label, path] of automatic) {
    it(`A9 R-AG3: ${label}: the foreign origin never receives a request`, async () => {
      site.reset();
      const s = await driver.openSession({ scenarioId: 'a9pw', baseURL: site.origin, policy: pwPolicy, resolveValue: () => '' });
      const out = await s.perform({ verb: 'navigate', url: `${site.origin}${path}` });
      await settle(1200);
      const obs = await s.observe();
      expect(site.evilHits(), `${label}: ${JSON.stringify(out)} ${JSON.stringify(site.evilHits())}`).toEqual([]);
      expect(hostHostile(obs.url ?? ''), `session url ${obs.url}`).toBe(false);
      expect(obs.nodes.some((n) => n.name === 'EVIL')).toBe(false);
      await s.close();
    }, 30_000);
  }

  it('A9 R-AG3: navigating the driver itself to each denied URL form is refused before any request leaves the browser', async () => {
    const s = await open('/ok');
    for (const url of [site.evil + '/steal', `${site.evil}/steal`.toUpperCase(), `http://user:pw@localhost:${site.port}/ok`, 'javascript:alert(1)', 'data:text/html,<h1>DATA</h1>', 'file:///etc/passwd', `http://localhost.:${site.port}/ok`]) {
      const out = await s.perform({ verb: 'navigate', url });
      expect(out.ok, url).toBe(false);
      expect(out.error?.code, url).toBe('POLICY_DENIED');
    }
    expect(site.evilHits()).toEqual([]);
    expect((await s.observe()).route).toBe('/ok');
    await s.close();
  }, 30_000);

  it('A9 R-AG3: request() through the session is checked the same way (absolute foreign URL, redirect to a foreign host)', async () => {
    const s = await open('/ok');
    await expect(s.request?.({ method: 'GET', path: `${site.evil}/steal` }) ?? Promise.reject(new Error('no request()'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(s.request?.({ method: 'GET', path: `/redirect302?to=${encodeURIComponent(site.evil + '/steal')}` }) ?? Promise.reject(new Error('no request()'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(site.evilHits()).toEqual([]);
    await s.close();
  }, 30_000);

  it('A9 R-AG3 (documented scope): sub-frame content from a non-allow-listed origin IS fetched and does appear in observations; the policy covers top-level navigations and popups only', async () => {
    const s = await open('/iframe');
    await settle(800);
    const obs = await s.observe();
    // Pins the current behaviour so that docs/security.md and this test stay in step (see docs/adversarial-findings.md, O-1).
    expect({ fetched: site.evilHits().length > 0, visible: obs.nodes.some((n) => n.name === 'EVIL') }).toEqual({ fetched: true, visible: true });
    await s.close();
  }, 30_000);
});
