import { describe, expect, it } from 'vitest';
import {
  buildPreviewDocument,
  parsePreviewContracts,
  samplePreviewContract,
} from '../shared/preview.ts';

describe('isolated code preview', () => {
  it('places network and form restrictions before authored HTML', () => {
    const html = buildPreviewDocument(
      {
        'index.html': '<html><body><h1>Hello</h1></body></html>',
        'script.js': 'console.log("ready")',
      },
      'index.html',
      'channel',
    );
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(
      html.indexOf('<h1>Hello</h1>'),
    );
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("frame-src 'none'");
    expect(html).toContain('No preview contract for ');
    expect(html).not.toContain('allow-same-origin');
  });
  it('rejects absent entries and oversized file sets', () => {
    expect(() => buildPreviewDocument({}, 'index.html', 'test')).toThrow(
      'existing HTML',
    );
    const files = Object.fromEntries(
      Array.from({ length: 51 }, (_, i) => [`${i}.html`, '']),
    );
    expect(() => buildPreviewDocument(files, '0.html', 'test')).toThrow(
      '50 file',
    );
  });
  it('embeds only validated contract fixtures and escapes script terminators', () => {
    const fixture = structuredClone(samplePreviewContract);
    fixture.interactions[0]!.response.body = {
      title: '</script><script>attack()</script>',
    };
    const html = buildPreviewDocument(
      {
        'index.html': '<h1>Hello</h1>',
        'contracts.json': JSON.stringify(fixture),
        'script.js': 'console.log("</script>")',
      },
      'index.html',
      'test',
    );
    expect(html).not.toContain('<script>attack()');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html).toContain('console.log("<\\/script>")');
  });
  it('rejects invalid status, paths, headers and bodies', () => {
    const fixture = () => structuredClone(samplePreviewContract);
    const badStatus = fixture();
    badStatus.interactions[0]!.response.status = 700;
    expect(() => parsePreviewContracts(JSON.stringify(badStatus))).toThrow();
    const badPath = fixture();
    badPath.interactions[0]!.request.path = 'https://private.invalid/';
    expect(() => parsePreviewContracts(JSON.stringify(badPath))).toThrow();
    const badHeaders = fixture();
    badHeaders.interactions[0]!.response.headers = {
      'Content-Type': 'text/html\r\nInjected: true',
    };
    expect(() => parsePreviewContracts(JSON.stringify(badHeaders))).toThrow(
      'line breaks',
    );
    const badBody = fixture();
    badBody.interactions[0]!.response.status = 204;
    expect(() => parsePreviewContracts(JSON.stringify(badBody))).toThrow(
      'must not contain a body',
    );
  });
  it('accepts a Pact v2 fixture and optional query/body matching', () => {
    const fixture = structuredClone(samplePreviewContract);
    fixture.interactions[0]!.request.query = { tag: ['design', 'test'] };
    fixture.interactions[0]!.request.body = { title: 'Project' };
    expect(parsePreviewContracts(JSON.stringify(fixture))).toEqual(fixture);
    expect(parsePreviewContracts(undefined)).toBeNull();
  });
});
