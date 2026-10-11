import type {
  ChunkRelation,
  Diagnostic,
  DraftFeature,
  DraftRef,
  DraftScenario,
  DraftStep,
  ErrorCode,
  FixtureDescriptor,
  JsonObject,
  JsonValue,
  Severity,
  SourceRange,
  StepKind,
} from '../contracts/index.ts';
import { canonicalJson, normalizeForQuote, normalizeText, sha256Hex } from '../util/index.ts';
import type { HandleEntry } from './prompt.ts';
import type { Extraction, ExtractionRef } from './schema.ts';

export const MAX_STEPS_PER_SCENARIO = 25;
const MAX_TAGS = 20;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/;
const PARAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SECRET_TOKEN = /<secret:([^<>\s]+)>/g;

const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have how i if in into is it its may might must no not of on or ' +
    'our out shall she should so some such than that the their them then there these they this those to up us was we were what when where which ' +
    'while who will with would you your user users page pages'
  ).split(' '),
);

export interface ValidationContext {
  docUri: string;
  sectionRange: SourceRange;
  handles: ReadonlyMap<string, HandleEntry>;
  minQuoteChars: number;
  fixtures: readonly FixtureDescriptor[];
  secretNames: readonly string[];
  rejectedFingerprints: ReadonlySet<string>;
}

export interface ValidationOutput {
  drafts: DraftFeature[];
  notTestable: { chunkId: string; reason: string }[];
  diagnostics: Diagnostic[];
}

interface WRef {
  entry: HandleEntry;
  relation: ChunkRelation;
  quote: string | null;
}

interface WFixture {
  name: string;
  args: { name: string; value: string | number | boolean }[];
}

interface WStep {
  kind: StepKind;
  text: string;
  grounding: 'quoted' | 'inferred';
  raw: ExtractionRef[];
  refs: WRef[];
  nature: 'objective' | 'subjective' | null;
  requiresState: boolean;
  fixture: WFixture | null;
  params: { name: string; value: string }[];
}

interface WScenario {
  title: string;
  tags: string[];
  raw: ExtractionRef[];
  refs: WRef[];
  steps: WStep[];
}

interface WFeature {
  title: string;
  story: { asA: string; iWant: string; soThat: string | null } | null;
  description: string | null;
  tags: string[];
  raw: ExtractionRef[];
  refs: WRef[];
  scenarios: WScenario[];
}

