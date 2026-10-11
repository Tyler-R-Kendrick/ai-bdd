/** A small unified-style line diff for failure messages. */

export interface DiffOptions { context?: number; maxLines?: number }

/** Longest-common-subsequence table walk; inputs above `LCS_LIMIT` lines each fall back to a first-difference report. */
const LCS_LIMIT = 1500;

function lcsOps(a: string[], b: string[]): { op: ' ' | '-' | '+'; line: string }[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: { op: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: ' ', line: a[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ op: '-', line: a[i]! });
      i += 1;
    } else {
      ops.push({ op: '+', line: b[j]! });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ op: '-', line: a[i]! });
  for (; j < m; j += 1) ops.push({ op: '+', line: b[j]! });
  return ops;
}

/** Diff of `verified` (lines starting with `-`) against `received` (`+`), with `context` unchanged lines around each change. */
export function unifiedDiff(verified: string, received: string, { context = 3, maxLines = 80 }: DiffOptions = {}): string {
  const a = verified.split('\n');
  const b = received.split('\n');
  let ops: { op: ' ' | '-' | '+'; line: string }[];
  if (a.length > LCS_LIMIT || b.length > LCS_LIMIT) {
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k += 1;
    ops = [
      { op: ' ', line: `... ${k} identical line(s), then the files differ (too large for a full diff) ...` },
      { op: '-', line: a[k] ?? '' },
      { op: '+', line: b[k] ?? '' },
    ];
  } else {
    ops = lcsOps(a, b);
  }
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, idx) => {
    if (o.op === ' ') return;
    for (let d = -context; d <= context; d += 1) {
      const at = idx + d;
      if (at >= 0 && at < ops.length) keep[at] = true;
    }
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((o, idx) => {
    if (!keep[idx]) {
      skipped = true;
      return;
    }
    if (skipped && out.length > 0) out.push('...');
    skipped = false;
    out.push(`${o.op}${o.line}`);
  });
  if (out.length > maxLines) return [...out.slice(0, maxLines), `... ${out.length - maxLines} more diff line(s)`].join('\n');
  return out.join('\n');
}
