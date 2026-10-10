import { z } from 'zod';
import type { JsonObject, NodeQuery, NodeStates, Predicate } from '../contracts/index.ts';

/**
 * Model-output schema for check generation. Strict-provider friendly (SPEC A12): every key is required, absent values
 * are `null`, no regex/format keywords. `parseCheckgenOutput` normalizes the result to the contract `Predicate` type.
 */

export const NODE_STATE_KEYS = ['checked', 'disabled', 'expanded', 'selected', 'pressed', 'focused', 'busy', 'invalid'] as const satisfies readonly (keyof NodeStates)[];

const QuerySchema = z.strictObject({
  role: z.string().nullable().describe('ARIA role of the node, e.g. "button", "heading", "status". Required unless testId is given.'),
  name: z.string().nullable().describe('Accessible name to match, or null for any name.'),
  nameMatch: z.enum(['exact', 'contains']).nullable().describe('How name is compared (case-insensitive). null means exact.'),
  testId: z.string().nullable().describe('data-testid of the node, or null.'),
  within: z.strictObject({ role: z.string(), name: z.string() }).nullable().describe('Require an ancestor with this role and exact name, or null.'),
});

const TextValueSchema = z.strictObject({
  literal: z.string().nullable().describe('Literal expected text. Exactly one of literal/param must be non-null.'),
  param: z.string().nullable().describe('Name of a step param whose value is the expected text.'),
});

const ExistsSchema = z.strictObject({ op: z.literal('exists'), query: QuerySchema, negate: z.boolean().nullable().describe('true asserts that NO node matches. null means false.') });
const CountSchema = z.strictObject({ op: z.literal('count'), query: QuerySchema, cmp: z.enum(['eq', 'gte', 'lte']), value: z.number() });
const TextSchema = z.strictObject({ op: z.literal('text'), query: QuerySchema, match: z.enum(['equals', 'contains']), value: TextValueSchema });
const StateSchema = z.strictObject({ op: z.literal('state'), query: QuerySchema, state: z.enum(NODE_STATE_KEYS), value: z.boolean() });
const RouteSchema = z.strictObject({ op: z.literal('route'), match: z.enum(['equals', 'prefix']), value: z.string() });

const PredicateSchema = z.union([ExistsSchema, CountSchema, TextSchema, StateSchema, RouteSchema]);

export const CheckgenOutputSchema = z.strictObject({
  classification: z.enum(['change', 'invariant']).describe('"change" if the check must be false before the action; "invariant" if it also held before.'),
  predicates: z.array(PredicateSchema).describe('The predicates; all must hold.'),
});

const VARIANTS = {
  exists: ExistsSchema, count: CountSchema, text: TextSchema, state: StateSchema, route: RouteSchema,
} as const;

/** JSON schema sent as `ModelRequest.output.schema`. */
export function checkgenJsonSchema(): JsonObject {
  const raw = z.toJSONSchema(CheckgenOutputSchema) as Record<string, unknown>;
  delete raw['$schema'];
  return JSON.parse(JSON.stringify(raw)) as JsonObject;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fillQuery(q: unknown): unknown {
  if (!isObj(q)) return q;
  const w = isObj(q['within']) ? q['within'] : q['within'] ?? null;
  return {
    ...q,
    role: q['role'] ?? null, name: q['name'] ?? null, nameMatch: q['nameMatch'] ?? null, testId: q['testId'] ?? null, within: w,
  };
}

/** Accept the natural contract shape (optional keys omitted) by filling absent keys with null. */
function fillNulls(raw: unknown): unknown {
  if (!isObj(raw) || !Array.isArray(raw['predicates'])) return raw;
  const predicates = (raw['predicates'] as unknown[]).map((p) => {
    if (!isObj(p)) return p;
    switch (p['op']) {
      case 'exists': return { ...p, query: fillQuery(p['query']), negate: p['negate'] ?? null };
      case 'count':
      case 'state': return { ...p, query: fillQuery(p['query']) };
      case 'text': {
        const v = p['value'];
        return { ...p, query: fillQuery(p['query']), value: isObj(v) ? { ...v, literal: v['literal'] ?? null, param: v['param'] ?? null } : v };
      }
      default: return p;
    }
  });
  return { ...raw, predicates };
}

function formatIssues(prefix: string, err: z.ZodError): string[] {
  return err.issues.slice(0, 8).map((i) => `${prefix}${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`);
}

export type ParsedCheckgen = { ok: true; classification: 'change' | 'invariant'; predicates: Predicate[] } | { ok: false; errors: string[] };

function normQuery(q: z.infer<typeof QuerySchema>): NodeQuery {
  const out: NodeQuery = {};
  if (q.role !== null && q.role !== '') out.role = q.role;
  if (q.name !== null) out.name = q.name;
  if (q.nameMatch !== null) out.nameMatch = q.nameMatch;
  if (q.testId !== null && q.testId !== '') out.testId = q.testId;
  if (q.within !== null) out.within = { role: q.within.role, name: q.within.name };
  return out;
}

/** Validate untrusted model output and normalize it to contract predicates. Never throws. */
export function parseCheckgenOutput(raw: unknown): ParsedCheckgen {
  const filled = fillNulls(raw);
  const top = z.strictObject({ classification: z.enum(['change', 'invariant']), predicates: z.array(z.unknown()) }).safeParse(filled);
  if (!top.success) return { ok: false, errors: formatIssues('output ', top.error) };
  const errors: string[] = [];
  const predicates: Predicate[] = [];
  top.data.predicates.forEach((p, i) => {
    const prefix = `predicates[${i}]: `;
    const op = isObj(p) ? p['op'] : undefined;
    if (typeof op !== 'string' || !Object.hasOwn(VARIANTS, op)) {
      errors.push(`${prefix}op must be one of ${Object.keys(VARIANTS).join(', ')}`);
      return;
    }
    const parsed = VARIANTS[op as keyof typeof VARIANTS].safeParse(p);
    if (!parsed.success) {
      errors.push(...formatIssues(prefix, parsed.error));
      return;
    }
    const d = parsed.data;
    switch (d.op) {
      case 'exists': {
        const pr: Predicate = { op: 'exists', query: normQuery(d.query) };
        if (d.negate === true) pr.negate = true;
        predicates.push(pr);
        break;
      }
      case 'count':
        predicates.push({ op: 'count', query: normQuery(d.query), cmp: d.cmp, value: d.value });
        break;
      case 'text': {
        const { literal, param } = d.value;
        if ((literal === null) === (param === null)) {
          errors.push(`${prefix}text value must set exactly one of literal or param`);
          break;
        }
        predicates.push({ op: 'text', query: normQuery(d.query), match: d.match, value: literal !== null ? { literal } : { param: param as string } });
        break;
      }
      case 'state':
        predicates.push({ op: 'state', query: normQuery(d.query), state: d.state, value: d.value });
        break;
      case 'route':
        predicates.push({ op: 'route', match: d.match, value: d.value });
        break;
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, classification: top.data.classification, predicates };
}
