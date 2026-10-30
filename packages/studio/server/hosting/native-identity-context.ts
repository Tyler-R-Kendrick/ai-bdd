import { AsyncLocalStorage } from 'node:async_hooks';
import type { IdentityExecutionContext } from './identity-context.ts';
import {
  isValidatedIdentityLease,
  IdentityLeaseError,
  type ValidatedIdentityLease,
} from './identity-lease.ts';

type Scope = {
  lease: ValidatedIdentityLease | undefined;
  active: boolean;
  clock: () => number;
};
type NativeContext = {
  headers?: Record<string, string | undefined>;
  [key: string]: unknown;
};
type NativeSource = { get?: () => NativeContext };
const symbol = Symbol.for('@vercel/request-context');
const platform = globalThis as typeof globalThis & { [key: symbol]: unknown };
type Bridge = {
  value: NativeSource;
  storage: AsyncLocalStorage<Scope>;
  active: number;
};
let installed: Bridge | undefined;

/** Interoperates with the shipped @vercel/oidc Node getter; never copies HTTP request headers. */
function bridge(): Bridge {
  if (installed && platform[symbol] === installed.value) return installed;
  if (installed?.active) throw new IdentityLeaseError('configuration');
  const previous = platform[symbol] as NativeSource | undefined;
  const nativeGet: () => NativeContext =
    typeof previous?.get === 'function'
      ? previous.get.bind(previous)
      : () => ({});
  const storage = new AsyncLocalStorage<Scope>();
  const value: NativeSource = Object.create(previous ?? null);
  Object.defineProperty(value, 'get', {
    value: () => {
      const scope = storage.getStore();
      if (!scope) return nativeGet();
      if (!scope.active || !scope.lease)
        throw new IdentityLeaseError('unavailable');
      if (scope.clock() >= scope.lease.expiresAt)
        throw new IdentityLeaseError('expired');
      const native = nativeGet() ?? {};
      const headers = Object.fromEntries(
        Object.entries(native.headers ?? {}).filter(
          ([key]) => key.toLowerCase() !== 'x-vercel-oidc-token',
        ),
      );
      // Direct SDK lookup works, while accidental JSON/spread does not disclose the delegated token.
      Object.defineProperty(headers, 'x-vercel-oidc-token', {
        get: () => {
          if (!scope.active || !scope.lease)
            throw new IdentityLeaseError('unavailable');
          if (scope.clock() >= scope.lease.expiresAt)
            throw new IdentityLeaseError('expired');
          return scope.lease.token;
        },
        enumerable: false,
      });
      return { ...native, headers: Object.freeze(headers) };
    },
  });
  try {
    Object.defineProperty(platform, symbol, {
      value: Object.freeze(value),
      configurable: true,
      enumerable: false,
    });
  } catch {
    throw new IdentityLeaseError('configuration');
  }
  installed = { value, storage, active: 0 };
  return installed;
}

/** Only an authenticated, scope/JWKS-validated private lease can enter an SDK callback. No token cache. */
export class NativeIdentityExecutionContext
  implements IdentityExecutionContext
{
  constructor(
    readonly options: {
      acquire: () => Promise<ValidatedIdentityLease>;
      clock?: () => number;
    },
  ) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.options.acquire();
    const clock = this.options.clock ?? Date.now;
    if (!isValidatedIdentityLease(lease))
      throw new IdentityLeaseError('verification');
    if (!Number.isSafeInteger(lease.expiresAt) || clock() >= lease.expiresAt)
      throw new IdentityLeaseError('expired');
    const state = bridge();
    const scope: Scope = { lease, active: true, clock };
    state.active++;
    return state.storage.run(scope, async () => {
      try {
        const result = await operation();
        if (platform[symbol] !== state.value)
          throw new IdentityLeaseError('configuration');
        if (clock() >= lease.expiresAt) throw new IdentityLeaseError('expired');
        return result;
      } finally {
        scope.active = false;
        scope.lease = undefined;
        state.active--;
      }
    });
  }
}
