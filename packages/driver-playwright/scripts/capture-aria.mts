/**
 * Captures the fixture app's aria snapshots, so the parser golden is real.
 *
 * Run with the headless shell's libraries on the path:
 *   LD_LIBRARY_PATH=... pnpm -F @ai-bdd/driver-playwright exec tsx scripts/capture-aria.mts
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright-core';

const server = spawn('node', ['/workspace/fixtures/app/server.mjs', '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise<number>((resolve) => {
  server.stdout.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString()).port as number));
});
const base = `http://127.0.0.1:${port}`;
const token = 'ai-bdd-test';

async function seed(body: Record<string, unknown>): Promise<void> {
  await fetch(`${base}/__test/seed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-token': token }, body: JSON.stringify(body) });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page: Page = await context.newPage();
const snapshots: Record<string, string> = {};
const capture = async (key: string, url: string): Promise<void> => {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  snapshots[key] = await page.locator('body').ariaSnapshot();
};

await seed({ workspace: 'Acme', plan: 'free', unpaid: 0 });
await capture('/settings/billing', `${base}/settings/billing`);
await capture('/login', `${base}/login`);
await capture('/forms/two', `${base}/forms/two`);

await seed({ workspace: 'Acme', plan: 'free', unpaid: 2 });
await capture('/settings/billing?unpaid=2', `${base}/settings/billing`);

await seed({ workspace: 'Acme', plan: 'free', unpaid: 0 });
await page.goto(`${base}/settings/billing`, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'Upgrade to Pro', exact: true }).click();
await page.waitForTimeout(200);
await capture('/settings/billing?dialog=upgrade', `${base}/settings/billing?dialog=upgrade`);

await seed({ workspace: 'Acme', plan: 'pro', unpaid: 0 });
await capture('/settings/billing?plan=pro', `${base}/settings/billing`);

writeFileSync('test/fixtures/aria-snapshots.json', `${JSON.stringify({ source: 'Playwright 1.64 chromium-headless-shell against fixtures/app', synthetic: false, snapshots }, null, 2)}\n`);
await browser.close();
server.kill();
const keys = Object.keys(snapshots);
console.log(`captured ${keys.length} snapshot(s): ${keys.join(', ')}`);
