import {
  AiBddError,
  lockKey,
  type BindingMatch,
  type BindingSet,
  type Candidate,
  type LockEntry,
  type LockStatus,
  type Resolution,
  type ResolutionResult,
  type Step,
} from '@ai-bdd/contracts';
import type { BindingRegistry } from '@ai-bdd/registry';
import type { SemanticResolver, SemanticStep } from '@ai-bdd/semantic';
import { kindClassOf } from './kind-class.js';
import { revalidate } from './revalidate.js';
import type { LockStore } from './lock-store.js';

export interface ResolverConfig {
  threshold: number;
  margin: number;
  allowAgentSetup: boolean;
  semantic: { enabled: boolean };
}

export interface Resolver {
  resolve(step: Step, ctx: { frozen: boolean }): Promise<ResolutionResult>;
}

function statusOf(resolution: Resolution): LockEntry['status'] {
  switch (resolution.type) {
    case 'semantic':
      return 'semantic';
    case 'ambiguous':
      return 'ambiguous';
    case 'agent':
      return 'agent';
    default:
      return 'inferred-kind';
  }
}

/**
 * The resolution chain (section 8.1.1 steps 1-6): exact match, lock replay,
 * semantic resolution, agent fallback and undefined. Every non-exact outcome is
 * recorded in the lockfile (R-K5f).
 */
export function createResolver(opts: {
  registry: BindingRegistry;
  semantic: SemanticResolver;
  lock: LockStore;
  config: ResolverConfig;
}): Resolver {
  const { registry, semantic, lock, config } = opts;

  function semanticStep(step: Step): SemanticStep {
    const out: SemanticStep = { text: step.text, kind: step.kind };
    if (step.kindSource !== undefined) out.kindSource = step.kindSource;
    return out;
  }

  async function candidatesFor(step: Step, set: BindingSet, resolution: Resolution): Promise<Candidate[]> {
    if (resolution.type === 'semantic' || resolution.type === 'ambiguous') return resolution.candidates;
    if (resolution.type === 'agent' && config.semantic.enabled) {
      return semantic.explain({ text: step.text, kind: step.kind }, set);
    }
    return [];
  }

  async function freshResolution(step: Step, set: BindingSet): Promise<Resolution> {
    const mode = step.kind === 'assertion' ? 'assert' : 'act';
    if (config.semantic.enabled) {
      const result = await semantic.resolve(semanticStep(step), set);
      if (result !== null && result.type !== 'agent') return result;
      if (result !== null && result.type === 'agent') {
        if (step.kind === 'setup' && !config.allowAgentSetup) {
          return { type: 'unbound', reason: 'setup-unbound', message: `Setup step has no binding: "${step.text}"` };
        }
        return result;
      }
    }
    if (step.kind === 'setup' && !config.allowAgentSetup) {
      return { type: 'unbound', reason: 'setup-unbound', message: `Setup step has no binding: "${step.text}"` };
    }
    return { type: 'agent', mode, reason: 'no-match' };
  }

  async function record(
    step: Step,
    set: BindingSet,
    key: string,
    kindClass: LockEntry['kindClass'],
    resolution: Resolution,
  ): Promise<LockEntry> {
    const entry: LockEntry = {
      key,
      stepText: step.text,
      normalizedStepText: step.normalized,
      kind: step.kind,
      kindClass,
      status: statusOf(resolution),
      resolution,
      bindingSetHash: set.hash,
      candidates: await candidatesFor(step, set, resolution),
      updatedAt: lock.now().toISOString(),
    };
    if (resolution.type === 'semantic') entry.extraction = resolution.extraction;
    return entry;
  }

  return {
    async resolve(step: Step, ctx: { frozen: boolean }): Promise<ResolutionResult> {
      const kindClass = kindClassOf(step.kindSource);
      const key = lockKey({ normalizedStepText: step.normalized, kind: step.kind, kindClass });

      const { matches } = registry.matchExact(step.text, step.kind);
      const exactMatches = matches.filter(
        (match: BindingMatch) => !(step.kindSource === 'default' && match.binding.strictKind === true),
      );

      if (exactMatches.length > 1) {
        const set = registry.set();
        const candidates: Candidate[] = exactMatches.map((match) => ({
          bindingId: match.binding.id,
          bindingHash: match.binding.hash,
          score: 1,
        }));
        const resolution: Resolution = {
          type: 'ambiguous',
          reason: 'multiple-exact',
          candidates,
          message: `${exactMatches.length} bindings match "${step.text}" exactly`,
        };
        if (!ctx.frozen) lock.upsert(await record(step, set, key, kindClass, resolution));
        return { resolution, kind: step.kind, kindSource: step.kindSource, lockStatus: 'ambiguous', lockKey: key };
      }

      if (exactMatches.length === 1) {
        const match = exactMatches[0] as BindingMatch;
        const resolution: Resolution = {
          type: 'exact',
          bindingId: match.binding.id,
          bindingHash: match.binding.hash,
          params: match.params,
        };
        return { resolution, kind: step.kind, kindSource: step.kindSource, lockKey: key };
      }

      const set = registry.set();
      const existing = lock.get(key);

      if (ctx.frozen) {
        if (existing === undefined) {
          throw new AiBddError('RESOLUTION_NOT_LOCKED', `No lock entry for step "${step.text}" (key ${key})`);
        }
        const revalidated = await revalidate(existing, set, semantic);
        if (revalidated.status === 'changed') {
          throw new AiBddError('RESOLUTION_NOT_LOCKED', `Lock entry for step "${step.text}" changed (key ${key})`);
        }
        const lockStatus: LockStatus = revalidated.status === 'revalidated' ? 'revalidated' : 'unchanged';
        return {
          resolution: revalidated.entry.resolution,
          kind: step.kind,
          kindSource: step.kindSource,
          lockStatus,
          lockKey: key,
        };
      }

      if (existing !== undefined) {
        const revalidated = await revalidate(existing, set, semantic);
        if (revalidated.status === 'unchanged' || revalidated.status === 'revalidated') {
          if (revalidated.status === 'revalidated') lock.upsert(revalidated.entry);
          return {
            resolution: revalidated.entry.resolution,
            kind: step.kind,
            kindSource: step.kindSource,
            lockStatus: revalidated.status,
            lockKey: key,
          };
        }
      }

      const resolution = await freshResolution(step, set);
      lock.upsert(await record(step, set, key, kindClass, resolution));
      return {
        resolution,
        kind: step.kind,
        kindSource: step.kindSource,
        lockStatus: existing === undefined ? 'new' : 'changed',
        lockKey: key,
      };
    },
  };
}
