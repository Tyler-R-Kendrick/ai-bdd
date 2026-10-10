// @ts-nocheck
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef, RunReport } from '@ai-bdd/sdk/contracts';
import type { Project } from './project.ts';
import { walkFiles } from './scan.ts';

/** Run directories under .ai-bdd/runs, oldest first (run ids are uuidv7, so name order is time order). */
export function runDirs(project: Project): string[] {
  if (!existsSync(project.runsDir)) return [];
  return readdirSync(project.runsDir)
    .sort()
    .map((n) => join(project.runsDir, n));
}

export function latestRunDir(project: Project): string {
  const dirs = runDirs(project);
  const last = dirs[dirs.length - 1];
  if (last === undefined) throw new Error(`no run directory under ${project.runsDir}`);
  return last;
}

export function readRunReport(runDir: string): RunReport {
  return JSON.parse(readFileSync(join(runDir, 'report.json'), 'utf8')) as RunReport;
}

export interface Manifest {
  runId: string;
  artifacts: ArtifactRef[];
  digest: string;
}
export function readManifest(runDir: string): Manifest {
  return JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as Manifest;
}

export function artifactFiles(runDir: string): string[] {
  return walkFiles(join(runDir, 'artifacts'));
}

/** All text artifacts of a run (JSON/txt), parsed lazily by kind. */
export function artifactsOfKind(runDir: string, kind: ArtifactRef['kind']): { ref: ArtifactRef; text: string }[] {
  return readManifest(runDir)
    .artifacts.filter((a) => a.kind === kind)
    .map((ref) => ({ ref, text: readFileSync(join(runDir, ref.path), 'utf8') }));
}

export function readEvents(runDir: string): Record<string, unknown>[] {
  const file = join(runDir, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
