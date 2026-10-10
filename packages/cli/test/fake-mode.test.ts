import { describe, expect, it, vi } from 'vitest';
import type { DriverFactory, ModelSet } from '@ai-bdd/sdk/contracts';
import { AiBddError } from '@ai-bdd/sdk/contracts';
import { runCli } from './helpers.ts';

function fakeTesting() {
  const models = { id: 'fake-models' } as unknown as ModelSet;
  const factory = { id: 'fake' } as unknown as DriverFactory;
  const createFakeModels = vi.fn((_o: { rulesDir?: string }) => models);
  const fakeDriver = vi.fn((_o: { flags?: string[] }) => factory);
  return { models, factory, createFakeModels, fakeDriver, importTesting: vi.fn(async () => ({ createFakeModels, fakeDriver })) };
}

describe('AI_BDD_FAKE=1 (§5.3)', () => {
  it('replaces models, registers driver `fake`, defaults to it, and prints the banner on stderr', async () => {
    const t = fakeTesting();
    const h = await runCli(['status'], {
      env: { AI_BDD_FAKE: '1', AI_BDD_FAKE_RULES: '/rules', AI_BDD_FAKE_FLAGS: 'v2, bug-upgrade-noop,' },
      deps: { importTesting: t.importTesting },
    });
    expect(h.code).toBe(0);
    expect(t.createFakeModels).toHaveBeenCalledWith({ rulesDir: '/rules' });
    expect(t.fakeDriver).toHaveBeenCalledWith({ flags: ['v2', 'bug-upgrade-noop'] });
    expect(h.stderr).toContain('ai-bdd: FAKE models/driver active\n');
    expect(h.stdout).not.toContain('FAKE');
    const [config, overrides] = h.createEngine.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(config['models']).toBe(t.models);
    expect(config['defaultDriver']).toBe('fake');
    expect((config['drivers'] as Record<string, unknown>)['fake']).toBe(t.factory);
    expect(overrides['models']).toBe(t.models);
    expect((overrides['drivers'] as Record<string, unknown>)['fake']).toBe(t.factory);
  });

  it('keeps user drivers registered alongside `fake`', async () => {
    const t = fakeTesting();
    const web = { id: 'web' } as unknown as DriverFactory;
    const h = await runCli(['status'], { env: { AI_BDD_FAKE: '1' }, config: { drivers: { web } }, deps: { importTesting: t.importTesting } });
    const config = h.createEngine.mock.calls[0]?.[0] as { drivers: Record<string, unknown> };
    expect(Object.keys(config.drivers).sort()).toEqual(['fake', 'web']);
  });

  it('resolves a relative AI_BDD_FAKE_RULES against cwd and passes no flags by default', async () => {
    const t = fakeTesting();
    await runCli(['status'], { env: { AI_BDD_FAKE: '1', AI_BDD_FAKE_RULES: 'rules/dir' }, cwd: '/work', deps: { importTesting: t.importTesting } });
    expect(t.createFakeModels).toHaveBeenCalledWith({ rulesDir: '/work/rules/dir' });
    expect(t.fakeDriver).toHaveBeenCalledWith({ flags: [] });
  });

  it('omits rulesDir when AI_BDD_FAKE_RULES is unset', async () => {
    const t = fakeTesting();
    await runCli(['status'], { env: { AI_BDD_FAKE: '1' }, deps: { importTesting: t.importTesting } });
    expect(t.createFakeModels).toHaveBeenCalledWith({});
  });

  it('does not override defaultDriver when --driver is given', async () => {
    const t = fakeTesting();
    const h = await runCli(['run', '--driver', 'web'], { env: { AI_BDD_FAKE: '1' }, config: { defaultDriver: 'web' }, deps: { importTesting: t.importTesting } });
    const config = h.createEngine.mock.calls[0]?.[0] as { defaultDriver: string };
    expect(config.defaultDriver).toBe('web');
    expect((h.engine.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ driver: 'web' });
  });

  it('exits 2 when @ai-bdd/testing cannot be imported', async () => {
    const importTesting = vi.fn(async () => {
      throw new Error("Cannot find package '@ai-bdd/testing'");
    });
    const h = await runCli(['run'], { env: { AI_BDD_FAKE: '1' }, deps: { importTesting } });
    expect(h.code).toBe(2);
    expect(h.stderr).toContain('requires the @ai-bdd/testing package');
    expect(h.createEngine).not.toHaveBeenCalled();
  });

  it('exits 2 when the testing module lacks the expected exports', async () => {
    const h = await runCli(['run'], { env: { AI_BDD_FAKE: '1' }, deps: { importTesting: async () => ({}) } });
    expect(h.code).toBe(2);
  });

  it('works without a config file by falling back to SDK defaults', async () => {
    const t = fakeTesting();
    const loadConfig = vi.fn(async () => {
      throw new AiBddError('CONFIG_NOT_FOUND', 'none');
    });
    const resolveConfig = vi.fn(() => ({ ...({} as object), secrets: {}, drivers: {}, recordingsMode: 'read-write', ci: false }) as never);
    const h = await runCli(['status'], { env: { AI_BDD_FAKE: '1' }, cwd: '/p', deps: { importTesting: t.importTesting, loadConfig, resolveConfig } });
    expect(h.code).toBe(0);
    expect(resolveConfig).toHaveBeenCalledWith({}, { projectRoot: '/p', env: { AI_BDD_FAKE: '1' } });
  });

  it('a missing config is still exit 2 when AI_BDD_FAKE is off', async () => {
    const loadConfig = vi.fn(async () => {
      throw new AiBddError('CONFIG_NOT_FOUND', 'none');
    });
    const h = await runCli(['status'], { deps: { loadConfig } });
    expect(h.code).toBe(2);
  });

  it.each(['0', '', 'false'])('AI_BDD_FAKE=%j does not activate fake mode', async (v) => {
    const t = fakeTesting();
    const h = await runCli(['status'], { env: { AI_BDD_FAKE: v }, deps: { importTesting: t.importTesting } });
    expect(t.importTesting).not.toHaveBeenCalled();
    expect(h.stderr).not.toContain('FAKE');
  });

  it('prints the banner for every command that opens an engine, never on stdout', async () => {
    for (const argv of [['compile'], ['show'], ['prune'], ['doctor'], ['run']]) {
      const t = fakeTesting();
      const h = await runCli(argv, { env: { AI_BDD_FAKE: '1' }, deps: { importTesting: t.importTesting } });
      expect(h.stderr).toContain('ai-bdd: FAKE models/driver active');
      expect(h.stdout).not.toContain('FAKE models');
    }
  });
});
