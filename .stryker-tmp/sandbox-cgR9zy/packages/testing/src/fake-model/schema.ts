// @ts-nocheck
import { AiBddError, type JsonObject, type JsonValue } from '@ai-bdd/sdk/contracts';
import type { FakeMatcher, FakeRespond, FakeRule, FakeRuleFile, FakeScriptStep } from './types.ts';

const PURPOSES = ['extract', 'act', 'checkgen', 'judge'] as const;
const RESPOND_KEYS = ['object', 'text', 'script', 'samples', 'byAttempt'] as const;

/** JSON Schema (draft 2020-12) of a fake rule file, for editors and docs. */
export const FAKE_RULE_FILE_JSON_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'ai-bdd fake model rule file',
  type: 'object',
  required: ['rules'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    rules: { type: 'array', items: { $ref: '#/$defs/rule' } },
  },
  $defs: {
    matcher: {
      oneOf: [
        { type: 'string' },
        { type: 'object', required: ['contains'], additionalProperties: false, properties: { contains: { type: 'string' } } },
        { type: 'object', required: ['notContains'], additionalProperties: false, properties: { notContains: { type: 'string' } } },
        { type: 'object', required: ['in'], additionalProperties: false, properties: { in: { type: 'array', items: { type: 'string' } } } },
      ],
    },
    scriptStep: {
      type: 'object',
      required: ['tool'],
      additionalProperties: false,
      properties: {
        tool: { type: 'string', minLength: 1 },
        args: {
          type: 'object',
          properties: {
            target: {
              type: 'object',
              required: ['role'],
              additionalProperties: false,
              properties: { role: { type: 'string' }, name: { type: 'string' }, within: { type: 'string' } },
            },
          },
        },
      },
    },
    respond: {
      type: 'object',
      minProperties: 1,
      maxProperties: 1,
      properties: {
        object: {},
        text: { type: 'string' },
        script: { type: 'array', items: { $ref: '#/$defs/scriptStep' } },
        samples: { type: 'array', minItems: 1 },
        byAttempt: { type: 'array', minItems: 1, items: { $ref: '#/$defs/respond' } },
      },
      additionalProperties: false,
    },
    rule: {
      type: 'object',
      required: ['id', 'purpose', 'respond'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        purpose: { enum: [...PURPOSES] },
        description: { type: 'string' },
        when: { type: 'object', additionalProperties: { $ref: '#/$defs/matcher' } },
        respond: { $ref: '#/$defs/respond' },
      },
    },
  },
};

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function isJson(v: unknown): v is JsonValue {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJson);
  if (isRecord(v)) return Object.values(v).every(isJson);
  return false;
}

class Problems {
  readonly list: string[] = [];
  add(path: string, msg: string): void {
    this.list.push(`${path}: ${msg}`);
  }
}

function checkMatcher(v: unknown, path: string, p: Problems): v is FakeMatcher {
  if (typeof v === 'string') return true;
  if (isRecord(v)) {
    const keys = Object.keys(v);
    const key = keys[0];
    if (keys.length === 1 && key === 'in') {
      if (Array.isArray(v['in']) && v['in'].every((x) => typeof x === 'string')) return true;
      p.add(path, '"in" must be an array of strings');
      return false;
    }
    if (keys.length === 1 && (key === 'contains' || key === 'notContains')) {
      if (typeof v[key] === 'string') return true;
      p.add(path, `"${key}" must be a string`);
      return false;
    }
  }
  p.add(path, 'matcher must be a string (equals), {"contains": string}, {"notContains": string} or {"in": string[]}');
  return false;
}

function checkTarget(v: unknown, path: string, p: Problems): void {
  if (!isRecord(v)) return p.add(path, 'target must be an object {role, name?, within?}');
  if (typeof v['role'] !== 'string' || v['role'] === '') p.add(`${path}.role`, 'must be a non-empty string');
  for (const k of ['name', 'within']) if (v[k] !== undefined && typeof v[k] !== 'string') p.add(`${path}.${k}`, 'must be a string');
  for (const k of Object.keys(v)) if (!['role', 'name', 'within'].includes(k)) p.add(`${path}.${k}`, 'unknown target key (allowed: role, name, within)');
}

