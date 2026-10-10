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
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: equivalent mutants, reading past either end gives undefined, which never equals a line, so each bound alone (or ||, or <=) stops at the same index; with both bounds gone only identical inputs differ (the scan never ends), which the identical-inputs test catches by hanging
    while (k < a.length && k < b.length && a[k] === b[k]) k += 1;
    ops = [
      { op: ' ', line: `... ${k} identical line(s), then the files differ (too large for a full diff) ...` },
      { op: '-', line: a[k] ?? '' },
      { op: '+', line: b[k] ?? '' },
    ];
  } else {
    ops = lcsOps(a, b);
  }
  // Stryker disable next-line ArrayDeclaration: equivalent mutant, `keep` is only read for truthiness, so a sparse array behaves like one filled with false
  const keep = new Array<boolean>(ops.length).fill(false);
  // a window wider than the diff shows everything; without the clamp a huge (or infinite) `context` made every change cost O(context)
  const reach = Math.min(context, ops.length);
  ops.forEach((o, idx) => {
    if (o.op === ' ') return;
    for (let d = -reach; d <= reach; d += 1) {
      // Stryker disable next-line ArithmeticOperator: equivalent mutant, d runs over the symmetric range -reach..reach, so idx - d visits the same positions
      const at = idx + d;
      // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: equivalent mutants, the guard only avoids writes outside the scratch array, and those are never read
      if (at >= 0 && at < ops.length) keep[at] = true;
    }
  });
  const out: string[] = [];
  // Stryker disable next-line BooleanLiteral: equivalent mutant, the first kept line is not preceded by "..." anyway because of the out.length > 0 check
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
