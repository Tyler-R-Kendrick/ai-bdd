import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Policy, SessionOptions } from '@ai-bdd/sdk/contracts';
import { createDriverFactory, playwright } from '../src/index.ts';
import { browserAvailable } from './browser.ts';
import { startEdgeServer } from './edge-server.ts';
import type { EdgeServer } from './edge-server.ts';

vi.setConfig({ testTimeout: 45_000, hookTimeout: 60_000 });

const hasBrowser = await browserAvailable();
const policy: Policy = { allowHosts: ['localhost'], denyVerbs: [] };

let edge: EdgeServer;
let artifacts: string;

const opts = (over: Partial<SessionOptions> = {}): SessionOptions => ({ scenarioId: 'opts', baseURL: edge.url, policy, resolveValue: () => '', ...over });
const videos = (dir: string): string[] => (existsSync(join(dir, 'video')) ? readdirSync(join(dir, 'video')).filter((f) => f.endsWith('.webm')) : []);

describe.skipIf(!hasBrowser)('driver-playwright driver options', () => {
  beforeAll(async () => {
    edge = await startEdgeServer();
    artifacts = mkdtempSync(join(tmpdir(), 'ai-bdd-pw-artifacts-'));
  });
  afterAll(async () => {
    await edge.close();
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('R-SDK2: the configured viewport is the size the page sees; the default is 1280x720', async () => {
    const sized = await createDriverFactory({ viewport: { width: 700, height: 500 }, headless: true }).create({ projectRoot: '.', policy, artifactsDir: artifacts, baseURL: edge.url });
    const a = await sized.openSession(opts());
    await a.perform({ verb: 'navigate', url: '/viewport' });
    expect((await a.observe()).treeText).toContain('heading "700x500"');
    await a.close();
    await sized.dispose();

    const plain = await playwright().create({ projectRoot: '.', policy, artifactsDir: artifacts, baseURL: edge.url });
    const b = await plain.openSession(opts());
    await b.perform({ verb: 'navigate', url: '/viewport' });
    expect((await b.observe()).treeText).toContain('heading "1280x720"');
    await b.close();
    await plain.dispose();
  });

  it('R-SDK2: baseURL resolution prefers the session option and falls back to the driver context', async () => {
    const d = await playwright().create({ projectRoot: '.', policy: { allowHosts: ['example.invalid'], denyVerbs: [] }, artifactsDir: artifacts, baseURL: 'http://example.invalid' });
    const s = await d.openSession(opts()); // the session baseURL (localhost) wins over the context baseURL
    expect(await s.perform({ verb: 'navigate', url: '/plain' })).toEqual({ ok: true, navigatedTo: `${edge.url}/plain` });
    await s.close();
    const viaContext = await d.openSession({ scenarioId: 'ctx', policy: { allowHosts: ['example.invalid'], denyVerbs: [] }, resolveValue: () => '' });
    const denied = await viaContext.perform({ verb: 'navigate', url: '/plain' });
    expect(denied.ok).toBe(false);
    // Without a session baseURL the context baseURL applies; example.invalid is allowed, so the browser really tries it.
    expect(denied.error?.code).toBe('DRIVER_ERROR');
    expect(denied.error?.message).toContain('http://example.invalid/plain');
    await viaContext.close();
    await d.dispose();
  });

  it('R-JU2: recordVideo writes a .webm per session under <artifactsDir>/video; the session option overrides the driver option either way', async () => {
    const on = mkdtempSync(join(artifacts, 'on-'));
    const d = await playwright({ recordVideo: true }).create({ projectRoot: '.', policy, artifactsDir: on, baseURL: edge.url });
    const s = await d.openSession(opts());
    await s.perform({ verb: 'navigate', url: '/plain' });
    await s.close(); // closing the context finalises the recording
    await vi.waitFor(() => expect(videos(on)).toHaveLength(1), { timeout: 20_000, interval: 200 });
    const file = join(on, 'video', videos(on)[0] as string);
    expect(statSync(file).size).toBeGreaterThan(0);

    const off = await d.openSession(opts({ recordVideo: false }));
    await off.perform({ verb: 'navigate', url: '/plain' });
    await off.close();
    await d.dispose();
    expect(videos(on)).toHaveLength(1); // the opted-out session recorded nothing

    const offDir = mkdtempSync(join(artifacts, 'off-'));
    const d2 = await playwright().create({ projectRoot: '.', policy, artifactsDir: offDir, baseURL: edge.url });
    const quiet = await d2.openSession(opts());
    await quiet.close();
    expect(videos(offDir)).toHaveLength(0);
    const loud = await d2.openSession(opts({ recordVideo: true }));
    await loud.perform({ verb: 'navigate', url: '/plain' });
    await loud.close();
    await d2.dispose();
    await vi.waitFor(() => expect(videos(offDir)).toHaveLength(1), { timeout: 20_000, interval: 200 });
  });

  it('V7: dispose() closes sessions that are still open, so using one afterwards fails cleanly', async () => {
    const d = await playwright().create({ projectRoot: '.', policy, artifactsDir: artifacts, baseURL: edge.url });
    const s = await d.openSession(opts());
    await s.perform({ verb: 'navigate', url: '/plain' });
    await d.dispose();
    expect(await s.perform({ verb: 'navigate', url: '/plain' })).toMatchObject({ ok: false, error: { code: 'DRIVER_UNAVAILABLE', message: 'session is closed' } });
    await expect(s.observe()).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', message: 'session is closed' });
  });
});