function checkStep(v: unknown, path: string, p: Problems): v is FakeScriptStep {
  if (!isRecord(v)) {
    p.add(path, 'script step must be an object {tool, args?}');
    return false;
  }
  if (typeof v['tool'] !== 'string' || v['tool'] === '') p.add(`${path}.tool`, 'must be a non-empty string');
  for (const k of Object.keys(v)) if (k !== 'tool' && k !== 'args') p.add(`${path}.${k}`, 'unknown script step key (allowed: tool, args)');
  const args = v['args'];
  if (args !== undefined) {
    if (!isRecord(args) || !isJson(args)) p.add(`${path}.args`, 'must be a JSON object');
    else if (args['target'] !== undefined) checkTarget(args['target'], `${path}.args.target`, p);
  }
  return true;
}

function checkRespond(v: unknown, path: string, p: Problems, depth = 0): v is FakeRespond {
  if (!isRecord(v)) {
    p.add(path, 'respond must be an object with exactly one of: object, text, script, samples, byAttempt');
    return false;
  }
  const keys = Object.keys(v);
  const known = keys.filter((k) => (RESPOND_KEYS as readonly string[]).includes(k));
  if (keys.length !== 1 || known.length !== 1) {
    p.add(path, `respond must have exactly one of ${RESPOND_KEYS.join(', ')} (found: ${keys.join(', ') || 'none'})`);
    return false;
  }
  const key = known[0];
  const val = v[key as string];
  switch (key) {
    case 'object':
      if (!isJson(val)) p.add(`${path}.object`, 'must be JSON');
      break;
    case 'text':
      if (typeof val !== 'string') p.add(`${path}.text`, 'must be a string');
      break;
    case 'script':
      if (!Array.isArray(val)) p.add(`${path}.script`, 'must be an array');
      else val.forEach((s, i) => checkStep(s, `${path}.script[${i}]`, p));
      break;
    case 'samples':
      if (!Array.isArray(val) || val.length === 0) p.add(`${path}.samples`, 'must be a non-empty array');
      else if (!isJson(val)) p.add(`${path}.samples`, 'must be JSON');
      break;
    case 'byAttempt':
      if (!Array.isArray(val) || val.length === 0) p.add(`${path}.byAttempt`, 'must be a non-empty array');
      else if (depth >= 4) p.add(`${path}.byAttempt`, 'nested too deeply');
      else val.forEach((r, i) => checkRespond(r, `${path}.byAttempt[${i}]`, p, depth + 1));
      break;
  }
  return true;
}

function checkRule(v: unknown, path: string, p: Problems): void {
  if (!isRecord(v)) return p.add(path, 'rule must be an object');
  if (typeof v['id'] !== 'string' || v['id'] === '') p.add(`${path}.id`, 'must be a non-empty string');
  if (typeof v['purpose'] !== 'string' || !(PURPOSES as readonly string[]).includes(v['purpose'])) {
    p.add(`${path}.purpose`, `must be one of ${PURPOSES.join(', ')}`);
  }
  for (const k of Object.keys(v)) if (!['id', 'purpose', 'description', 'when', 'respond'].includes(k)) p.add(`${path}.${k}`, 'unknown rule key');
  const when = v['when'];
  if (when !== undefined) {
    if (!isRecord(when)) p.add(`${path}.when`, 'must be an object of dotted path -> matcher');
    else for (const [k, m] of Object.entries(when)) checkMatcher(m, `${path}.when[${JSON.stringify(k)}]`, p);
  }
  if (v['respond'] === undefined) p.add(`${path}.respond`, 'is required');
  else checkRespond(v['respond'], `${path}.respond`, p);
}

/**
 * Validate an unknown value as a rule file. Throws `CONFIG_INVALID` listing every problem.
 * `source` (a file name or label) is included in the message.
 */
export function validateFakeRuleFile(value: unknown, source = 'rule file'): FakeRuleFile {
  const p = new Problems();
  if (!isRecord(value)) {
    p.add('$', 'must be an object {"rules": [...]}');
  } else {
    for (const k of Object.keys(value)) if (k !== 'rules' && k !== '$schema') p.add(`$.${k}`, 'unknown key (allowed: rules)');
    const rules = value['rules'];
    if (!Array.isArray(rules)) p.add('$.rules', 'must be an array of rules');
    else rules.forEach((r, i) => checkRule(r, `$.rules[${i}]${isRecord(r) && typeof r['id'] === 'string' ? `(${r['id']})` : ''}`, p));
  }
  if (p.list.length > 0) {
    throw new AiBddError('CONFIG_INVALID', `Invalid fake model ${source}:\n  - ${p.list.join('\n  - ')}`, {
      details: { source, problems: p.list },
    });
  }
  const file = value as { rules: FakeRule[] };
  return { rules: file.rules };
}
