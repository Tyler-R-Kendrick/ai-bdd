import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AiBddError,
  sha256Hex,
  type ActProgram,
  type CheckProgram,
  type InvalidationContext,
  type InvalidationResult,
  type InvalidationStrategy,
  type Observation,
  type ObservedNode,
  type Selector,
} from '@ai-bdd/contracts';

export interface StrategyOptions {
  files?: Record<string, string[]>;
  buildChecksum?: string;
  manual?: string;
  custom?: InvalidationStrategy[];
  /** Base directory for the files-hash strategy (defaults to process.cwd()). */
  baseDir?: string;
}

function selectorKey(selector: Pick<Selector, 'role' | 'name' | 'testId'>): string {
  return `${selector.role}|${selector.name ?? ''}|${selector.testId ?? ''}`;
}

function observationKeys(observation: Observation): Set<string> {
  const keys = new Set<string>();
  const walk = (nodes: ObservedNode[]): void => {
    for (const node of nodes) {
      keys.add(selectorKey({ role: node.role, name: node.name, ...(node.testId !== undefined ? { testId: node.testId } : {}) }));
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(observation.nodes);
  return keys;
}

/**
 * `effect-verify` (default): the recorded effect signature must still hold in
 * the current observation. Returns `unknown` when the effect cannot be fully
 * checked; the store treats `unknown` as valid for this strategy only.
 */
export function effectVerify(): InvalidationStrategy {
  return {
    name: 'effect-verify',
    fingerprint(): string | null {
      return null;
    },
    validate(entry, ctx: InvalidationContext): InvalidationResult {
      const program: ActProgram | CheckProgram = entry.program;
      if (!('effect' in program)) return 'unknown';
      if (ctx.observation === undefined) return 'unknown';
      const keys = observationKeys(ctx.observation);
      let unknown = false;
      for (const element of program.effect.elements) {
        const present = keys.has(selectorKey(element.selector));
        if (element.change === 'appeared' && !present) return 'invalid';
        if (element.change === 'disappeared' && present) return 'invalid';
        if (element.change === 'state') {
          if (!present) return 'invalid';
          unknown = true;
        }
      }
      return unknown ? 'unknown' : 'valid';
    },
  };
}

/** `route-fingerprint`: the observed route must equal the route at write time. */
export function routeFingerprint(): InvalidationStrategy {
  return {
    name: 'route-fingerprint',
    fingerprint(ctx: InvalidationContext): string | null {
      return ctx.observation?.route ?? null;
    },
    validate(entry, ctx: InvalidationContext): InvalidationResult {
      if (entry.fingerprint === undefined) return 'unknown';
      const current = ctx.observation?.route;
      if (current === undefined) return 'unknown';
      return current === entry.fingerprint ? 'valid' : 'invalid';
    },
  };
}

/** `build-checksum`: the build checksum must be unchanged. */
export function buildChecksum(value: string | undefined): InvalidationStrategy {
  return {
    name: 'build-checksum',
    fingerprint(): string | null {
      return value ?? null;
    },
    validate(entry): InvalidationResult {
      if (entry.fingerprint === undefined || value === undefined) return 'unknown';
      return entry.fingerprint === value ? 'valid' : 'invalid';
    },
  };
}

/** `manual`: an operator-controlled string must be unchanged. */
export function manual(value: string | undefined): InvalidationStrategy {
  return {
    name: 'manual',
    fingerprint(): string | null {
      return value ?? null;
    },
    validate(entry): InvalidationResult {
      if (entry.fingerprint === undefined || value === undefined) return 'unknown';
      return entry.fingerprint === value ? 'valid' : 'invalid';
    },
  };
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`, 'u');
}

function routeMatches(pattern: string, route: string | undefined): boolean {
  if (pattern === '*') return true;
  if (route === undefined) return false;
  return globToRegExp(pattern).test(route);
}

function fileDigest(path: string): string {
  try {
    return sha256Hex(readFileSync(path));
  } catch {
    return 'missing';
  }
}

function computeFilesHash(files: Record<string, string[]>, baseDir: string, ctx: InvalidationContext): string | null {
  const route = ctx.observation?.route;
  const matched = Object.keys(files).filter((pattern) => routeMatches(pattern, route));
  if (matched.length === 0) return null;
  const lines: string[] = [];
  for (const pattern of matched.sort()) {
    const globs = files[pattern] ?? [];
    for (const glob of globs) {
      let expanded: string[];
      try {
        expanded = globSync(glob, { cwd: baseDir });
      } catch {
        expanded = [];
      }
      for (const relative of [...expanded].sort()) {
        lines.push(`${relative}:${fileDigest(join(baseDir, relative))}`);
      }
    }
  }
  if (lines.length === 0) return null;
  return sha256Hex(lines.join('\n'));
}

/** `files-hash`: hash of the files mapped to the current route. */
export function filesHash(files: Record<string, string[]>, baseDir = process.cwd()): InvalidationStrategy {
  return {
    name: 'files-hash',
    fingerprint(ctx: InvalidationContext): string | null {
      return computeFilesHash(files, baseDir, ctx);
    },
    validate(entry, ctx: InvalidationContext): InvalidationResult {
      if (entry.fingerprint === undefined) return 'unknown';
      const current = computeFilesHash(files, baseDir, ctx);
      if (current === null) return 'unknown';
      return current === entry.fingerprint ? 'valid' : 'invalid';
    },
  };
}

/**
 * Build strategies by name. Built-ins are resolved directly; any other name is
 * looked up in `opts.custom` (the custom loader). Unknown names are an error.
 */
export function buildStrategies(names: string[], opts: StrategyOptions = {}): InvalidationStrategy[] {
  const out: InvalidationStrategy[] = [];
  for (const name of names) {
    switch (name) {
      case 'effect-verify':
        out.push(effectVerify());
        break;
      case 'route-fingerprint':
        out.push(routeFingerprint());
        break;
      case 'build-checksum':
        out.push(buildChecksum(opts.buildChecksum));
        break;
      case 'files-hash':
        out.push(filesHash(opts.files ?? {}, opts.baseDir ?? process.cwd()));
        break;
      case 'manual':
        out.push(manual(opts.manual));
        break;
      default: {
        const custom = (opts.custom ?? []).find((strategy) => strategy.name === name);
        if (custom === undefined) {
          throw new AiBddError('CONFIG_INVALID', `Unknown cache invalidation strategy "${name}"`);
        }
        out.push(custom);
      }
    }
  }
  return out;
}
