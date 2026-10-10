/** XML 1.0 `Char` production: tab, LF, CR, and the printable Unicode ranges (no lone surrogates, no U+FFFE/U+FFFF). */
// @ts-nocheck

export function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

const REPLACEMENT = '�';

function escapeWith(s: string, attr: boolean): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!isXmlChar(cp)) {
      out += REPLACEMENT;
      continue;
    }
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += attr ? '&quot;' : ch;
        break;
      case "'":
        out += attr ? '&apos;' : ch;
        break;
      case '\r':
        out += '&#13;';
        break;
      case '\n':
        out += attr ? '&#10;' : ch;
        break;
      case '\t':
        out += attr ? '&#9;' : ch;
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** Escape character data for use between tags. Invalid XML characters become U+FFFD. */
export function xmlText(s: string): string {
  return escapeWith(s, false);
}

/** Escape a value for use inside a double- or single-quoted attribute. Invalid XML characters become U+FFFD. */
export function xmlAttr(s: string): string {
  return escapeWith(s, true);
}
