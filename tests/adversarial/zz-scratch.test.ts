import { it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAcmeApp } from '@ai-bdd/testing';
import { playwright } from '@ai-bdd/driver-playwright';

it('scratch', async () => {
  const app = await startAcmeApp({});
  const tmp = mkdtempSync(join(tmpdir(), 'zz-'));
  const pol = { allowHosts: ['localhost', '127.0.0.1', '[::1]'], denyVerbs: [] as never[] };
  const d = await playwright({ browser: 'chromium', headless: true }).create({ projectRoot: tmp, baseURL: app.url, policy: pol, artifactsDir: tmp });
  const s = await d.openSession({ scenarioId: 'x', baseURL: app.url, policy: pol, resolveValue: (v) => ('literal' in v ? v.literal : '') });
  console.log(await s.perform({ verb: 'navigate', url: '/todos' }));
  let obs = await s.observe();
  console.log(obs.treeText);
  const box = obs.nodes.find((n) => n.role === 'textbox' && n.name === 'New todo')!;
  console.log(await s.perform({ verb: 'fill', target: { ref: box.ref }, value: { literal: 'ZTOK-00' } }));
  obs = await s.observe();
  const add = obs.nodes.find((n) => n.role === 'button' && n.name === 'Add')!;
  console.log(await s.perform({ verb: 'click', target: { ref: add.ref } }));
  await new Promise((r) => setTimeout(r, 500));
  console.log((await s.observe()).treeText);
  await s.close(); await d.dispose(); await app.close();
}, 60000);
