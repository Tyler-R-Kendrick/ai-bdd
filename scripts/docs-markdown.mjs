// Markdown reading for check-docs.mjs: fenced code blocks and their tags, GitHub heading anchors, and relative links. Pure
// functions over text; plain Node ESM with no dependencies.

/** Fenced code blocks of a Markdown text: `{ lang, tags, code, line }` (line is the 1-based line of the opening fence). */
export function extractBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*(.*)$/.exec(lines[i]);
    if (!open) continue;
    const [, indent, fence, info] = open;
    if (fence.startsWith('`') && info.includes('`')) continue; // inline code that merely starts a line
    const tokens = info.trim().split(/\s+/).filter(Boolean);
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[j]);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
      body.push(lines[j].startsWith(indent) ? lines[j].slice(indent.length) : lines[j].trimStart());
    }
    blocks.push({ lang: tokens[0] ?? '', tags: tokens.slice(1), code: body.join('\n'), line: i + 1 });
    i = j;
  }
  return blocks;
}

/** Interprets block tags. Returns `{ kind: 'ts-check' | 'sh-run' | null, in?, exit?, problem? }`. */
export function classifyBlock(block) {
  const { lang, tags } = block;
  const hasTag = tags.includes('check') || tags.includes('run');
  if (lang === 'ts' && tags.includes('check')) {
    const extra = tags.filter((t) => t !== 'check');
    return extra.length > 0 ? { kind: null, problem: `unknown tag(s) on ts check block: ${extra.join(' ')}` } : { kind: 'ts-check' };
  }
  if (lang === 'sh' && tags.includes('run')) {
    const out = { kind: 'sh-run', in: 'root', exit: 0 };
    for (const t of tags) {
      if (t === 'run') continue;
      let m;
      if (t === 'in=project') out.in = 'project';
      else if ((m = /^exit=(\d{1,3})$/.exec(t))) out.exit = Number(m[1]);
      else return { kind: null, problem: `unknown tag on sh run block: ${t}` };
    }
    return out;
  }
  if (hasTag) return { kind: null, problem: `tag "${tags.join(' ')}" is only valid on "ts check" and "sh run" blocks (language is "${lang}")` };
  return { kind: null };
}

/** GitHub-style heading slug. */
export function slugOf(heading) {
  const text = heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]+/g, (m) => (m.includes('_') ? m : ''))
    .toLowerCase();
  return text
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** All heading anchors of a Markdown text (with GitHub's `-1`, `-2` suffixes for duplicates). */
export function anchorsOf(markdown) {
  const seen = new Map();
  const anchors = new Set();
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = slugOf(h[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Link targets outside code: `[text](target)`, images and `[ref]: target` definitions. */
export function extractLinks(markdown) {
  const links = [];
  let fence = null;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const text = lines[i].replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    const re = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
    let m;
    while ((m = re.exec(text))) links.push({ target: m[1], line: i + 1 });
    const def = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/.exec(text);
    if (def) links.push({ target: def[1], line: i + 1 });
  }
  return links;
}
