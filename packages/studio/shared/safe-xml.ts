/** A bounded, non-validating OOXML reader. It has no DTD, entity resolver, URL, or filesystem API. */
export type XmlElement = {
  name: string;
  attributes: Record<string, string>;
  children: (XmlElement | string)[];
};
export const xmlEscape = (value: string): string =>
  value.replace(
    /[<>&"']/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]!,
  );
function decode(value: string): string {
  return value.replace(/&([^;]{1,20});/g, (_, entity: string) => {
    const named: Record<string, string> = {
      lt: '<',
      gt: '>',
      amp: '&',
      quot: '"',
      apos: "'",
    };
    if (Object.hasOwn(named, entity)) return named[entity]!;
    if (!/^#(?:\d+|x[0-9a-f]+)$/i.test(entity))
      throw new Error('Document XML contains an unsupported entity');
    const point =
      entity[1]?.toLowerCase() === 'x'
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
    if (
      !Number.isSafeInteger(point) ||
      point < 1 ||
      point > 0x10ffff ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      throw new Error('Document XML contains an invalid character');
    return String.fromCodePoint(point);
  });
}
export function parseSafeXml(source: string): XmlElement {
  if (source.length > 8_000_000)
    throw new Error('Document XML exceeds the 8 MB limit');
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('Document XML cannot declare a DTD or entities');
  const root: XmlElement = { name: '#document', attributes: {}, children: [] },
    stack = [root];
  let position = 0,
    count = 0;
  while (position < source.length) {
    if (++count > 200000)
      throw new Error('Document XML contains too many nodes');
    if (source[position] !== '<') {
      const end = source.indexOf('<', position);
      const stop = end < 0 ? source.length : end;
      stack.at(-1)!.children.push(decode(source.slice(position, stop)));
      position = stop;
      continue;
    }
    if (source.startsWith('<!--', position)) {
      const end = source.indexOf('-->', position + 4);
      if (end < 0) throw new Error('Document XML has an unfinished comment');
      position = end + 3;
      continue;
    }
    if (source.startsWith('<?xml', position)) {
      const end = source.indexOf('?>', position + 5);
      if (end < 0 || position > 1) throw new Error('Invalid XML declaration');
      position = end + 2;
      continue;
    }
    if (source.startsWith('<!', position) || source.startsWith('<?', position))
      throw new Error('Unsupported XML declaration');
    let end = position + 1,
      quote = '';
    for (; end < source.length; end++) {
      const c = source[end]!;
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (end === source.length)
      throw new Error('Document XML contains an unfinished tag');
    const tag = source.slice(position + 1, end).trim();
    position = end + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      if (stack.length === 1 || stack.at(-1)!.name !== name)
        throw new Error('Document XML tags do not match');
      stack.pop();
      continue;
    }
    const match = /^([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(tag);
    if (!match) throw new Error('Invalid XML tag');
    const empty = /\/$/.test(match[2]!),
      attributes: Record<string, string> = {},
      rest = match[2]!.replace(/\/$/, '');
    let remaining = rest;
    while (remaining.trim()) {
      const attribute =
        /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(remaining);
      if (!attribute || Object.hasOwn(attributes, attribute[1]!))
        throw new Error('Invalid or repeated XML attribute');
      attributes[attribute[1]!] = decode(attribute[2] ?? attribute[3] ?? '');
      remaining = remaining.slice(attribute[0].length);
    }
    const node: XmlElement = { name: match[1]!, attributes, children: [] };
    stack.at(-1)!.children.push(node);
    if (!empty) {
      stack.push(node);
      if (stack.length > 80)
        throw new Error('Document XML nesting is too deep');
    }
  }
  const elements = root.children.filter(
    (c): c is XmlElement => typeof c !== 'string',
  );
  if (stack.length !== 1 || elements.length !== 1)
    throw new Error('Document XML requires exactly one complete root');
  return elements[0]!;
}
export const xmlLocalName = (node: XmlElement) => node.name.split(':').at(-1)!;
export const xmlChildren = (node: XmlElement, name?: string): XmlElement[] =>
  node.children.filter(
    (c): c is XmlElement =>
      typeof c !== 'string' && (!name || xmlLocalName(c) === name),
  );
export const xmlDescendants = (node: XmlElement, name: string): XmlElement[] =>
  xmlChildren(node).flatMap((c) => [
    ...(xmlLocalName(c) === name ? [c] : []),
    ...xmlDescendants(c, name),
  ]);
export const xmlText = (node: XmlElement): string =>
  node.children.map((c) => (typeof c === 'string' ? c : xmlText(c))).join('');
export const xmlAttr = (
  node: XmlElement | undefined,
  name: string,
): string | undefined =>
  node &&
  Object.entries(node.attributes).find(
    ([key]) => key.split(':').at(-1) === name,
  )?.[1];
