import { AiBddError, type FixtureContext, type FixtureDefinition, type JsonObject, type JsonValue } from '@ai-bdd/sdk/contracts';
import { DEFAULT_TEST_TOKEN } from '../app/model.ts';
import { TEST_TOKEN_HEADER } from '../app/test-api.ts';

/** Fixtures for the Acme app (SPEC 13.2). They talk to the test API through the session, so cookies are shared. */

function tokenHeaders(): Record<string, string> {
  return { [TEST_TOKEN_HEADER]: process.env['ACME_TEST_TOKEN'] ?? DEFAULT_TEST_TOKEN };
}

async function call(ctx: FixtureContext, path: string, body?: JsonValue): Promise<void> {
  const session = ctx.session;
  if (session.request === undefined) {
    throw new AiBddError('FIXTURE_FAILED', `driver ${session.driverId} cannot make requests; Acme fixtures need session.request`, { retryable: false });
  }
  const res = await session.request({ method: 'POST', path, headers: tokenHeaders(), ...(body === undefined ? {} : { body }) });
  if (res.status < 200 || res.status >= 300) {
    throw new AiBddError('FIXTURE_FAILED', `POST ${path} returned ${res.status}: ${JSON.stringify(res.body)}`, { retryable: false });
  }
}

/** A page that was already open before the data changed still shows old data in a real browser; reload it. */
async function reloadCurrentPage(ctx: FixtureContext): Promise<void> {
  const obs = await ctx.session.observe({ pixels: false });
  if (obs.url === undefined || !/^https?:/i.test(obs.url)) return;
  const out = await ctx.session.perform({ verb: 'navigate', url: obs.url });
  if (!out.ok) ctx.log(`reload after fixture skipped: ${out.error?.message ?? 'navigation failed'}`);
}

export const resetAccount: FixtureDefinition = {
  name: 'resetAccount',
  description: 'Reset the Acme account to its initial state (free plan, no unpaid invoices)',
  params: {},
  async run(_args, ctx) {
    await call(ctx, '/__test/reset');
    await reloadCurrentPage(ctx);
  },
};

export const seedAccount: FixtureDefinition = {
  name: 'seedAccount',
  description: 'Create the Acme account on a given plan with a number of unpaid invoices',
  params: {
    plan: { type: 'string', enum: ['free', 'pro'], description: 'Subscription plan the account starts on' },
    unpaid: { type: 'number', derived: true, description: 'Number of unpaid invoices on the account' },
  },
  async run(args: JsonObject, ctx) {
    const plan = args['plan'];
    const unpaid = args['unpaid'];
    if (plan !== undefined && plan !== 'free' && plan !== 'pro') {
      throw new AiBddError('FIXTURE_FAILED', `seedAccount: plan must be "free" or "pro", got ${JSON.stringify(plan)}`, { retryable: false });
    }
    if (unpaid !== undefined && (typeof unpaid !== 'number' || !Number.isInteger(unpaid) || unpaid < 0)) {
      throw new AiBddError('FIXTURE_FAILED', `seedAccount: unpaid must be a non-negative integer, got ${JSON.stringify(unpaid)}`, { retryable: false });
    }
    // Idempotent: always start from a clean account, then apply the requested seed.
    await call(ctx, '/__test/reset');
    await call(ctx, '/__test/seed', {
      ...(plan === undefined ? {} : { plan }),
      ...(unpaid === undefined ? {} : { unpaid }),
    });
    await reloadCurrentPage(ctx);
  },
};

export const acmeFixtures: FixtureDefinition[] = [seedAccount, resetAccount];
