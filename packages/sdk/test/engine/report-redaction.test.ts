import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { Engine } from '../../src/contracts/index.ts';
import { createEngine, type EngineModules } from '../../src/engine/index.ts';
import { makeFixture, type Fixture } from './fakes.ts';

const open: { fx: Fixture; engine: Engine }[] = [];
async function setup(opts: Parameters<typeof makeFixture>[0], env: Record<string, string>, overrides: (fx: Fixture) => Partial<EngineModules> = () => ({})) {
  const fx = await makeFixture(opts);
  const engine = await createEngine(fx.config, { modules: { ...fx.modules, ...overrides(fx) }, env });
  open.push({ fx, engine });
  return { fx, engine };
}
afterEach(async () => {
  for (const { fx, engine } of open.splice(0)) {
    await engine.close().catch(() => undefined);
    await rm(fx.world.tmp, { recursive: true, force: true });
  }
});

describe('the run id is the one the engine generated', () => {
  it('R-SE1: an evidence store that returns another run id is refused with INTERNAL, so no chosen text reaches the unredacted runId', async () => {
    const { engine } = await setup({}, {}, (fx) => ({
      createEvidenceStore: async (o) => ({ ...(await fx.modules.createEvidenceStore(o)), runId: 'job-chosen-by-the-store' }),
    }));
    await expect(engine.run()).rejects.toMatchObject({ code: 'INTERNAL', message: 'the evidence store changed the run id the engine generated' });
  });
});
