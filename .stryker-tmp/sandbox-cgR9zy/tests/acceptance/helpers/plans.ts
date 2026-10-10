// @ts-nocheck
import { existsSync, readFileSync } from 'node:fs';
import { loadPlansSync } from '@ai-bdd/sdk';
import type { DocPlan, Feature, Scenario, ScenarioRecording } from '@ai-bdd/sdk/contracts';
import type { Project } from './project.ts';
import { walkFiles } from './scan.ts';

/** Scenario titles of the corpus (extraction rules in packages/testing/corpus/tools/gen-rules.mjs). */
export const T = {
  upgrade: 'Upgrade from Free to Pro',
  upgradeVisible: 'Upgrade button is visible on the Free plan',
  tone: 'Friendly confirmation after upgrading',
  blocked: 'Downgrade is blocked with unpaid invoices',
  allowed: 'Downgrade goes through without unpaid invoices',
  todo: 'Added todo appears with its added time',
  sync: 'Sync indicator shows the last sync time',
  submitForm: 'Submit the form',
  shipping: 'Save the shipping street',
  login: 'Administrator signs in with the admin password',
  report: 'Report page finishes loading',
  release: 'Open the release notes',
} as const;

export interface FoundScenario {
  plan: DocPlan;
  feature: Feature;
  scenario: Scenario;
}

export function readPlans(project: Project): DocPlan[] {
  return loadPlansSync(project.plansDir);
}

export function allScenarios(plans: readonly DocPlan[]): FoundScenario[] {
  return plans.flatMap((plan) => plan.features.flatMap((feature) => feature.scenarios.map((scenario) => ({ plan, feature, scenario }))));
}

export function findScenario(plans: readonly DocPlan[], title: string): FoundScenario {
  const hit = allScenarios(plans).find((s) => s.scenario.title === title);
  if (hit === undefined) throw new Error(`scenario "${title}" not in plan; have: ${allScenarios(plans).map((s) => s.scenario.title).join(' | ')}`);
  return hit;
}

export function scenarioId(plans: readonly DocPlan[], title: string): string {
  return findScenario(plans, title).scenario.id;
}

export function findFeature(plans: readonly DocPlan[], title: string): Feature | undefined {
  return plans.flatMap((p) => p.features).find((f) => f.title === title);
}

/** Plan files by path relative to the plan dir (raw bytes as text) for byte-identity assertions. */
export function planFiles(project: Project): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of walkFiles(project.plansDir)) out[file.slice(project.plansDir.length + 1)] = readFileSync(file, 'utf8');
  return out;
}

export interface RecordingFile {
  path: string;
  driverId: string;
  recording: ScenarioRecording;
}

export function readRecordings(project: Project): RecordingFile[] {
  if (!existsSync(project.recordingsDir)) return [];
  return walkFiles(project.recordingsDir)
    .filter((f) => f.endsWith('.json'))
    .map((path) => ({
      path,
      driverId: path.slice(project.recordingsDir.length + 1).split('/')[0] ?? '',
      recording: JSON.parse(readFileSync(path, 'utf8')) as ScenarioRecording,
    }));
}

export function recordingOf(project: Project, id: string): ScenarioRecording | undefined {
  return readRecordings(project).find((r) => r.recording.scenarioId === id)?.recording;
}

export function recordingFiles(project: Project): string[] {
  return readRecordings(project).map((r) => r.path);
}
