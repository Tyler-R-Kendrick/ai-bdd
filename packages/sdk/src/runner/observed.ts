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

/**
 * Judge input for one observation: tree text without refs, redacted, truncated; screenshot only when allowed.
 * Built from the observation alone, so agent output can never reach the judge (R-JU1).
 */
export function toJudgeEvidence(obs: Observation, opts: EvidenceOptions): JudgeEvidence {
  const text = opts.redactor.redact(renderTree(obs.nodes, { refs: false })).slice(0, opts.maxTreeChars);
  const ev: JudgeEvidence = { treeText: text };
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
