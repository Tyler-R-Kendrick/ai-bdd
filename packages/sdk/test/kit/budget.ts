/**
 * CPU-time measurement for budget tests ("this input is parsed in linear time"). Wall-clock time also counts the time the
 * process waited for a core (a busy CI runner, v8 coverage instrumentation, parallel test files); CPU time does not, so a budget
 * that only has to separate linear from quadratic behaviour stays stable.
 */
export function cpuMs(fn: () => void): number {
  const before = process.cpuUsage();
  fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

export async function cpuMsAsync(fn: () => Promise<void>): Promise<number> {
  const before = process.cpuUsage();
  await fn();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

/** The smallest CPU time of `reps` runs. */
export function bestCpuMs(reps: number, fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < reps; i += 1) best = Math.min(best, cpuMs(fn));
  return best;
}
