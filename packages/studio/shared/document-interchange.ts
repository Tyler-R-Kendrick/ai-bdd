import { investigationBlockSchemas } from './investigations.ts';
import {
  isInvestigationBlockKind,
  investigationBlockText,
} from './investigation-blocks.ts';
import { Lexer } from 'marked';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import type { RichNode } from './domain.ts';
import { editorSchema } from './editor.ts';
import { canonicalDocumentIds } from './document-identity.ts';
import {
  documentBlockSchemas,
  documentBlockText,
  isDocumentBlockKind,
} from './document-blocks.ts';
import {
  richVisualSchemas,
  richVisualText,
  type RichVisualKind,
} from './rich-blocks.ts';
import {
  parseSafeXml,
  xmlChildren,
  xmlDescendants,
  xmlLocalName,
  xmlText,
  xmlAttr,
  xmlEscape,
  type XmlElement,
} from './safe-xml.ts';

const maxSource = 1_000_000,
  maxArchive = 10_000_000,
  maxExpanded = 16_000_000;
const decodeMarkdownText = (value: string) =>
  value.replace(/&(?:amp|lt|gt|quot|#39|#x[0-9a-f]+|#\d+);/gi, (entity) => {
    const named: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
    };
    if (Object.hasOwn(named, entity)) return named[entity]!;
    const code =
      entity[2]?.toLowerCase() === 'x'
        ? parseInt(entity.slice(3, -1), 16)
        : Number(entity.slice(2, -1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : '\uFFFD';
  });
const safeHref = (href: string) =>
  /^(https?:\/\/|mailto:|#|\/api\/files\/[0-9a-f-]{36}$)/i.test(href) &&
  !/[\u0000-\u0020]/.test(href);
const components: Record<string, string> = {
  Chart: 'chartBlock',
  Diagram: 'diagramBlock',
  Tabs: 'tabsBlock',
  Callout: 'calloutBlock',
  Columns: 'columnsBlock',
  Questionnaire: 'questionnaireBlock',
  ArtifactReference: 'artifactReferenceBlock',
  Evidence: 'evidenceBlock',
  AcceptanceTest: 'testBlock',
  Research: 'researchBlock',
  Investigation: 'investigationCard',
  InvestigationView: 'investigationView',
};
const componentNames = Object.fromEntries(
  Object.entries(components).map(([name, type]) => [type, name]),
);
export type DocumentImport = {
  doc: RichNode;
  warnings: string[];
  attachments: { key: string; name: string; mime: string; bytes: Uint8Array }[];
};
function checkedDoc(doc: RichNode): RichNode {
  const normalized = canonicalDocumentIds(doc, () => crypto.randomUUID()).doc;
  editorSchema().nodeFromJSON(normalized).check();
  return normalized;
}
function text(value: string, marks: RichNode['marks'] = []): RichNode[] {
  return value
    ? [{ type: 'text', text: value, ...(marks.length ? { marks } : {}) }]
    : [];
}
function checkedBlock(type: string, data: unknown): RichNode {
  if (isInvestigationBlockKind(type)) {
    const envelope =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    const anchored =
      envelope &&
      Object.keys(envelope).length === 2 &&
      Object.hasOwn(envelope, 'id') &&
      Object.hasOwn(envelope, 'data');
    if (
      anchored &&
      (typeof envelope.id !== 'string' ||
        !envelope.id ||
        envelope.id.length > 100 ||
        /[\u0000-\u0020\u007f]/.test(envelope.id))
    )
      throw new Error(
        'Investigation component anchors must be bounded identifiers',
      );
    return {
      type,
      attrs: {
        data: investigationBlockSchemas[type].parse(
          anchored ? envelope.data : data,
        ),
        ...(anchored ? { id: envelope.id } : {}),
      },
    };
  }
  if (isDocumentBlockKind(type))
    return { type, attrs: { data: documentBlockSchemas[type].parse(data) } };
  if (Object.hasOwn(richVisualSchemas, type))
    return {
      type,
      attrs: { data: richVisualSchemas[type as RichVisualKind].parse(data) },
    };
  if (!data || typeof data !== 'object')
    throw new Error('Document component attributes must be a JSON object');
  const value = data as Record<string, unknown>;
  if (
    type === 'testBlock' &&
    typeof value.label === 'string' &&
    value.label.length <= 180 &&
    (value.scenarioId === undefined ||
      (typeof value.scenarioId === 'string' && value.scenarioId.length <= 300))
  )
    return {
      type,
      attrs: { label: value.label, scenarioId: value.scenarioId ?? '' },
    };
  if (
    type === 'researchBlock' &&
    typeof value.brief === 'string' &&
    value.brief.length <= 2000
  )
    return {
      type,
      attrs: {
        brief: value.brief,
        artifactId:
          typeof value.artifactId === 'string' ? value.artifactId : '',
        status: 'imported',
      },
    };
  throw new Error(`Unsupported or invalid document component: ${type}`);
}
/** Parse Markdown tokens into a fixed ProseMirror schema. HTML and JavaScript are never evaluated. */
export function importMarkdown(
  source: string,
  restrictedMdx = false,
): DocumentImport {
  if (source.length > maxSource)
    throw new Error('Document source exceeds the 1 MB import limit');
  if (restrictedMdx && /^(?:import\s|export\s)/m.test(source))
    throw new Error(
      'Restricted MDX cannot import modules or export executable code',
    );
  const warnings = new Set<string>();
  let count = 0;
  const inline = (
    tokens: any[],
    marks: NonNullable<RichNode['marks']> = [],
    depth = 0,
  ): RichNode[] => {
    if (depth > 16) throw new Error('Markdown inline nesting is too deep');
    return tokens.flatMap((token) => {
      if (++count > 10000) throw new Error('Document contains too many nodes');
      if (
        token.type === 'strong' ||
        token.type === 'em' ||
        token.type === 'del'
      )
        return inline(
          token.tokens ?? [],
          [
            ...marks,
            {
              type: { strong: 'bold', em: 'italic', del: 'strike' }[
                token.type as 'strong' | 'em' | 'del'
              ],
            },
          ],
          depth + 1,
        );
      if (token.type === 'link')
        return inline(
          token.tokens ?? [],
          safeHref(token.href)
            ? [...marks, { type: 'link', attrs: { href: token.href } }]
            : marks,
          depth + 1,
        );
      if (token.type === 'codespan')
        return text(decodeMarkdownText(token.text), [
          ...marks,
          { type: 'code' },
        ]);
      if (token.type === 'br') return [{ type: 'hardBreak' }];
      if (token.type === 'image') {
        warnings.add(
          'Images remain links during Markdown import. Upload images through Insert image to attach owned project files.',
        );
        return text(`Image: ${token.text ?? ''} (${token.href ?? ''})`, marks);
      }
      if (token.type === 'html') {
        warnings.add(
          'HTML was imported as literal text, never as executable markup.',
        );
        return text(token.raw, marks);
      }
      if (token.tokens) return inline(token.tokens, marks, depth + 1);
      const value = decodeMarkdownText(String(token.text ?? token.raw ?? ''));
      const result: RichNode[] = [];
      let previous = 0;
      for (const match of value.matchAll(/\$([^$\n]+)\$/g)) {
        result.push(...text(value.slice(previous, match.index), marks), {
          type: 'inlineMath',
          attrs: { latex: match[1] },
          ...(marks.length ? { marks } : {}),
        });
        previous = match.index! + match[0].length;
      }
      result.push(...text(value.slice(previous), marks));
      return result;
    });
  };
  const blocks = (tokens: any[], depth = 0): RichNode[] => {
    if (depth > 16) throw new Error('Markdown block nesting is too deep');
    return tokens.flatMap((token) => {
      if (++count > 10000) throw new Error('Document contains too many nodes');
      if (token.type === 'space' || token.type === 'def') return [];
      if (token.type === 'heading')
        return [
          {
            type: 'heading',
            attrs: { level: token.depth },
            content: inline(token.tokens ?? []),
          },
        ];
      if (
        (token.type === 'paragraph' || token.type === 'text') &&
        /^\$\$[\s\S]*\$\$$/.test(token.text?.trim() ?? '')
      )
        return [
          {
            type: 'blockMath',
            attrs: { latex: token.text.trim().slice(2, -2).trim() },
          },
        ];
      if (
        (token.type === 'paragraph' || token.type === 'text') &&
        token.tokens?.length === 1 &&
        token.tokens[0].type === 'image' &&
        /^\/api\/files\/[0-9a-f-]{36}$/.test(token.tokens[0].href)
      )
        return [
          {
            type: 'image',
            attrs: {
              src: token.tokens[0].href,
              alt: decodeMarkdownText(token.tokens[0].text ?? ''),
            },
          },
        ];
      if (token.type === 'paragraph' || token.type === 'text')
        return [
          {
            type: 'paragraph',
            content: inline(
              token.tokens ?? [{ type: 'text', text: token.text }],
            ),
          },
        ];
      if (token.type === 'blockquote')
        return [
          {
            type: 'blockquote',
            content: blocks(token.tokens ?? [], depth + 1),
          },
        ];
      if (token.type === 'hr') return [{ type: 'horizontalRule' }];
      if (token.type === 'list')
        return [
          {
            type: token.ordered ? 'orderedList' : 'bulletList',
            ...(token.ordered ? { attrs: { start: token.start ?? 1 } } : {}),
            content: token.items.map((item: any) => ({
              type: 'listItem',
              content: blocks(item.tokens ?? [], depth + 1),
            })),
          },
        ];
      if (token.type === 'table')
        return [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: token.header.map((cell: any) => ({
                  type: 'tableHeader',
                  content: [
                    { type: 'paragraph', content: inline(cell.tokens ?? []) },
                  ],
                })),
              },
              ...token.rows.map((row: any[]) => ({
                type: 'tableRow',
                content: row.map((cell) => ({
                  type: 'tableCell',
                  content: [
                    { type: 'paragraph', content: inline(cell.tokens ?? []) },
                  ],
                })),
              })),
            ],
          },
        ];
      if (token.type === 'code') {
        if (token.lang?.startsWith('studio:'))
          return [checkedBlock(token.lang.slice(7), JSON.parse(token.text))];
        return [
          {
            type: 'codeBlock',
            attrs: { language: token.lang ?? null },
            content: text(token.text),
          },
        ];
      }
      if (token.type === 'html') {
        const value = token.raw.trim(),
          match = /^<([A-Z][A-Za-z]+)\s+data=\{([\s\S]*)\}\s*\/>$/.exec(value);
        if (match && components[match[1]!])
          return [checkedBlock(components[match[1]!]!, JSON.parse(match[2]!))];
        if (restrictedMdx && /^<[A-Z]/.test(value))
          throw new Error(
            'Restricted MDX supports only the registered document components with literal JSON data',
          );
        warnings.add(
          'HTML was imported as literal text, never as executable markup.',
        );
        return [{ type: 'paragraph', content: text(token.raw) }];
      }
      return [{ type: 'paragraph', content: text(String(token.raw ?? '')) }];
    });
  };
  let fence = '';
  const prepared = source
    .split('\n')
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length)
          fence = '';
        return line;
      }
      if (fence) return line;
      const value = line.trim(),
        component = /^<([A-Z][A-Za-z]+)\s+data=\{([\s\S]*)\}\s*\/>$/.exec(
          value,
        );
      if (component && components[component[1]!]) {
        const type = components[component[1]!]!,
          parsed = JSON.parse(component[2]!);
        checkedBlock(type, parsed);
        return (
          '\n```studio:' + type + '\n' + JSON.stringify(parsed) + '\n```\n'
        );
      }
      if (restrictedMdx && /^<[A-Z]/.test(value))
        throw new Error(
          'Restricted MDX supports only the registered document components with literal JSON data',
        );
      return line;
    })
    .join('\n');
  const content = blocks(Lexer.lex(prepared, { gfm: true }));
  return {
    doc: checkedDoc({
      type: 'doc',
      content: content.length ? content : [{ type: 'paragraph' }],
    }),
    warnings: [...warnings],
    attachments: [],
  };
}
const escapeMarkdown = (value: string) =>
  value.replace(/[\\`*_[\]<>]/g, '\\$&');
export function exportMarkdown(doc: RichNode, restrictedMdx = false): string {
  const inline = (node: RichNode): string => {
    if (node.type === 'hardBreak') return '  \n';
    if (node.type === 'inlineMath')
      return `$${String(node.attrs?.latex ?? '').replace(/\$/g, '\\$')}$`;
    let value = escapeMarkdown(node.text ?? '');
    for (const mark of node.marks ?? []) {
      if (mark.type === 'code') {
        const fence = '`'.repeat(
          Math.max(
            1,
            ...(node.text?.match(/`+/g) ?? []).map((s) => s.length + 1),
          ),
        );
        value = `${fence}${node.text ?? ''}${fence}`;
      }
      if (mark.type === 'bold') value = `**${value}**`;
      if (mark.type === 'italic') value = `*${value}*`;
      if (mark.type === 'strike') value = `~~${value}~~`;
      if (
        mark.type === 'link' &&
        typeof mark.attrs?.href === 'string' &&
        safeHref(mark.attrs.href)
      )
        value = `[${value}](${mark.attrs.href.replace(/\)/g, '%29')})`;
    }
    return value;
  };
  const render = (node: RichNode, depth = 0): string => {
    const content = node.content ?? [],
      prose = () => content.map(inline).join('');
    if (node.type === 'doc') return content.map((c) => render(c)).join('\n\n');
    if (node.type === 'paragraph') return prose();
    if (node.type === 'heading')
      return `${'#'.repeat(Math.max(1, Math.min(6, Number(node.attrs?.level) || 1)))} ${prose()}`;
    if (node.type === 'blockquote')
      return content
        .map((c) => render(c))
        .join('\n\n')
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n');
    if (node.type === 'bulletList' || node.type === 'orderedList')
      return content
        .map(
          (c, i) =>
            `${node.type === 'bulletList' ? '-' : `${Number(node.attrs?.start ?? 1) + i}.`} ${render(c, depth + 1).replace(/\n/g, '\n  ')}`,
        )
        .join('\n');
    if (node.type === 'listItem')
      return content.map((c) => render(c, depth)).join('\n\n');
    if (node.type === 'codeBlock') {
      const source = content.map((c) => c.text ?? '').join(''),
        fence = '`'.repeat(
          Math.max(3, ...(source.match(/`+/g) ?? []).map((s) => s.length + 1)),
        );
      return `${fence}${String(node.attrs?.language ?? '')}\n${source}\n${fence}`;
    }
    if (node.type === 'horizontalRule') return '---';
    if (node.type === 'image')
      return `![${escapeMarkdown(String(node.attrs?.alt ?? ''))}](${String(node.attrs?.src ?? '')})`;
    if (node.type === 'blockMath')
      return `$$\n${String(node.attrs?.latex ?? '')}\n$$`;
    if (node.type === 'table') {
      const rows = content.map((row) =>
        (row.content ?? []).map((cell) =>
          (cell.content ?? [])
            .map((p) => (p.content ?? []).map(inline).join(''))
            .join(' / ')
            .replace(/\|/g, '\\|')
            .replace(/\n/g, ' '),
        ),
      );
      return rows.length
        ? [
            `| ${rows[0]!.join(' | ')} |`,
            `| ${rows[0]!.map(() => '---').join(' | ')} |`,
            ...rows.slice(1).map((row) => `| ${row.join(' | ')} |`),
          ].join('\n')
        : '';
    }
    if (componentNames[node.type]) {
      const value = node.attrs?.data ?? node.attrs ?? {};
      const data =
        isInvestigationBlockKind(node.type) && node.attrs?.id
          ? { id: node.attrs.id, data: value }
          : value;
      return restrictedMdx
        ? `<${componentNames[node.type]} data={${JSON.stringify(data)}} />`
        : `\`\`\`studio:${node.type}\n${JSON.stringify(data, null, 2)}\n\`\`\``;
    }
    return prose();
  };
  return render(doc).trimEnd() + '\n';
}
/** Reject oversized ZIP declarations before inflating any content. ZIP64/encrypted archives are intentionally unsupported. */
export function validateDocxArchive(bytes: Uint8Array): number {
  if (bytes.length > maxArchive || bytes.length < 22)
    throw new Error('DOCX import requires a ZIP archive smaller than 10 MB');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new Error('DOCX archive structure is unsupported');
  if (
    (end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) ||
    view.getUint16(end + 8, true) !== view.getUint16(end + 10, true)
  )
    throw new Error('DOCX ZIP64 or inconsistent entry counts are unsupported');
  const entries = view.getUint16(end + 10, true),
    centralSize = view.getUint32(end + 12, true),
    start = view.getUint32(end + 16, true);
  if (entries > 256 || entries === 65535 || start + centralSize > end)
    throw new Error('DOCX archive contains too many entries or ZIP64 metadata');
  let position = start,
    total = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50)
      throw new Error('DOCX ZIP directory is invalid');
    const flags = view.getUint16(position + 8, true),
      expanded = view.getUint32(position + 24, true),
      nameLength = view.getUint16(position + 28, true),
      extra = view.getUint16(position + 30, true),
      comment = view.getUint16(position + 32, true),
      next = position + 46 + nameLength + extra + comment;
    if (next > end || flags & 1 || expanded === 0xffffffff)
      throw new Error('DOCX cannot contain encrypted or ZIP64 entries');
    const name = strFromU8(
      bytes.subarray(position + 46, position + 46 + nameLength),
    );
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      names.has(name)
    )
      throw new Error('DOCX archive contains an unsafe or repeated path');
    names.add(name);
    total += expanded;
    if (total > maxExpanded || expanded > 8_000_000)
      throw new Error('DOCX expanded contents exceed the 16 MB import limit');
    position = next;
  }
  if (position !== start + centralSize || !names.has('word/document.xml'))
    throw new Error('DOCX archive is missing its Word document');
  return end;
}
export function importDocx(bytes: Uint8Array): DocumentImport {
  const directoryEnd = validateDocxArchive(bytes),
    normalized = bytes.slice(0, directoryEnd + 22);
  new DataView(normalized.buffer).setUint16(directoryEnd + 20, 0, true);
  const files = unzipSync(normalized, {
    filter: (file) =>
      /^(word\/(document\.xml|numbering\.xml|_rels\/document\.xml\.rels|media\/[A-Za-z0-9._-]+)|\[Content_Types\]\.xml)$/.test(
        file.name,
      ),
  });
  if (
    Object.values(files).reduce((n, data) => n + data.length, 0) > maxExpanded
  )
    throw new Error('DOCX expanded contents exceed the limit');
  const document = parseSafeXml(strFromU8(files['word/document.xml']!)),
    relationships = new Map<
      string,
      { target: string; external: boolean; type: string }
    >(),
    warnings = new Set<string>(),
    attachments: DocumentImport['attachments'] = [];
  if (files['word/_rels/document.xml.rels'])
    for (const rel of xmlChildren(
      parseSafeXml(strFromU8(files['word/_rels/document.xml.rels']!)),
      'Relationship',
    ))
      relationships.set(xmlAttr(rel, 'Id') ?? '', {
        target: xmlAttr(rel, 'Target') ?? '',
        external: xmlAttr(rel, 'TargetMode') === 'External',
        type: xmlAttr(rel, 'Type') ?? '',
      });
  if (
    xmlDescendants(document, 'ins').length ||
    xmlDescendants(document, 'del').length
  )
    warnings.add(
      'Word tracked changes were imported as final text: insertions included and deletions omitted. Their original review history is not imported.',
    );
  const run = (
    element: XmlElement,
    marks: NonNullable<RichNode['marks']> = [],
  ): RichNode[] => {
    const name = xmlLocalName(element);
    if (name === 'del') return [];
    if (name === 'hyperlink') {
      const rel = relationships.get(xmlAttr(element, 'id') ?? '');
      return xmlChildren(element).flatMap((child) =>
        run(
          child,
          rel && safeHref(rel.target)
            ? [...marks, { type: 'link', attrs: { href: rel.target } }]
            : marks,
        ),
      );
    }
    if (name === 'r') {
      const properties = xmlChildren(element, 'rPr')[0],
        next = [...marks];
      if (properties)
        for (const property of xmlChildren(properties)) {
          const type = (
            {
              b: 'bold',
              i: 'italic',
              strike: 'strike',
              u: 'underline',
            } as Record<string, string>
          )[xmlLocalName(property)];
          if (
            type &&
            !['0', 'false', 'none'].includes(xmlAttr(property, 'val') ?? '')
          )
            next.push({ type });
        }
      return xmlChildren(element)
        .filter((child) => xmlLocalName(child) !== 'rPr')
        .flatMap((child) => run(child, next));
    }
    if (name === 't') return text(xmlText(element), marks);
    if (name === 'br' || name === 'cr') return [{ type: 'hardBreak' }];
    if (name === 'tab') return text('\t', marks);
    if (name === 'oMath')
      return [{ type: 'inlineMath', attrs: { latex: xmlText(element) } }];
    if (name === 'drawing' || name === 'pict') {
      const rel = relationships.get(
        xmlAttr(xmlDescendants(element, 'blip')[0], 'embed') ?? '',
      );
      if (
        !rel ||
        rel.external ||
        !/^media\/[A-Za-z0-9._-]+$/.test(rel.target)
      ) {
        warnings.add(
          'External or unsupported Word image relationships were omitted. No external resources were requested.',
        );
        return [];
      }
      const data = files['word/' + rel.target],
        mime = /\.png$/i.test(rel.target)
          ? 'image/png'
          : /\.jpe?g$/i.test(rel.target)
            ? 'image/jpeg'
            : '';
      if (
        !data ||
        !mime ||
        (mime === 'image/png' &&
          !(
            data[0] === 137 &&
            data[1] === 80 &&
            data[2] === 78 &&
            data[3] === 71
          )) ||
        (mime === 'image/jpeg' && !(data[0] === 255 && data[1] === 216))
      ) {
        warnings.add(
          'Unsupported Word images were omitted; PNG and JPEG embedded images are supported.',
        );
        return [];
      }
      let item = attachments.find((a) => a.name === rel.target.slice(6));
      if (!item) {
        item = {
          key: `attachment-${attachments.length}`,
          name: rel.target.slice(6),
          mime,
          bytes: data,
        };
        attachments.push(item);
      }
      return [
        {
          type: 'image',
          attrs: { src: 'attachment:' + item.key, alt: item.name },
        },
      ];
    }
    return xmlChildren(element).flatMap((child) => run(child, marks));
  };
  const listKinds = new Map<string, string>();
  if (files['word/numbering.xml']) {
    const numbering = parseSafeXml(strFromU8(files['word/numbering.xml']!)),
      kinds = new Map<string, string>();
    for (const definition of xmlChildren(numbering, 'abstractNum'))
      kinds.set(
        xmlAttr(definition, 'abstractNumId') ?? '',
        xmlAttr(xmlDescendants(definition, 'numFmt')[0], 'val') === 'bullet'
          ? 'bulletList'
          : 'orderedList',
      );
    for (const number of xmlChildren(numbering, 'num'))
      listKinds.set(
        xmlAttr(number, 'numId') ?? '',
        kinds.get(
          xmlAttr(xmlChildren(number, 'abstractNumId')[0], 'val') ?? '',
        ) ?? 'orderedList',
      );
  }
  const parseBlocks = (container: XmlElement): RichNode[] => {
    const result: RichNode[] = [];
    for (const element of xmlChildren(container)) {
      const name = xmlLocalName(element);
      if (name === 'p') {
        const props = xmlChildren(element, 'pPr')[0],
          style = props && xmlAttr(xmlChildren(props, 'pStyle')[0], 'val'),
          heading = style && /^(?:Heading|heading)([1-6])$/.exec(style),
          content = xmlChildren(element)
            .filter((c) => xmlLocalName(c) !== 'pPr')
            .flatMap((c) => run(c));
        const images = content.filter((c) => c.type === 'image'),
          prose = content.filter((c) => c.type !== 'image'),
          paragraph: RichNode = {
            type: heading ? 'heading' : 'paragraph',
            ...(heading ? { attrs: { level: Number(heading[1]) } } : {}),
            ...(prose.length ? { content: prose } : {}),
          };
        const numbering = props && xmlChildren(props, 'numPr')[0];
        if (numbering && !heading) {
          const numId = xmlAttr(xmlChildren(numbering, 'numId')[0], 'val'),
            previous = result.at(-1),
            type =
              listKinds.get(numId ?? '') ??
              (numId === '1' ? 'bulletList' : 'orderedList');
          if (
            Number(xmlAttr(xmlChildren(numbering, 'ilvl')[0], 'val') ?? 0) > 0
          )
            warnings.add(
              'Nested Word list indentation was flattened; list text and sequence are retained.',
            );
          if (previous?.type === type)
            previous.content!.push({ type: 'listItem', content: [paragraph] });
          else
            result.push({
              type,
              content: [{ type: 'listItem', content: [paragraph] }],
            });
        } else result.push(paragraph);
        result.push(...images);
      } else if (name === 'tbl') {
        const active = new Map<number, RichNode>(),
          rows: RichNode[] = [];
        for (const row of xmlChildren(element, 'tr')) {
          const cells: RichNode[] = [],
            header = !!xmlChildren(row, 'trPr').flatMap((value) =>
              xmlChildren(value, 'tblHeader'),
            ).length;
          let column = 0;
          for (const cell of xmlChildren(row, 'tc')) {
            const properties = xmlChildren(cell, 'tcPr')[0],
              span = Math.max(
                1,
                Math.min(
                  100,
                  Number(
                    properties &&
                      xmlAttr(xmlChildren(properties, 'gridSpan')[0], 'val'),
                  ) || 1,
                ),
              ),
              merge = properties && xmlChildren(properties, 'vMerge')[0];
            if (
              merge &&
              xmlAttr(merge, 'val') !== 'restart' &&
              active.has(column)
            ) {
              const origin = active.get(column)!;
              origin.attrs = {
                ...origin.attrs,
                rowspan: Number(origin.attrs?.rowspan ?? 1) + 1,
              };
            } else {
              const parsed = parseBlocks(cell),
                next: RichNode = {
                  type: header ? 'tableHeader' : 'tableCell',
                  attrs: { colspan: span, rowspan: 1 },
                  content: parsed.length ? parsed : [{ type: 'paragraph' }],
                };
              cells.push(next);
              if (merge && xmlAttr(merge, 'val') === 'restart')
                active.set(column, next);
              else active.delete(column);
            }
            column += span;
          }
          if (!cells.length)
            cells.push({ type: 'tableCell', content: [{ type: 'paragraph' }] });
          rows.push({ type: 'tableRow', content: cells });
        }
        result.push({ type: 'table', content: rows });
      } else if (name === 'sdt' || name === 'sdtContent')
        result.push(...parseBlocks(element));
    }
    return result;
  };
  const body = xmlDescendants(document, 'body')[0];
  if (!body) throw new Error('DOCX is missing its document body');
  const content = parseBlocks(body),
    doc: RichNode = {
      type: 'doc',
      content: content.length ? content : [{ type: 'paragraph' }],
    };
  const normalizedDoc = checkedDoc(doc);
  return { doc: normalizedDoc, warnings: [...warnings], attachments };
}
export type DocxImage = {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  width?: number;
  height?: number;
};
export function exportDocx(
  doc: RichNode,
  title: string,
  images: Record<string, DocxImage> = {},
): Uint8Array {
  checkedDoc(doc);
  const archive: Record<string, Uint8Array> = {},
    relations: string[] = [],
    imageIds = new Map<string, string>();
  let relation = 0,
    drawing = 0;
  const hyperlink = (href: string) => {
    const id = 'rId' + ++relation;
    relations.push(
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(href)}" TargetMode="External"/>`,
    );
    return id;
  };
  const runs = (node: RichNode): string => {
    if (node.type === 'hardBreak') return '<w:r><w:br/></w:r>';
    if (node.type === 'inlineMath')
      return `<m:oMath><m:r><m:t>${xmlEscape(String(node.attrs?.latex ?? ''))}</m:t></m:r></m:oMath>`;
    const marks = node.marks ?? [],
      properties = marks
        .flatMap(
          (mark) =>
            (
              ({
                bold: ['<w:b/>'],
                italic: ['<w:i/>'],
                strike: ['<w:strike/>'],
                underline: ['<w:u w:val="single"/>'],
                code: ['<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'],
              }) as Record<string, string[]>
            )[mark.type] ?? [],
        )
        .join('');
    const content = `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEscape(node.text ?? '')}</w:t></w:r>`,
      link = marks.find(
        (mark) =>
          mark.type === 'link' &&
          typeof mark.attrs?.href === 'string' &&
          safeHref(mark.attrs.href),
      );
    return link
      ? `<w:hyperlink r:id="${hyperlink(String(link.attrs!.href))}">${content}</w:hyperlink>`
      : content;
  };
  const paragraph = (node: RichNode, properties = '') =>
    `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${(node.content ?? []).map(runs).join('')}</w:p>`;
  const blocks = (node: RichNode, numbering?: number): string => {
    if (node.type === 'doc')
      return (node.content ?? []).map((n) => blocks(n)).join('');
    if (node.type === 'heading')
      return paragraph(
        node,
        `<w:pStyle w:val="Heading${Number(node.attrs?.level) || 1}"/>`,
      );
    if (node.type === 'paragraph')
      return paragraph(
        node,
        numbering
          ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numbering}"/></w:numPr>`
          : '',
      );
    if (node.type === 'bulletList' || node.type === 'orderedList')
      return (node.content ?? [])
        .map((n) => blocks(n, node.type === 'bulletList' ? 1 : 2))
        .join('');
    if (node.type === 'listItem' || node.type === 'blockquote')
      return (node.content ?? []).map((n) => blocks(n, numbering)).join('');
    if (node.type === 'codeBlock')
      return paragraph({
        type: 'paragraph',
        content: (node.content ?? []).map((n) => ({
          ...n,
          marks: [{ type: 'code' }],
        })),
      });
    if (node.type === 'table') {
      const active = new Map<number, { remaining: number; span: number }>(),
        width = Math.max(
          0,
          ...(node.content ?? []).map((row) =>
            (row.content ?? []).reduce(
              (total, cell) => total + Number(cell.attrs?.colspan ?? 1),
              0,
            ),
          ),
        );
      const rows = (node.content ?? [])
        .map((row) => {
          const cells = row.content ?? [];
          let column = 0,
            index = 0,
            body = '';
          while (column < width || index < cells.length) {
            const continuing = active.get(column);
            if (continuing) {
              body += `<w:tc><w:tcPr><w:vMerge/>${continuing.span > 1 ? `<w:gridSpan w:val="${continuing.span}"/>` : ''}</w:tcPr><w:p/></w:tc>`;
              if (--continuing.remaining <= 0) active.delete(column);
              column += continuing.span;
              continue;
            }
            const cell = cells[index++];
            if (!cell) {
              column++;
              continue;
            }
            const span = Math.max(1, Number(cell.attrs?.colspan ?? 1)),
              rows = Math.max(1, Number(cell.attrs?.rowspan ?? 1));
            body += `<w:tc><w:tcPr>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${rows > 1 ? '<w:vMerge w:val="restart"/>' : ''}</w:tcPr>${(cell.content ?? []).map((n) => blocks(n)).join('') || '<w:p/>'}</w:tc>`;
            if (rows > 1) active.set(column, { remaining: rows - 1, span });
            column += span;
          }
          return `<w:tr>${cells.every((cell) => cell.type === 'tableHeader') ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${body}</w:tr>`;
        })
        .join('');
      return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:color="D1D5DB"/>`).join('')}</w:tblBorders></w:tblPr>${rows}</w:tbl>`;
    }
    if (node.type === 'image') {
      const src = String(node.attrs?.src ?? ''),
        image = images[src];
      if (!image)
        return paragraph({
          type: 'paragraph',
          content: text(`[Image: ${String(node.attrs?.alt ?? '')}]`),
        });
      let id = imageIds.get(src);
      if (!id) {
        id = 'rId' + ++relation;
        imageIds.set(src, id);
        const name = `image${imageIds.size}.${image.mime === 'image/png' ? 'png' : 'jpg'}`;
        archive['word/media/' + name] = image.bytes;
        relations.push(
          `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`,
        );
      }
      const naturalWidth =
          image.width && Number.isFinite(image.width) && image.width > 0
            ? image.width
            : 500,
        naturalHeight =
          image.height && Number.isFinite(image.height) && image.height > 0
            ? image.height
            : 300,
        scale = Math.min(4572000 / naturalWidth, 6858000 / naturalHeight),
        cx = Math.round(naturalWidth * scale),
        cy = Math.round(naturalHeight * scale),
        drawingId = ++drawing;
      return `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${drawingId}" name="${xmlEscape(String(node.attrs?.alt ?? 'Image'))}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${drawingId}" name="Image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    }
    let prose = '';
    if (isInvestigationBlockKind(node.type))
      prose = investigationBlockText(node.type, node.attrs?.data);
    else if (isDocumentBlockKind(node.type))
      prose = documentBlockText(node.type, node.attrs?.data);
    else if (Object.hasOwn(richVisualSchemas, node.type))
      prose = richVisualText(node.type as RichVisualKind, node.attrs?.data);
    else if (node.type === 'testBlock')
      prose = `Acceptance criterion: ${String(node.attrs?.label ?? '')}\nScenario: ${String(node.attrs?.scenarioId || 'Not linked')}`;
    else if (node.type === 'researchBlock')
      prose = `Research: ${String(node.attrs?.brief ?? '')}`;
    else if (node.type === 'blockMath') prose = String(node.attrs?.latex ?? '');
    return prose
      .split('\n')
      .map((line) => paragraph({ type: 'paragraph', content: text(line) }))
      .join('');
  };
  const body = blocks(doc);
  archive['word/document.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body></w:document>`,
  );
  archive['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  );
  archive['_rels/.rels'] = strToU8(
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="properties" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
  );
  archive['word/_rels/document.xml.rels'] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="numbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${relations.join('')}</Relationships>`,
  );
  archive['word/styles.xml'] = strToU8(
    `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:style>${[1, 2, 3, 4, 5, 6].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${Math.max(24, 40 - level * 4)}"/></w:rPr></w:style>`).join('')}</w:styles>`,
  );
  archive['word/numbering.xml'] = strToU8(
    `<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${[1, 2].map((id) => `<w:abstractNum w:abstractNumId="${id}"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${id === 1 ? 'bullet' : 'decimal'}"/><w:lvlText w:val="${id === 1 ? '•' : '%1.'}"/></w:lvl></w:abstractNum><w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`).join('')}</w:numbering>`,
  );
  archive['docProps/core.xml'] = strToU8(
    `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(title.slice(0, 180))}</dc:title><dc:creator>ai-bdd Studio</dc:creator></cp:coreProperties>`,
  );
  return zipSync(archive, { level: 6 });
}
