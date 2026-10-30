import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startAcmeApp } from '@ai-bdd/testing';
import { createApp } from '../server/app.ts';
import { hash } from '../server/store.ts';
import { client, project, setup, testSettings } from './helpers.ts';
async function waitForRun(
  studio: Awaited<ReturnType<typeof createApp>>,
  runId: string,
  artifactId: string,
) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const run = await studio.store.run(runId, artifactId);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Durable runner did not finish before test deadline');
}
describe('Trusted acceptance runner adapter', () => {
  it('compiles grounded requirements, reviews, drives real Chromium, serves evidence and replays without model calls', async () => {
    // This fixture deliberately characterizes once, then replays. Production CI
    // remains read-only by default; only this test's recording store is writable.
    vi.stubEnv('AI_BDD_RECORDINGS', 'read-write');
    const work = resolve(import.meta.dirname, '../../../work');
    await mkdir(work, { recursive: true });
    const dir = await mkdtemp(join(work, 'studio-runner-'));
    const app = await startAcmeApp();
    let studio: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const corpus = resolve(import.meta.dirname, '../../testing/corpus'),
        rules = join(dir, 'rules');
      await mkdir(rules);
      for (const file of await readdir(join(corpus, 'fake-model'))) {
        if (file.endsWith('.json'))
          await writeFile(
            join(rules, file),
            (
              await readFile(join(corpus, 'fake-model', file), 'utf8')
            ).replaceAll('docs/billing.md', 'docs/design.md'),
          );
      }
      const executable =
          process.env.AI_BDD_CHROMIUM_PATH ??
          (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
        log = join(dir, 'model-calls.jsonl'),
        config = join(dir, 'runner.config.mjs');
      await writeFile(
        config,
        [
          "import { createFakeModels, acmeFixtures } from '@ai-bdd/testing';",
          "import { playwright } from '@ai-bdd/driver-playwright';",
          '// Test-only deterministic model rules; browser actions and evidence are real.',
          `export default {baseURL:${JSON.stringify(app.url)},fixtures:acmeFixtures,drivers:{web:playwright({headless:true,launchOptions:${JSON.stringify({ ...(executable ? { executablePath: executable } : {}), args: ['--no-sandbox'] })}})},defaultDriver:'web',models:createFakeModels({rulesDir:${JSON.stringify(rules)},logPath:${JSON.stringify(log)}}),characterize:{probeMs:100,confirmRuns:1},settle:{quietMs:100,intervalMs:30,timeoutMs:5000},concurrency:{scenarios:1}};`,
        ].join('\n'),
      );
      studio = await createApp(
        { ...testSettings(join(dir, 'data')), runnerConfig: config },
        { db: join(dir, 'data/studio.sqlite') },
      );
      const { cookie } = await setup(studio.app),
        request = client(studio.app, cookie),
        p = await project(request, 'Real browser runner');
      const markdown = await readFile(join(corpus, 'docs/billing.md'), 'utf8');
      const patched = await request(
        'PATCH',
        `/api/artifacts/${p.mainArtifactId}`,
        {
          version: 1,
          content: {
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: markdown }],
                },
              ],
            },
          },
        },
      );
      expect(patched.statusCode, patched.body).toBe(200);
      const compile = await request(
        'POST',
        `/api/artifacts/${p.mainArtifactId}/compile`,
      );
      expect(compile.statusCode, compile.body).toBe(200);
      expect(
        compile.json().result.exitCode,
        JSON.stringify(compile.json().result),
      ).toBe(0);
      const plans = compile.json().plans;
      expect(plans).toHaveLength(1);
      expect(
        plans[0].features.some((f: any) => f.title === 'Upgrade to Pro'),
      ).toBe(true);
      for (const feature of plans[0].features) {
        const review = await request(
          'POST',
          `/api/artifacts/${p.mainArtifactId}/review`,
          {
            target: feature.id,
            action: feature.title === 'Upgrade to Pro' ? 'accept' : 'reject',
          },
        );
        expect(review.statusCode, review.body).toBe(200);
      }
      const version = (
        await studio.store.artifact(
          p.mainArtifactId,
          (await studio.store.userByEmail('owner@example.test')).id,
        )
      ).version;
      const queued = await request(
        'POST',
        `/api/artifacts/${p.mainArtifactId}/runs`,
      );
      expect(queued.statusCode, queued.body).toBe(202);
      await waitForRun(studio, queued.json().id, p.mainArtifactId);
      const first = (await studio.store.runs(p.mainArtifactId)).find(
        (r) => r.id === queued.json().id,
      )!;
      expect(first.status, JSON.stringify(first)).toBe('passed');
      expect(first.artifactVersion).toBe(version);
      expect(first.result.scenarios).toHaveLength(
        plans[0].features.find((f: any) => f.title === 'Upgrade to Pro')
          .scenarios.length,
      );
      expect(first.result.scenarios[0]).toMatchObject({
        driver: 'playwright',
        status: 'passed',
        mode: 'characterize',
      });
      expect(first.result.integrity.ok).toBe(true);
      const evidence = first.result.scenarios[0].steps
        .flatMap((step: any) => step.evidence)
        .find((ref: any) => ref.kind === 'screenshot');
      expect(evidence).toBeDefined();
      const file = await request(
        'GET',
        `/api/artifacts/${p.mainArtifactId}/runs/${first.id}/evidence/${encodeURIComponent(evidence.path)}`,
      );
      expect(file.statusCode, file.body).toBe(200);
      expect(hash(file.rawPayload)).toBe(evidence.sha256);
      if (process.env.STUDIO_REVIEW_CAPTURE_DIR) {
        await mkdir(process.env.STUDIO_REVIEW_CAPTURE_DIR, { recursive: true });
        await writeFile(
          join(
            process.env.STUDIO_REVIEW_CAPTURE_DIR,
            'runner-real-browser-evidence.png',
          ),
          file.rawPayload,
        );
      }
      expect(file.rawPayload.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      const manifest = await studio.hosting.objects.get(
        first.result.evidenceWorkspace.key,
        {
          maxBytes: 4 * 1024 * 1024,
          expectedSha256: first.result.evidenceWorkspace.sha256,
        },
      );
      const stored = JSON.parse(
        Buffer.from(manifest!.bytes).toString(),
      ).files.find((entry: any) => entry.path === evidence.path);
      const evidencePath = join(dir, 'data/objects', stored.key),
        originalObject = await readFile(evidencePath);
      const tampered = Buffer.from(originalObject);
      tampered[tampered.length - 1] ^= 1;
      await writeFile(evidencePath, tampered);
      try {
        expect(
          (
            await request(
              'GET',
              `/api/artifacts/${p.mainArtifactId}/runs/${first.id}/evidence/${encodeURIComponent(evidence.path)}`,
            )
          ).statusCode,
        ).toBe(409);
      } finally {
        await writeFile(evidencePath, originalObject);
      }
      const calls = (await readFile(log, 'utf8')).trim().split('\n').length,
        replay = await request(
          'POST',
          `/api/artifacts/${p.mainArtifactId}/runs`,
        );
      expect(replay.statusCode).toBe(202);
      await waitForRun(studio, replay.json().id, p.mainArtifactId);
      const second = (await studio.store.runs(p.mainArtifactId)).find(
        (r) => r.id === replay.json().id,
      )!;
      expect(second.status, JSON.stringify(second)).toBe('passed');
      expect(second.result.scenarios[0].mode).toBe('replay');
      expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(
        calls,
      );
      // Frozen execution must not turn an edited or empty document into green evidence.
      const current = await studio.store.artifact(
        p.mainArtifactId,
        (await studio.store.userByEmail('owner@example.test')).id,
      );
      await request('PATCH', `/api/artifacts/${p.mainArtifactId}`, {
        version: current.version,
        content: {
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'Requirements changed since compilation.',
                  },
                ],
              },
            ],
          },
        },
      });
      const stale = await request(
        'POST',
        `/api/artifacts/${p.mainArtifactId}/runs`,
      );
      expect(stale.statusCode).toBe(202);
      await waitForRun(studio, stale.json().id, p.mainArtifactId);
      const rejected = (await studio.store.runs(p.mainArtifactId)).find(
        (r) => r.id === stale.json().id,
      )!;
      expect(rejected.status).not.toBe('passed');
      const changed = await studio.store.artifact(
        p.mainArtifactId,
        (await studio.store.userByEmail('owner@example.test')).id,
      );
      await request('PATCH', `/api/artifacts/${p.mainArtifactId}`, {
        version: changed.version,
        content: {
          doc: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '# Billing\n' }],
              },
            ],
          },
        },
      });
      const emptyCompile = await request(
        'POST',
        `/api/artifacts/${p.mainArtifactId}/compile`,
      );
      expect(emptyCompile.statusCode, emptyCompile.body).toBe(200);
      expect(emptyCompile.json().result.exitCode).toBe(0);
      const emptyRun = await request(
        'POST',
        `/api/artifacts/${p.mainArtifactId}/runs`,
      );
      expect(emptyRun.statusCode).toBe(202);
      await waitForRun(studio, emptyRun.json().id, p.mainArtifactId);
      const empty = (await studio.store.runs(p.mainArtifactId)).find(
        (r) => r.id === emptyRun.json().id,
      )!;
      expect(empty.status).not.toBe('passed');
      expect(empty.error).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
      await studio?.app.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 90000);
});
