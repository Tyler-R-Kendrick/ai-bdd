import { describe, expect, it } from 'vitest';
import type { Policy } from '../../src/contracts/index.ts';
import { checkNavigation } from '../../src/util/index.ts';

const policy = (...allowHosts: string[]): Policy => ({ allowHosts, denyVerbs: [] });

describe('checkNavigation: accepted URLs', () => {
  it('accepts http and https on an allowed host and returns the normalized URL', () => {
    expect(checkNavigation('https://app.test/a?b=1#c', undefined, policy('app.test'))).toEqual({ ok: true, url: 'https://app.test/a?b=1#c' });
    expect(checkNavigation('http://app.test', undefined, policy('app.test'))).toEqual({ ok: true, url: 'http://app.test/' });
    expect(checkNavigation('HTTPS://App.TEST:8443/Path', undefined, policy('app.test'))).toEqual({ ok: true, url: 'https://app.test:8443/Path' });
  });

  it('resolves a relative URL against the base URL', () => {
    expect(checkNavigation('/x?y=1', 'https://app.test/base/', policy('app.test'))).toEqual({ ok: true, url: 'https://app.test/x?y=1' });
    expect(checkNavigation('rel', 'https://app.test/dir/', policy('app.test'))).toEqual({ ok: true, url: 'https://app.test/dir/rel' });
  });

  it('lets an absolute URL win over the base URL, and judges the host of the result', () => {
    expect(checkNavigation('https://a.test/p', 'https://b.test/', policy('a.test'))).toEqual({ ok: true, url: 'https://a.test/p' });
    expect(checkNavigation('https://a.test/p', 'https://b.test/', policy('b.test'))).toEqual({ ok: false, reason: 'host a.test not in allowHosts' });
    expect(checkNavigation('//c.test/p', 'https://b.test/', policy('c.test'))).toEqual({ ok: true, url: 'https://c.test/p' });
  });
});

describe('checkNavigation: refusals', () => {
  it('refuses what is not a URL', () => {
    expect(checkNavigation('not a url', undefined, policy('app.test'))).toEqual({ ok: false, reason: 'invalid URL' });
    expect(checkNavigation('/relative', undefined, policy('app.test'))).toEqual({ ok: false, reason: 'invalid URL' });
    expect(checkNavigation('', undefined, policy('app.test'))).toEqual({ ok: false, reason: 'invalid URL' });
    expect(checkNavigation('/x', 'not a base', policy('app.test'))).toEqual({ ok: false, reason: 'invalid URL' });
  });

  it('refuses every scheme but http and https, naming it with its colon', () => {
    for (const [url, scheme] of [
      ['javascript:alert(1)', 'javascript:'],
      ['ftp://app.test/', 'ftp:'],
      ['file:///etc/passwd', 'file:'],
      ['data:text/html,x', 'data:'],
      ['ws://app.test/', 'ws:'],
      ['blob:https://app.test/uuid', 'blob:'],
    ] as const) {
      expect(checkNavigation(url, undefined, policy('app.test', ''))).toEqual({ ok: false, reason: `scheme ${scheme} not allowed` });
    }
  });

  it('refuses credentials in the URL, user name only, password only, or both', () => {
    for (const url of ['https://user@app.test/', 'https://:secret@app.test/', 'https://user:secret@app.test/']) {
      expect(checkNavigation(url, undefined, policy('app.test'))).toEqual({ ok: false, reason: 'credentials in URL not allowed' });
    }
  });

  it('checks the scheme before the credentials and the credentials before the host', () => {
    expect(checkNavigation('ftp://u:p@evil.test/', undefined, policy('app.test'))).toEqual({ ok: false, reason: 'scheme ftp: not allowed' });
    expect(checkNavigation('https://u:p@evil.test/', undefined, policy('app.test'))).toEqual({ ok: false, reason: 'credentials in URL not allowed' });
  });

  it('refuses a host that is not allowed, naming the lowercased host, and everything when the list is empty', () => {
    expect(checkNavigation('https://Evil.Test/x', undefined, policy('app.test'))).toEqual({ ok: false, reason: 'host evil.test not in allowHosts' });
    expect(checkNavigation('https://app.test/', undefined, policy())).toEqual({ ok: false, reason: 'host app.test not in allowHosts' });
  });
});

describe('checkNavigation: host allow-list', () => {
  const ok = (url: string, ...hosts: string[]): boolean => checkNavigation(url, undefined, policy(...hosts)).ok;

  it('matches an exact host only, case-insensitively on both sides', () => {
    expect(ok('https://app.test/', 'app.test')).toBe(true);
    expect(ok('https://APP.test/', 'app.test')).toBe(true);
    expect(ok('https://app.test/', 'APP.Test')).toBe(true);
    expect(ok('https://sub.app.test/', 'app.test')).toBe(false);
    expect(ok('https://app.test.evil.test/', 'app.test')).toBe(false);
    expect(ok('https://xapp.test/', 'app.test')).toBe(false);
  });

  it('ignores the port of the URL and does not match an entry that has one', () => {
    expect(ok('http://app.test:8080/', 'app.test')).toBe(true);
    expect(ok('http://app.test:8080/', 'app.test:8080')).toBe(false);
  });

  it('matches *.suffix against subdomains of any depth, not against the bare domain or a look-alike', () => {
    expect(ok('https://a.example.test/', '*.example.test')).toBe(true);
    expect(ok('https://a.b.example.test/', '*.example.test')).toBe(true);
    expect(ok('https://A.Example.TEST/', '*.EXAMPLE.test')).toBe(true);
    expect(ok('https://example.test/', '*.example.test')).toBe(false);
    expect(ok('https://badexample.test/', '*.example.test')).toBe(false);
    expect(ok('https://example.test.evil.test/', '*.example.test')).toBe(false);
    expect(ok('https://a.example.test.evil/', '*.example.test')).toBe(false);
  });

  it('treats a bare * and a * inside an entry literally', () => {
    expect(ok('https://a.test/', '*')).toBe(false);
    expect(ok('https://a.test/', 'a.*')).toBe(false);
  });

  it('allows a host when any entry matches', () => {
    expect(ok('https://b.test/', 'a.test', '*.c.test', 'b.test')).toBe(true);
    expect(ok('https://x.c.test/', 'a.test', '*.c.test', 'b.test')).toBe(true);
    expect(ok('https://d.test/', 'a.test', '*.c.test', 'b.test')).toBe(false);
  });
});
