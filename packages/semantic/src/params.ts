import {
  normalizeStepText,
  toJsonValue,
  type Binding,
  type JsonValue,
  type ParamDecl,
} from '@ai-bdd/contracts';
import { numbersIn } from './guards.js';

export type ParamsValidation =
  | { ok: true; params: Record<string, JsonValue> }
  | { ok: false; reason: string };

function schemaFor(decl: ParamDecl): JsonValue {
  switch (decl.type) {
    case 'int':
    case 'float':
      return { type: 'number' };
    case 'enum':
      return { type: 'string', enum: (decl.enumValues ?? []).map((value) => toJsonValue(value)) };
    default:
      return { type: 'string' };
  }
}

/** JSON Schema handed to the extractor model, built from the binding's ParamDecl[]. */
export function buildExtractionSchema(decls: ParamDecl[]): JsonValue {
  const properties: Record<string, JsonValue> = {};
  const required: JsonValue[] = [];
  for (const decl of decls) {
    properties[decl.name] = schemaFor(decl);
    if (decl.optional !== true) required.push(decl.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function asString(value: JsonValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Deterministic parameter validation (R-K5d). The extractor model proposes raw
 * values; this function is the source of truth:
 *
 * - every non-optional declared parameter must be present and non-empty
 * - `int` / `float` must parse and correspond to a numeric literal in the step
 * - `enum` values must be a member of `enumValues`
 * - `string` / `word` / `enum` values must occur verbatim (case-insensitively)
 *   in the step text unless the declaration sets `derived: true`
 */
export function validateParams(
  step: { text: string },
  binding: Binding,
  raw: Record<string, JsonValue>,
): ParamsValidation {
  const decls = binding.params ?? [];
  const params: Record<string, JsonValue> = {};
  const text = normalizeStepText(step.text);
  const lowerText = text.toLowerCase();
  const literals = numbersIn(text);

  for (const decl of decls) {
    const value = raw[decl.name];
    if (value === undefined || value === null || value === '') {
      if (decl.optional === true) continue;
      return { ok: false, reason: `missing parameter "${decl.name}"` };
    }

    switch (decl.type) {
      case 'int': {
        const parsed = typeof value === 'number' ? value : Number.parseInt(asString(value), 10);
        if (!Number.isFinite(parsed)) return { ok: false, reason: `int parameter "${decl.name}" is not a number` };
        if (!literals.includes(parsed)) {
          return { ok: false, reason: `int parameter "${decl.name}" has no matching numeric literal in the step text` };
        }
        params[decl.name] = parsed;
        break;
      }
      case 'float': {
        const parsed = typeof value === 'number' ? value : Number.parseFloat(asString(value));
        if (!Number.isFinite(parsed)) return { ok: false, reason: `float parameter "${decl.name}" is not a number` };
        if (!literals.includes(parsed)) {
          return { ok: false, reason: `float parameter "${decl.name}" has no matching numeric literal in the step text` };
        }
        params[decl.name] = parsed;
        break;
      }
      case 'enum': {
        const stringValue = asString(value);
        const allowed = decl.enumValues ?? [];
        if (!allowed.includes(stringValue)) {
          return { ok: false, reason: `enum parameter "${decl.name}" is not one of [${allowed.join(', ')}]` };
        }
        if (decl.derived !== true && !lowerText.includes(stringValue.toLowerCase())) {
          return { ok: false, reason: `enum parameter "${decl.name}" does not occur verbatim in the step text` };
        }
        params[decl.name] = stringValue;
        break;
      }
      default: {
        const stringValue = asString(value);
        if (decl.type !== 'any' && decl.derived !== true && !lowerText.includes(stringValue.toLowerCase())) {
          return { ok: false, reason: `${decl.type} parameter "${decl.name}" does not occur verbatim in the step text` };
        }
        params[decl.name] = stringValue;
        break;
      }
    }
  }

  return { ok: true, params };
}
