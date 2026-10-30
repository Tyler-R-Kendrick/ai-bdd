/** Optional provider-neutral execution boundary. Implementations acquire and scope credentials server-side. */
export interface IdentityExecutionContext {
  run<T>(operation: () => Promise<T>): Promise<T>;
}
export function runWithIdentity<T>(
  context: IdentityExecutionContext | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return context ? context.run(operation) : operation();
}
