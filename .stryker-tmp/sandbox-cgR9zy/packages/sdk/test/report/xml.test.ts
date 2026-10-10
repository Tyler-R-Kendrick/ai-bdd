// @ts-nocheck
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RunReport } from '../../src/contracts/index.ts';
import { renderJunit } from '../../src/report/junit.ts';
import { isXmlChar, xmlAttr, xmlText } from '../../src/report/xml.ts';
import { checkXml, findAll } from './xml-check.ts';
import { fixtureReport } from './fixtures/run.ts';

/** What escaping is expected to preserve: everything except characters XML 1.0 cannot carry. */
function sanitized(s: string): string {
  let out = '';
  for (const ch of s) out += isXmlChar(ch.codePointAt(0) ?? 0) ? ch : '�';
  return out;
}

const codeUnits = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 40 }).map((a) => String.fromCharCode(...a));
const anyString = fc.oneof(fc.string({ unit: 'binary', maxLength: 40 }), codeUnits, fc.string({ maxLength: 40 }));

describe('xml well-formedness checker (test helper)', () => {
  it('accepts well-formed documents and decodes references', () => {
    const res = checkXml('<?xml version="1.0"?><a x="1 &lt; 2"><!-- c --><b/>t&amp;&#65;&#x42;<![CDATA[<raw>]]></a>');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.root.attrs['x']).toBe('1 < 2');
      expect(res.root.text).toBe('t&AB<raw>');
      expect(findAll(res.root, 'b')).toHaveLength(1);
    }
  });

  it.each([
    ['mismatched tags', '<a><b></a></b>'],
    ['unclosed element', '<a><b/>'],
    ['two roots', '<a/><b/>'],
    ['text outside root', '<a/>junk'],
    ['bare ampersand', '<a>x & y</a>'],
    ['unknown entity', '<a>&nbsp;</a>'],
    ['lt in attribute', '<a x="<"/>'],
    ['unquoted attribute', '<a x=1/>'],
    ['duplicate attribute', '<a x="1" x="2"/>'],
    ['control character', '<a>\u0001</a>'],
    ['char reference to control', '<a>&#1;</a>'],
    ['cdata end in text', '<a>]]></a>'],
    ['empty input', ''],
  ])('rejects %s', (_label, xml) => {
    expect(checkXml(xml).ok).toBe(false);
  });
});

describe('xml escaping', () => {
  it('property: xmlText output is well-formed element content and round-trips (modulo invalid characters)', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const res = checkXml(`<r>${xmlText(s)}</r>`);
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.root.text).toBe(sanitized(s));
      }),
      { numRuns: 300 },
    );
  });

  it('property: xmlAttr output is a well-formed attribute value that round-trips in both quote styles', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        for (const q of ['"', "'"]) {
          const res = checkXml(`<r a=${q}${xmlAttr(s)}${q}/>`);
          expect(res.ok).toBe(true);
          if (res.ok) expect(res.root.attrs['a']).toBe(sanitized(s));
        }
      }),
      { numRuns: 300 },
    );
  });

  it('property: the JUnit document stays well-formed whatever strings appear in titles, ids, messages and step text', () => {
    fc.assert(
      fc.property(anyString, anyString, anyString, (title, featureId, message) => {
        const base = fixtureReport.scenarios[3] as RunReport['scenarios'][number];
        const report: RunReport = {
          ...fixtureReport,
          startedAt: title,
          scenarios: [
            {
              ...base,
              title,
              featureId,
              error: { code: 'CHECK_FAILED', message, retryable: false },
              steps: base.steps.map((st) => ({ ...st, text: message, error: st.error === undefined ? undefined : { ...st.error, message } })) as typeof base.steps,
            },
          ],
        };
        const res = checkXml(renderJunit(report));
        expect(res.ok).toBe(true);
        if (res.ok) {
          const tc = findAll(res.root, 'testcase')[0];
          expect(tc?.attrs['name']).toBe(sanitized(title));
          expect(tc?.attrs['classname']).toBe(sanitized(featureId));
        }
      }),
      { numRuns: 150 },
    );
  });

  it('never emits a character XML 1.0 forbids', () => {
    const all = Array.from({ length: 0x2100 }, (_, i) => String.fromCharCode(i)).join('') + '￾￿𐀀';
    const out = xmlText(all) + xmlAttr(all);
    for (const ch of out) expect(isXmlChar(ch.codePointAt(0) ?? 0)).toBe(true);
  });
});
