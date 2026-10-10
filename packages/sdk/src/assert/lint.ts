import type { CheckProgram, LintCheckProgram, NodeKey, NodeQuery, Predicate } from '../contracts/index.ts';
import { normalizeForQuote, normalizeText } from '../util/index.ts';
import { findVolatile } from './volatile.ts';

/** A lint finding. `volatile` findings are about content stability; the rest are structural (SPEC §10.4 step 2). */
export interface LintIssue { message: string; volatile: boolean }

export type LintContext = Parameters<LintCheckProgram>[1];

function shorten(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function queryOf(p: Predicate): NodeQuery | undefined {
  return p.op === 'route' ? undefined : (p.query as NodeQuery | undefined);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Literal strings in a predicate that are compared against page content. */
export function literalsOf(p: Predicate): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  if (p.op === 'route') {
    if (typeof p.value === 'string') out.push({ where: 'route value', text: p.value });
    return out;
  }
  const q = queryOf(p);
  if (q) {
    if (typeof q.name === 'string') out.push({ where: 'query name', text: q.name });
    if (typeof q.testId === 'string') out.push({ where: 'query testId', text: q.testId });
    if (q.within && typeof q.within.name === 'string') out.push({ where: 'within name', text: q.within.name });
  }
  if (p.op === 'text') {
    const v = p.value as { literal?: unknown };
    if (typeof v?.literal === 'string') out.push({ where: 'text literal', text: v.literal });
  }
  return out;
}

/** Whether `query` would select a node described by the volatile key. Name-less queries only count for `text` predicates. */
function queryMatchesKey(p: Predicate, q: NodeQuery, key: NodeKey): boolean {
  if (nonEmpty(q.role) && q.role !== key.role) return false;
  if (nonEmpty(q.testId)) return false; // keys carry no test id; handled separately by the generator
  if (typeof q.name === 'string') {
    const want = normalizeText(q.name).toLowerCase();
    const have = normalizeText(key.name).toLowerCase();
    return q.nameMatch === 'contains' ? have.includes(want) : have === want;
  }
  return p.op === 'text' && nonEmpty(q.role);
}

export function lintDetailed(program: CheckProgram, ctx: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (message: string, volatile = false): void => { issues.push({ message, volatile }); };
  const preds = Array.isArray(program.predicates) ? program.predicates : [];

  if (preds.length === 0) add('program has no predicates');
  if (preds.length > ctx.maxPredicates) add(`program has ${preds.length} predicates; the maximum is ${ctx.maxPredicates}`);
  if (program.classification !== 'change' && program.classification !== 'invariant') {
    add(`classification must be "change" or "invariant", got ${JSON.stringify(program.classification)}`);
  }
  if (!ctx.actionPreceded && program.classification === 'change') {
    add('no action preceded this check, so the classification must be "invariant", not "change"');
  }

  const stepNorm = normalizeForQuote(ctx.stepText);
  const paramNorms = Object.values(ctx.params).map((v) => normalizeForQuote(v));

  preds.forEach((p, i) => {
    const label = `predicates[${i}]`;
    const q = queryOf(p);
    if (p.op !== 'route') {
      if (!q || typeof q !== 'object') {
        add(`${label}: ${p.op} predicate has no query`);
        return;
      }
      if (!nonEmpty(q.role) && !nonEmpty(q.testId)) add(`${label}: query must specify a role or a testId`);
    }
    if (p.op === 'count' && (typeof p.value !== 'number' || !Number.isInteger(p.value) || p.value < 0)) {
      add(`${label}: count value must be a non-negative integer`);
    }
    if (p.op === 'text') {
      const v = p.value as { literal?: unknown; param?: unknown };
      if (typeof v?.literal === 'string' && v.literal.length === 0 && p.match === 'contains') {
        add(`${label}: a contains match on an empty literal is vacuous`);
      }
    }
    if (p.op === 'route' && p.match === 'prefix' && (p.value === '' || p.value === '/')) add(`${label}: a route prefix of "${p.value}" matches every route, so it is vacuous`);
    if (p.op === 'count' && p.cmp === 'gte' && p.value === 0) add(`${label}: count >= 0 is always true, so it is vacuous`);

    for (const lit of literalsOf(p)) {
      for (const m of findVolatile(lit.text)) {
        const mn = normalizeForQuote(m.text);
        const authored = stepNorm.includes(mn) || paramNorms.some((pv) => pv.includes(mn));
        if (!authored) {
          add(
            `${label}: ${lit.where} "${shorten(lit.text)}" contains volatile content (${m.kind} "${shorten(m.text)}") ` +
              'that does not appear in the step text or params; do not assert on values that change between runs',
            true,
          );
        }
      }
    }

    if (q && typeof q === 'object') {
      for (const key of ctx.volatileNodeKeys) {
        if (queryMatchesKey(p, q, key)) {
          add(
            `${label}: query matches a node whose content changed between the settled observation and the later probe ` +
              `(role "${shorten(key.role)}", name "${shorten(key.name)}"); do not assert on volatile nodes`,
            true,
          );
          break;
        }
      }
    }
  });
  return issues;
}

export const lintCheckProgram: LintCheckProgram = (program, ctx) => lintDetailed(program, ctx).map((i) => i.message);
