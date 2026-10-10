// @ts-nocheck
import type {
  ArtifactRef,
  EvidenceStore,
  JsonObject,
  JudgeEvidence,
  Observation,
  Redactor,
} from '../contracts/index.ts';
import { renderTree, stableJson } from '../util/index.ts';

export interface EvidenceOptions {
  vision: boolean;
  maxTreeChars: number;
  maskingProven: boolean;
  redactor: Redactor;
}

/** A screenshot may reach a model or the run dir only when untainted, or masked on a driver that proves masking (R-JU3, R-SE2). */
export function screenshotAllowed(obs: Observation, maskingProven: boolean): boolean {
  const shot = obs.screenshot;
  if (shot === undefined) return false;
  return !obs.tainted || (shot.masked && maskingProven);
}

const TRUNCATED = '...[truncated]';

/** Same shape as the judge module's own evidence builder: redact first, then cut, never exceeding `max`. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= TRUNCATED.length) return text.slice(0, max);
  return text.slice(0, max - TRUNCATED.length) + TRUNCATED;
}

/**
 * Judge input for one observation: tree text without refs, redacted, truncated; screenshot only when allowed.
 * Built from the observation alone, so agent output can never reach the judge (R-JU1).
 */
export function toJudgeEvidence(obs: Observation, opts: EvidenceOptions): JudgeEvidence {
  const ev: JudgeEvidence = { treeText: truncate(opts.redactor.redact(renderTree(obs.nodes, { refs: false })), opts.maxTreeChars) };
  if (opts.vision && obs.screenshot !== undefined && screenshotAllowed(obs, opts.maskingProven)) {
    ev.screenshot = { png: obs.screenshot.png, sha256: obs.screenshot.sha256 };
  }
  return ev;
}

/** Best-effort evidence capture; a failing evidence store never changes a step outcome. */
export async function storeObservation(
  store: EvidenceStore,
  obs: Observation,
  opts: { redactor: Redactor; maskingProven: boolean; screenshot: boolean },
): Promise<ArtifactRef[]> {
  const refs: ArtifactRef[] = [];
  try {
    const doc: JsonObject = {
      route: opts.redactor.redact(obs.route),
      busy: obs.busy,
      tainted: obs.tainted,
      treeText: opts.redactor.redact(renderTree(obs.nodes, { refs: false })),
    };
    if (obs.title !== undefined) doc.title = opts.redactor.redact(obs.title);
    refs.push(await store.putArtifact('observation', stableJson(doc)));
  } catch {
    // evidence is best effort
  }
  if (opts.screenshot && obs.screenshot !== undefined && screenshotAllowed(obs, opts.maskingProven)) {
    try {
      refs.push(await store.putArtifact('screenshot', obs.screenshot.png));
    } catch {
      // evidence is best effort
    }
  }
  return refs;
}