/** Scenario fingerprint as defined in SPEC 8.2 (the planner computes the stored one with the same formula). */
export function scenarioFingerprint(title: string, steps: readonly { kind: string; text: string }[]): string {
  return sha256Hex(
    canonicalJson({ t: normalizeForQuote(title), s: steps.map((s) => [s.kind, normalizeForQuote(s.text)]) }),
  );
}

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0];
    if (t.length >= 2 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** Returns the substring of `text` that matches `value` case-insensitively, preserving the text's own casing. */
function verbatimSlice(text: string, value: string): string | undefined {
  const lowerText = text.toLowerCase();
  const lowerValue = value.toLowerCase();
  const idx = lowerText.indexOf(lowerValue);
  if (idx >= 0 && lowerText.length === text.length) return text.slice(idx, idx + value.length);
  return normalizeForQuote(text).includes(normalizeForQuote(value)) ? value : undefined;
}

function occursVerbatim(text: string, value: string): boolean {
  return normalizeForQuote(text).includes(normalizeForQuote(value));
}

/** True when `String(value)` appears in `text` as a whole numeric token (not inside a longer number or word). */
function numberOccursAsToken(text: string, value: number): boolean {
  const needle = String(value);
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : (text[idx - 1] ?? '');
    const after = text[idx + needle.length] ?? '';
    const afterNext = text[idx + needle.length + 1] ?? '';
    const beforeOk = !/[\p{L}\p{N}_.]/u.test(before) || (before === '.' && !/\p{N}/u.test(text[idx - 2] ?? ''));
    const afterOk = !/[\p{L}\p{N}_]/u.test(after) && !(after === '.' && /\p{N}/u.test(afterNext)) && !(after === ',' && /\p{N}/u.test(afterNext));
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
}

function cleanTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = normalizeText(raw).replace(/^@+/, '');
    if (!TAG_PATTERN.test(t)) continue;
    // `fuzzy` is a runner-honored directive tag and must never be reachable from model output (R-EX3).
    if (t.toLowerCase() === 'fuzzy') continue;
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function validateExtraction(extraction: Extraction, ctx: ValidationContext): ValidationOutput {
  const diagnostics: Diagnostic[] = [];
  const catalog = new Map(ctx.fixtures.map((f) => [f.name, f]));
  const secretNames = new Set(ctx.secretNames);

  const diag = (
    code: ErrorCode,
    severity: Severity,
    message: string,
    details: JsonObject,
    range: SourceRange = ctx.sectionRange,
  ): void => {
    diagnostics.push({ code, severity, message, uri: ctx.docUri, range, details });
  };

  const resolveHandle = (raw: string): HandleEntry | undefined => {
    const m = /^\s*\[?\s*(c\d+)\s*\]?\s*$/i.exec(raw);
    return m === null ? undefined : ctx.handles.get((m[1] ?? '').toLowerCase());
  };

  // ───────── stage 1 (schema) already happened; build the working tree.
  let features: WFeature[] = extraction.features.map((f) => ({
    title: f.title,
    story: f.story,
    description: f.description,
    tags: f.tags,
    raw: f.sources,
    refs: [],
    scenarios: f.scenarios.map((s) => ({
      title: s.title,
      tags: s.tags,
      raw: s.sources,
      refs: [],
      steps: s.steps.map((st) => ({
        kind: st.kind,
        text: st.text,
        grounding: st.grounding,
        raw: st.sources,
        refs: [],
        nature: st.nature,
        requiresState: st.requiresState === true,
        fixture: st.fixture,
        params: st.params,
      })),
    })),
  }));

  // ───────── stage 2: handles
  const mapHandles = (raw: readonly ExtractionRef[], where: JsonObject): WRef[] => {
    const out: WRef[] = [];
    for (const r of raw) {
      const entry = resolveHandle(r.handle);
      if (entry === undefined) {
        diag('EXTRACT_QUOTE_NOT_FOUND', 'warning', `Unknown chunk handle "${r.handle.slice(0, 40)}"; reference dropped`, {
          ...where,
          handle: r.handle.slice(0, 40),
        });
        continue;
      }
      const relation: ChunkRelation = r.relation === 'source' && entry.isContext ? 'context' : r.relation;
      out.push({ entry, relation, quote: r.quote });
    }
    return out;
  };
  for (const f of features) {
    f.refs = mapHandles(f.raw, { feature: f.title });
    for (const s of f.scenarios) {
      s.refs = mapHandles(s.raw, { feature: f.title, scenario: s.title });
      s.steps.forEach((st, i) => {
        st.refs = mapHandles(st.raw, { feature: f.title, scenario: s.title, step: i });
      });
    }
  }

  // ───────── stage 3: quote grounding
  const quoteIsGrounded = (entry: HandleEntry, quote: string | null): boolean => {
    if (quote === null) return false;
    const q = normalizeForQuote(quote);
    if (q.length === 0) return false;
    // Only the raw chunk text counts: a quote that matches just the entity-escaped rendering shown to the model
    // (`&lt; / document >`) is not a substring of the document and must not be stored as one.
    const raw = normalizeForQuote(entry.text);
    return raw.includes(q) && q.length >= Math.min(ctx.minQuoteChars, raw.length);
  };
  const groundQuotes = (refs: readonly WRef[], where: JsonObject): WRef[] => {
    const out: WRef[] = [];
    const seen = new Set<string>();
    for (const r of refs) {
      const grounded = quoteIsGrounded(r.entry, r.quote);
      if (r.relation === 'source' && !grounded) {
        diag(
          'EXTRACT_QUOTE_NOT_FOUND',
          'warning',
          `Quote is not a verbatim excerpt of chunk ${r.entry.handle}; reference dropped`,
          { ...where, handle: r.entry.handle, chunkId: r.entry.chunk.id },
          r.entry.chunk.range,
        );
        continue;
      }
      const quote = grounded && r.quote !== null ? normalizeText(r.quote) : null;
      const key = `${r.entry.chunk.id}|${r.relation}|${quote ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ entry: r.entry, relation: r.relation, quote });
    }
    return out;
  };
  for (const f of features) {
    f.refs = groundQuotes(f.refs, { feature: f.title });
    for (const s of f.scenarios) {
      s.refs = groundQuotes(s.refs, { feature: f.title, scenario: s.title });
      s.steps.forEach((st, i) => {
        st.refs = groundQuotes(st.refs, { feature: f.title, scenario: s.title, step: i });
      });
    }
  }

  // ───────── stage 4: grounding and inheritance
  const sourceRefs = (refs: readonly WRef[]): WRef[] => refs.filter((r) => r.relation === 'source');
  features = features.filter((f) => {
    if (sourceRefs(f.refs).length > 0) return true;
    diag('EXTRACT_UNGROUNDED', 'warning', `Feature "${f.title.slice(0, 80)}" has no verbatim source quote; dropped with its scenarios`, {
      feature: f.title,
      scenarios: f.scenarios.length,
    });
    return false;
  });
  for (const f of features) {
    const featureSources = sourceRefs(f.refs);
    const featureQuoteTokens = new Set<string>();
    for (const r of featureSources) for (const t of tokens(r.quote ?? '')) featureQuoteTokens.add(t);
    f.scenarios = f.scenarios.filter((s) => {
      if (sourceRefs(s.refs).length > 0) return true;
      const shared = [...tokens(s.title)].some((t) => featureQuoteTokens.has(t));
      if (!shared) {
        diag('EXTRACT_UNGROUNDED', 'warning', `Scenario "${s.title.slice(0, 80)}" has no verbatim source quote and shares no term with its feature; dropped`, {
          feature: f.title,
          scenario: s.title,
        });
        return false;
      }
      s.refs = [...s.refs, ...featureSources.map((r) => ({ ...r }))];
      return true;
    });
    for (const s of f.scenarios) {
      s.steps.forEach((st, i) => {
        if (st.grounding === 'quoted' && sourceRefs(st.refs).length === 0) {
          st.grounding = 'inferred';
          diag('EXTRACT_UNGROUNDED', 'info', 'Step cites no verbatim quote; downgraded to inferred', {
            feature: f.title,
            scenario: s.title,
            step: i,
          });
        }
      });
    }
  }

  // ───────── stage 5: step sanity
  const hasAction = (s: WScenario): boolean => s.steps.some((st) => st.kind === 'when' || st.kind === 'then');
  for (const f of features) {
    f.scenarios = f.scenarios.filter((s) => {
      const where = { feature: f.title, scenario: s.title };
      s.title = normalizeText(s.title);
      if (s.title === '') {
        diag('EXTRACT_UNGROUNDED', 'warning', 'Scenario has an empty title; dropped', where);
        return false;
      }
      s.steps = s.steps.filter((st) => {
        st.text = normalizeText(st.text);
        if (st.text === '') {
          diag('EXTRACT_UNGROUNDED', 'info', 'Step has empty text; dropped', where);
          return false;
        }
        return true;
      });
      if (s.steps.length > MAX_STEPS_PER_SCENARIO) {
        diag('EXTRACT_UNGROUNDED', 'warning', `Scenario "${s.title.slice(0, 80)}" has more than ${MAX_STEPS_PER_SCENARIO} steps; dropped`, {
          ...where,
          steps: s.steps.length,
        });
        return false;
      }
      if (!hasAction(s)) {
        diag('EXTRACT_UNGROUNDED', 'warning', `Scenario "${s.title.slice(0, 80)}" has no when or then step; dropped`, where);
        return false;
      }
      for (const st of s.steps) {
        if (st.kind !== 'then') st.nature = null;
        if (st.kind !== 'given') st.requiresState = false;
      }
      return true;
    });
  }
  features = features.filter((f) => {
    f.title = normalizeText(f.title);
    if (f.title === '') {
      diag('EXTRACT_UNGROUNDED', 'warning', 'Feature has an empty title; dropped', {});
      return false;
    }
    return true;
  });

  // ───────── stage 6: params
  for (const f of features) {
    for (const s of f.scenarios) {
      s.steps.forEach((st, i) => {
        const kept: { name: string; value: string }[] = [];
        for (const p of st.params) {
          const name = p.name.trim();
          const value = normalizeText(p.value);
          const slice = value === '' ? undefined : verbatimSlice(st.text, value);
          if (!PARAM_NAME_PATTERN.test(name) || slice === undefined) {
            diag('EXTRACT_QUOTE_NOT_FOUND', 'info', `Param "${name.slice(0, 40)}" is not a verbatim part of the step text; dropped`, {
              feature: f.title,
              scenario: s.title,
              step: i,
              param: name.slice(0, 40),
            });
            continue;
          }
          if (kept.some((k) => k.name === name)) continue;
          kept.push({ name, value: slice });
        }
        st.params = kept;
      });
    }
  }

  // ───────── stage 7: fixtures (R-FX1)
  const validateFixture = (st: WStep, fx: WFixture): { ok: true; call: JsonObject } | { ok: false; reason: string } => {
    if (st.kind !== 'given') return { ok: false, reason: 'fixtures are only allowed on given steps' };
    const descriptor = catalog.get(fx.name.trim());
    if (descriptor === undefined) return { ok: false, reason: `fixture "${fx.name.slice(0, 60)}" is not in the catalog` };
    const given = new Map<string, string | number | boolean>();
    for (const a of fx.args) {
      if (given.has(a.name)) return { ok: false, reason: `duplicate argument "${a.name}"` };
      if (!Object.hasOwn(descriptor.params, a.name)) return { ok: false, reason: `unknown argument "${a.name.slice(0, 60)}"` };
      given.set(a.name, a.value);
    }
    const call: JsonObject = {};
    for (const [pname, spec] of Object.entries(descriptor.params)) {
      const v = given.get(pname);
      if (v === undefined) {
        if (spec.optional === true) continue;
        return { ok: false, reason: `missing required argument "${pname}"` };
      }
      if (typeof v !== spec.type) return { ok: false, reason: `argument "${pname}" must be a ${spec.type}` };
      if (typeof v === 'number' && !Number.isFinite(v)) return { ok: false, reason: `argument "${pname}" must be finite` };
      if (typeof v === 'string') {
        if (spec.enum !== undefined && !spec.enum.includes(v)) return { ok: false, reason: `argument "${pname}" is not one of the allowed values` };
        if (spec.derived !== true && (v.trim() === '' || !occursVerbatim(st.text, v))) {
          return { ok: false, reason: `argument "${pname}" does not occur verbatim in the step text` };
        }
      }
      if (spec.derived !== true) {
        // Non-derived arguments must be tied to the step text (SPEC Q8): strings verbatim (above), numbers as a whole
        // token, and booleans cannot be tied to text at all, so they require `derived: true`.
        if (typeof v === 'number' && !numberOccursAsToken(st.text, v)) {
          return { ok: false, reason: `argument "${pname}" does not occur in the step text` };
        }
        if (typeof v === 'boolean') {
          return { ok: false, reason: `argument "${pname}" is a boolean that is not marked derived` };
        }
      }
      call[pname] = v as JsonValue;
    }
    return { ok: true, call };
  };
  const fixtureCalls = new Map<WStep, { name: string; args: JsonObject }>();
  for (const f of features) {
    for (const s of f.scenarios) {
      s.steps.forEach((st, i) => {
        if (st.fixture === null) return;
        const result = validateFixture(st, st.fixture);
        if (result.ok) {
          fixtureCalls.set(st, { name: catalog.get(st.fixture.name.trim())?.name ?? st.fixture.name, args: result.call });
          return;
        }
        diag('EXTRACT_FIXTURE_INVALID', 'warning', `Fixture rejected: ${result.reason}`, {
          feature: f.title,
          scenario: s.title,
          step: i,
          fixture: st.fixture.name.slice(0, 60),
        });
        st.fixture = null;
        if (st.kind === 'given') st.requiresState = true;
      });
    }
  }

  // ───────── stage 8: secrets
  for (const f of features) {
    for (const s of f.scenarios) {
      s.steps = s.steps.filter((st, i) => {
        const unknown = [...st.text.matchAll(SECRET_TOKEN)].map((m) => m[1] ?? '').filter((n) => !secretNames.has(n));
        if (unknown.length === 0) return true;
        diag('SECRET_MISSING', 'warning', `Step references unknown secret(s) ${unknown.map((n) => `<secret:${n.slice(0, 40)}>`).join(', ')}; step dropped`, {
          feature: f.title,
          scenario: s.title,
          step: i,
          secrets: unknown.map((n) => n.slice(0, 40)),
        });
        return false;
      });
    }
    f.scenarios = f.scenarios.filter((s) => {
      if (hasAction(s)) return true;
      diag('EXTRACT_UNGROUNDED', 'warning', `Scenario "${s.title.slice(0, 80)}" has no when or then step left after dropping steps; dropped`, {
        feature: f.title,
        scenario: s.title,
      });
      return false;
    });
  }

  // ───────── stage 9: rejected fingerprints, then build drafts
  const toDraftRef = (r: WRef): DraftRef => {
    const ref: DraftRef = { chunkId: r.entry.chunk.id, relation: r.relation };
    if (r.quote !== null) ref.quote = r.quote;
    return ref;
  };
  const drafts: DraftFeature[] = [];
  for (const f of features) {
    const scenarios: DraftScenario[] = [];
    for (const s of f.scenarios) {
      const fp = scenarioFingerprint(s.title, s.steps);
      if (ctx.rejectedFingerprints.has(fp)) {
        diag('EXTRACT_UNGROUNDED', 'info', `Scenario "${s.title.slice(0, 80)}" was rejected earlier; not proposed again`, {
          feature: f.title,
          scenario: s.title,
          fingerprint: fp,
        });
        continue;
      }
      const steps: DraftStep[] = s.steps.map((st) => {
        const step: DraftStep = {
          kind: st.kind,
          text: st.text,
          grounding: st.grounding,
          sources: st.refs.map(toDraftRef),
          params: Object.fromEntries(st.params.map((p) => [p.name, p.value])),
        };
        if (st.nature !== null) step.nature = st.nature;
        if (st.requiresState) step.requiresState = true;
        const call = fixtureCalls.get(st);
        if (call !== undefined && st.fixture !== null) step.fixture = call;
        return step;
      });
      scenarios.push({ title: s.title, tags: cleanTags(s.tags), sources: s.refs.map(toDraftRef), steps });
    }
    if (scenarios.length === 0) {
      diag('EXTRACT_UNGROUNDED', 'info', `Feature "${f.title.slice(0, 80)}" has no scenarios left; dropped`, { feature: f.title });
      continue;
    }
    const draft: DraftFeature = { title: f.title, tags: cleanTags(f.tags), sources: f.refs.map(toDraftRef), scenarios };
    if (f.story !== null) {
      const asA = normalizeText(f.story.asA);
      const iWant = normalizeText(f.story.iWant);
      if (asA !== '' && iWant !== '') {
        const soThat = f.story.soThat === null ? '' : normalizeText(f.story.soThat);
        draft.story = soThat === '' ? { asA, iWant } : { asA, iWant, soThat };
      }
    }
    if (f.description !== null && normalizeText(f.description) !== '') draft.description = normalizeText(f.description);
    drafts.push(draft);
  }

  // ───────── notTestable (handles mapped back to chunk ids)
  const notTestable: { chunkId: string; reason: string }[] = [];
  const seenNt = new Set<string>();
  for (const nt of extraction.notTestable) {
    const entry = resolveHandle(nt.handle);
    if (entry === undefined || entry.isContext) {
      diag('EXTRACT_QUOTE_NOT_FOUND', 'info', `notTestable entry cites ${entry === undefined ? 'an unknown' : 'a context'} chunk; ignored`, {
        handle: nt.handle.slice(0, 40),
      });
      continue;
    }
    if (seenNt.has(entry.chunk.id)) continue;
    seenNt.add(entry.chunk.id);
    notTestable.push({ chunkId: entry.chunk.id, reason: normalizeText(nt.reason) || 'not testable through the UI' });
  }

  return { drafts, notTestable, diagnostics };
}
