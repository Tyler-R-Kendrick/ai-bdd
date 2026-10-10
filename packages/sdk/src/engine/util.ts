import { AiBddError } from '../contracts/index.ts';

/** Translate a glob (`**`, `*`, `?`, `{a,b}`) into an anchored RegExp over posix paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        i += 1;
        if (glob.charAt(i + 1) === '/') {
          i += 1;
          re += '(?:[^/]+/)*';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braceDepth += 1;
      re += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth -= 1;
      re += ')';
    } else if (c === ',' && braceDepth > 0) {
      re += '|';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(globs: readonly string[], path: string): boolean {
  return globs.some((g) => g === path || globToRegExp(g.replace(/^\.\//, '')).test(path));
}

/** Plain code-point ordering (locale independent). */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AiBddError('ABORTED', 'aborted');
}

/** Map `items` with at most `limit` concurrent calls; results keep input order. Stops launching after a failure. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i] as T, i);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  if (failure !== undefined) throw failure.error;
  return results;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
