import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { ArtifactKind, ArtifactRef, Diagnostic, EvidenceStore, Feature } from '../contracts/index.ts';
import { assertInsideRealRoot } from '../util/index.ts';

interface AttachmentDeclaration { path: string; kind: ArtifactKind }
const KINDS = new Set<ArtifactKind>([
  'screenshot', 'observation', 'act-transcript', 'action-log', 'judge-request', 'judge-response',
  'checkgen', 'extract-request', 'extract-response', 'report', 'test-report', 'formal-proof', 'log',
]);

function declarations(value: unknown): AttachmentDeclaration[] | string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'manifest must be an object';
  const artifacts = (value as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) return 'manifest has no artifacts array';
  const out: AttachmentDeclaration[] = [];
  for (const raw of artifacts) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'malformed artifact declaration';
    const entry = raw as Record<string, unknown>;
    if (typeof entry['path'] !== 'string' || typeof entry['kind'] !== 'string' || !KINDS.has(entry['kind'] as ArtifactKind)) {
      return 'artifact declaration needs a path and a valid kind';
    }
    const path = entry['path'];
    if (path === '' || isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      return `unsafe artifact path: ${JSON.stringify(path)}`;
    }
    out.push({ path, kind: entry['kind'] as ArtifactKind });
  }
  return out;
}

/** Copy checked-in supplemental evidence into this run's content-addressed, redacted artifact store. */
export async function attachSupplementalEvidence(
  feature: Feature,
  evidenceDir: string,
  store: EvidenceStore,
): Promise<{ refs: ArtifactRef[]; problems: Diagnostic[] }> {
  const root = resolve(evidenceDir, ...feature.id.split('/'));
  const manifestPath = join(root, 'manifest.json');
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { refs: [], problems: [] };
    return { refs: [], problems: [{ code: 'EVIDENCE_CORRUPT', severity: 'error', uri: feature.docUri, message: `cannot read supplemental evidence manifest for ${feature.id}` }] };
  }
  const problem = (message: string): { refs: ArtifactRef[]; problems: Diagnostic[] } => ({
    refs: [], problems: [{ code: 'EVIDENCE_CORRUPT', severity: 'error', uri: feature.docUri, message: `supplemental evidence for ${feature.id}: ${message}` }],
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return problem('manifest.json is not valid JSON');
  }
  const parsed = declarations(raw);
  if (typeof parsed === 'string') return problem(parsed);
  const refs: ArtifactRef[] = [];
  for (const declaration of parsed) {
    const file = resolve(root, declaration.path);
    if (!file.startsWith(root + sep)) return problem(`artifact escapes its feature directory: ${declaration.path}`);
    try {
      await assertInsideRealRoot(file, root);
      refs.push(await store.putArtifact(declaration.kind, await readFile(file)));
    } catch (error) {
      return problem(`cannot attach ${declaration.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { refs, problems: [] };
}
