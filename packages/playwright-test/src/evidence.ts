import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { ArtifactRef, StepResult } from '@ai-bdd/sdk/contracts';

/** Upper bound on screenshots attached to one test, so a long scenario cannot flood the report. */
export const MAX_SCREENSHOT_ATTACHMENTS = 30;

export interface ScreenshotAttachment {
  name: string;
  body: Buffer;
}

async function runDirsNewestFirst(runsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    // Run ids are time-ordered (uuidv7), so a descending sort puts the newest run first.
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse()
      .map((name) => join(runsDir, name));
  } catch {
    return [];
  }
}

/**
 * Artifacts are content addressed and their `path` is relative to the run directory that wrote them. The engine does
 * not expose its run directory, so the artifact is looked up in the run directories under `runsDir`, newest first.
 * Returns null when it cannot be found: missing evidence never fails a test.
 */
export async function readArtifact(runDirs: readonly string[], ref: ArtifactRef): Promise<Buffer | null> {
  if (isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes('..')) return null;
  for (const dir of runDirs) {
    const abs = resolve(dir, ref.path);
    if (!abs.startsWith(resolve(dir) + sep)) continue;
    try {
      return await readFile(abs);
    } catch {
      // not in this run directory
    }
  }
  return null;
}

export interface FeatureArtifact {
  ref: ArtifactRef;
  name: string;
  body: Buffer | null;
  contentType: string;
}

/** Every artifact referenced by a feature result. A null body is a verification failure, never a silent omission. */
export async function collectFeatureArtifacts(runsDir: string, refs: readonly ArtifactRef[]): Promise<FeatureArtifact[]> {
  const runDirs = await runDirsNewestFirst(runsDir);
  const seen = new Set<string>();
  const out: FeatureArtifact[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}\0${ref.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const extension = ref.path.split('.').at(-1) ?? 'bin';
    out.push({
      ref, name: `${ref.kind}-${ref.sha256.slice(0, 12)}.${extension}`, body: await readArtifact(runDirs, ref),
      contentType: ref.kind === 'screenshot' ? 'image/png' : extension === 'json' ? 'application/json' : 'text/plain',
    });
  }
  return out;
}

/** Screenshot artifacts referenced by the step results, deduplicated by content hash and bounded in number. */
export async function collectScreenshots(runsDir: string, steps: readonly StepResult[]): Promise<ScreenshotAttachment[]> {
  const wanted: { stepIndex: number; ref: ArtifactRef }[] = [];
  const seen = new Set<string>();
  steps.forEach((step, stepIndex) => {
    for (const ref of step.evidence) {
      if (ref.kind !== 'screenshot' || seen.has(ref.sha256)) continue;
      seen.add(ref.sha256);
      wanted.push({ stepIndex, ref });
    }
  });
  if (wanted.length === 0) return [];
  const runDirs = await runDirsNewestFirst(runsDir);
  const out: ScreenshotAttachment[] = [];
  for (const { stepIndex, ref } of wanted.slice(0, MAX_SCREENSHOT_ATTACHMENTS)) {
    const body = await readArtifact(runDirs, ref);
    if (body !== null) out.push({ name: `step-${stepIndex + 1}-screenshot-${ref.sha256.slice(0, 8)}.png`, body });
  }
  return out;
}
