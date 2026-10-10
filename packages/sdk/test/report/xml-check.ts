/**
 * A tiny XML 1.0 well-formedness checker for tests (no dependencies). It covers the subset the JUnit reporter emits:
 * prolog, elements, attributes, character data, entity/char references, comments, CDATA. No DTDs or namespaces.
 */
export interface XmlElement { name: string; attrs: Record<string, string>; children: XmlElement[]; text: string }
export type XmlCheck = { ok: true; root: XmlElement } | { ok: false; error: string };

const NAME_START = /[A-Za-z_:À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/;

function validChar(cp: number): boolean {
  return cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

class Fail extends Error {}

class Parser {
  private i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  private fail(msg: string): never {
    const upTo = this.s.slice(0, this.i);
    const line = upTo.split('\n').length;
    throw new Fail(`${msg} (offset ${this.i}, line ${line})`);
  }

  private startsWith(t: string): boolean {
    return this.s.startsWith(t, this.i);
  }

  private skipWs(): boolean {
    const start = this.i;
    while (this.i < this.s.length && /[ \t\r\n]/.test(this.s[this.i] as string)) this.i++;
    return this.i > start;
  }

  private name(): string {
    const c = this.s[this.i];
    if (c === undefined || !NAME_START.test(c)) this.fail('expected a name');
    const start = this.i++;
    while (this.i < this.s.length && NAME_CHAR.test(this.s[this.i] as string)) this.i++;
    return this.s.slice(start, this.i);
  }

  /** Decode references in `raw`; reject bare `&`. */
  private decode(raw: string, inAttr: boolean): string {
    let out = '';
    for (let k = 0; k < raw.length; k++) {
      const ch = raw[k] as string;
      if (ch === '<' && inAttr) this.fail('"<" not allowed in attribute value');
      if (ch !== '&') {
        out += ch;
        continue;
      }
      const semi = raw.indexOf(';', k);
      if (semi < 0) this.fail('unterminated reference');
      const ref = raw.slice(k + 1, semi);
      k = semi;
      if (ref === 'amp') out += '&';
      else if (ref === 'lt') out += '<';
      else if (ref === 'gt') out += '>';
      else if (ref === 'quot') out += '"';
      else if (ref === 'apos') out += "'";
      else if (/^#[0-9]+$/.test(ref) || /^#x[0-9A-Fa-f]+$/.test(ref)) {
        const cp = ref.startsWith('#x') ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        if (!validChar(cp)) this.fail(`character reference to invalid char ${cp}`);
        out += String.fromCodePoint(cp);
      } else this.fail(`unknown entity &${ref};`);
    }
    return out;
  }

  private checkChars(text: string): void {
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (!validChar(cp)) this.fail(`invalid XML character U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }

  private misc(): void {
    for (;;) {
      this.skipWs();
      if (this.startsWith('<!--')) {
        const end = this.s.indexOf('-->', this.i + 4);
        if (end < 0) this.fail('unterminated comment');
        const body = this.s.slice(this.i + 4, end);
        if (body.includes('--') || body.endsWith('-')) this.fail('"--" not allowed inside comment');
        this.i = end + 3;
      } else if (this.startsWith('<?')) {
        const end = this.s.indexOf('?>', this.i + 2);
        if (end < 0) this.fail('unterminated processing instruction');
        this.i = end + 2;
      } else return;
    }
  }

  private element(): XmlElement {
    if (this.s[this.i] !== '<') this.fail('expected "<"');
    this.i++;
    const name = this.name();
    const attrs: Record<string, string> = {};
    for (;;) {
      const hadWs = this.skipWs();
      if (this.startsWith('/>')) {
        this.i += 2;
        return { name, attrs, children: [], text: '' };
      }
      if (this.s[this.i] === '>') {
        this.i++;
        break;
      }
      if (!hadWs) this.fail('expected whitespace before attribute');
      const an = this.name();
      if (Object.hasOwn(attrs, an)) this.fail(`duplicate attribute "${an}"`);
      this.skipWs();
      if (this.s[this.i] !== '=') this.fail('expected "=" after attribute name');
      this.i++;
      this.skipWs();
      const q = this.s[this.i];
      if (q !== '"' && q !== "'") this.fail('attribute value must be quoted');
      const end = this.s.indexOf(q as string, this.i + 1);
      if (end < 0) this.fail('unterminated attribute value');
      const raw = this.s.slice(this.i + 1, end);
      this.checkChars(raw);
      attrs[an] = this.decode(raw, true);
      this.i = end + 1;
    }
    const children: XmlElement[] = [];
    let text = '';
    for (;;) {
      if (this.i >= this.s.length) this.fail(`unclosed element <${name}>`);
      if (this.startsWith('</')) {
        this.i += 2;
        const close = this.name();
        if (close !== name) this.fail(`mismatched closing tag </${close}> for <${name}>`);
        this.skipWs();
        if (this.s[this.i] !== '>') this.fail('expected ">" in closing tag');
        this.i++;
        return { name, attrs, children, text };
      }
      if (this.startsWith('<!--') || this.startsWith('<?')) {
        this.misc();
        continue;
      }
      if (this.startsWith('<![CDATA[')) {
        const end = this.s.indexOf(']]>', this.i);
        if (end < 0) this.fail('unterminated CDATA');
        const body = this.s.slice(this.i + 9, end);
        this.checkChars(body);
        text += body;
        this.i = end + 3;
        continue;
      }
      if (this.s[this.i] === '<') {
        children.push(this.element());
        continue;
      }
      let end = this.i;
      while (end < this.s.length && this.s[end] !== '<') end++;
      const raw = this.s.slice(this.i, end);
      if (raw.includes(']]>')) this.fail('"]]>" not allowed in character data');
      this.checkChars(raw);
      text += this.decode(raw, false);
      this.i = end;
    }
  }

  parse(): XmlElement {
    if (this.s.startsWith('﻿')) this.i = 1;
    if (this.startsWith('<?xml')) {
      const end = this.s.indexOf('?>', this.i);
      if (end < 0) this.fail('unterminated XML declaration');
      this.i = end + 2;
    }
    this.misc();
    const root = this.element();
    this.misc();
    if (this.i < this.s.length) this.fail('content after the root element');
    return root;
  }
}

export function checkXml(xml: string): XmlCheck {
  try {
    return { ok: true, root: new Parser(xml).parse() };
  } catch (err) {
    if (err instanceof Fail) return { ok: false, error: err.message };
    throw err;
  }
}

export function findAll(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement): void => {
    if (e.name === name) out.push(e);
    for (const c of e.children) walk(c);
  };
  walk(el);
  return out;
}
