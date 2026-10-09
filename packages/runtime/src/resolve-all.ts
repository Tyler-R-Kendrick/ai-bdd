import { join } from 'node:path';
import type {
  Diagnostic,
  ModelSet,
  ResolvedConfig,
  ResolutionResult,
  Scenario,
  SpecDocument,
  Step,
  StepKind,
} from '@ai-bdd/contracts';
import { buildStrategies, createCacheStore } from '@ai-bdd/cache';
import { LockStore, createResolver } from '@ai-bdd/lock';
import { createRegistry, type Registry } from '@ai-bdd/registry';
import { createSemanticResolver } from '@ai-bdd/semantic';
import { discover } from './discover.js';
import { normalizeSpecGlobs } from './glob.js';
import { expandBindingGlobs } from './bindings.js';
import { inferKind, mergeOptions } from '@ai-bdd/spec-directives';

export interface ResolvedStepRow {
  uri: string;
  scenario: string;
  scenarioId: string;
  text: string;
  kind: StepKind;
  kindSource: string;
  resolution: ResolutionResult['resolution'];
  lockStatus?: string;
  score?: number;
  margin?: number;
}

export interface ResolveAllOptions {
  globs?: string[];
  frozen?: boolean;
}

/**
 * Resolves every step of every spec without opening a driver session, which is
 * what `ai-bdd resolve`, `ai-bdd lint` and `ai-bdd lock verify` need.
 */
export async function resolveAll(
  config: ResolvedConfig,
  models: ModelSet,
  options: ResolveAllOptions = {},
): Promise<{ rows: ResolvedStepRow[]; diagnostics: Diagnostic[]; lock: LockStore }> {
  const diagnostics: Diagnostic[] = [];
  const registry: Registry = createRegistry({ config: { kinds: config.kinds } });
  for (const file of expandBindingGlobs(config)) {
    try {
      const module = (await import(file)) as { register?: (ctx: unknown) => void | Promise<void> };
      if (typeof module.register === 'function') await module.register({ registry, config });
    } catch (error) {
      diagnostics.push({
        code: 'CONFIG_INVALID',
        severity: 'error',
        message: `could not load bindings from ${file}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const globs = normalizeSpecGlobs(config.projectRoot, options.globs ?? config.specs);
  const conceptGlobs = normalizeSpecGlobs(config.projectRoot, config.concepts).filter((glob) => glob.endsWith('.cpt'));
  const discovery = discover(config.projectRoot, globs, conceptGlobs);
  diagnostics.push(...discovery.diagnostics);

  const lock = LockStore.load(join(config.projectRoot, 'ai-bdd.lock.json'));
  const semantic = createSemanticResolver({
    embedder: models.embed,
    extractor: models.extract,
    config: {
      threshold: config.resolution.threshold,
      margin: config.resolution.margin,
      ...(config.resolution.semantic.guards !== undefined ? { guards: config.resolution.semantic.guards } : {}),
      kinds: config.kinds,
      embedCacheDir: join(config.projectRoot, config.cache.dir, 'embeddings'),
    },
  });
  const resolver = createResolver({
    registry,
    semantic,
    lock,
    config: {
      threshold: config.resolution.threshold,
      margin: config.resolution.margin,
      allowAgentSetup: config.resolution.allowAgentSetup,
      semantic: { enabled: config.resolution.semantic.enabled },
    },
  });

  const rows: ResolvedStepRow[] = [];
  for (const document of discovery.documents) {
    for (const scenario of document.scenarios) {
      for (const step of scenario.steps) {
        rows.push(
          await resolveRow(registry, resolver as never, document, scenario, step, options.frozen ?? false, config.kinds),
        );
      }
    }
  }
  return { rows, diagnostics, lock };
}

async function resolveRow(
  registry: Registry,
  resolver: { resolve(step: Step, ctx: { frozen: boolean }): Promise<ResolutionResult> },
  document: SpecDocument,
  scenario: Scenario,
  step: Step,
  frozen: boolean,
  kinds: ResolvedConfig['kinds'],
): Promise<ResolvedStepRow> {
  const options = mergeOptions({}, document.options, scenario.options, step.options);
  const probe = registry.matchExact(step.text);
  const bindingKind = probe.matches[0]?.binding.kind;
  const inferred = inferKind({
    text: step.text,
    ...(step.keyword !== undefined ? { keyword: step.keyword } : {}),
    options,
    ...(bindingKind !== undefined ? { bindingKind } : {}),
    config: { kinds },
  });
  const kind = step.kindSource === 'keyword' ? step.kind : inferred.kind;
  const kindSource = step.kindSource === 'keyword' ? step.kindSource : inferred.kindSource;
  try {
    const result = await resolver.resolve({ ...step, kind, kindSource }, { frozen });
    const resolution = result.resolution;
    return {
      uri: document.uri,
      scenario: scenario.name,
      scenarioId: scenario.id,
      text: step.text,
      kind: result.kind,
      kindSource: result.kindSource,
      resolution,
      ...(result.lockStatus !== undefined ? { lockStatus: result.lockStatus } : {}),
      ...(resolution.type === 'semantic' ? { score: resolution.score, margin: resolution.margin } : {}),
    };
  } catch (error) {
    const payload = error as { code?: string; message?: string };
    return {
      uri: document.uri,
      scenario: scenario.name,
      scenarioId: scenario.id,
      text: step.text,
      kind,
      kindSource,
      resolution: {
        type: 'unbound',
        reason: 'no-binding',
        message: `${payload.code ?? 'ERROR'}: ${payload.message ?? String(error)}`,
      },
    };
  }
}

