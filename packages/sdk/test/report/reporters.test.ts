import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocPlan, JsonValue, ReporterName, RunReport } from '../../src/contracts/index.ts';
import { createReporters } from '../../src/report/index.ts';
import { stableJson } from '../../src/util/index.ts';
import { checkXml, findAll, type XmlElement } from './xml-check.ts';
import { authPlan, billingPlan, fixturePlans, fixtureReport } from './fixtures/run.ts';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, 'fixtures', 'golden');

function expectGolden(file: string, actual: string): void {
  const path = join(goldenDir, file);
  if (process.env['UPDATE_GOLDEN'] === '1') {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  expect(existsSync(path), `missing golden ${file}; run with UPDATE_GOLDEN=1`).toBe(true);
  expect(actual).toBe(readFileSync(path, 'utf8'));
}

let outDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'ai-bdd-report-'));
});
afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function renderOne(name: ReporterName, report: RunReport = fixtureReport, plans: readonly DocPlan[] = fixturePlans): Promise<{ path: string; text: string }> {
  const [reporter] = createReporters([name]);
  if (reporter === undefined) throw new Error('no reporter');
  const written = await reporter.render(report, { plans, outDir });
  expect(written).toHaveLength(1);
  const path = written[0]?.path ?? '';
  return { path, text: await readFile(path, 'utf8') };
}

function parseJunit(text: string): XmlElement {
  const res = checkXml(text);
  if (!res.ok) throw new Error(`junit not well-formed: ${res.error}`);
  return res.root;
}

describe('createReporters', () => {
  it('returns reporters in the requested order and collapses duplicates', () => {
    expect(createReporters(['markdown', 'json', 'markdown', 'junit']).map((r) => r.name)).toEqual(['markdown', 'json', 'junit']);
    expect(createReporters([])).toEqual([]);
  });

  it('writes each report to its conventional file name inside outDir', async () => {
    const reporters = createReporters(['json', 'junit', 'markdown']);
    const paths: string[] = [];
    for (const r of reporters) for (const w of await r.render(fixtureReport, { plans: fixturePlans, outDir: join(outDir, 'nested', 'dir') })) paths.push(w.path);
    expect(paths).toEqual([join(outDir, 'nested', 'dir', 'report.json'), join(outDir, 'nested', 'dir', 'junit.xml'), join(outDir, 'nested', 'dir', 'summary.md')]);
    for (const p of paths) expect(existsSync(p)).toBe(true);
  });
});

describe('json reporter', () => {
  it('matches the golden and is the stableJson of the report', async () => {
    const { text } = await renderOne('json');
    expect(text).toBe(stableJson(fixtureReport as unknown as JsonValue));
    expectGolden('report.json', text);
  });

  it('round-trips the RunReport without loss', async () => {
    const { text } = await renderOne('json');
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(fixtureReport)));
  });
});

describe('junit reporter', () => {
  it('matches the golden', async () => {
    expectGolden('junit.xml', (await renderOne('junit')).text);
  });

  it('is well-formed XML with one testsuite per feature and one testcase per scenario', async () => {
    const root = parseJunit((await renderOne('junit')).text);
    expect(root.name).toBe('testsuites');
    const suites = findAll(root, 'testsuite');
    expect(suites.map((s) => s.attrs['name'])).toEqual(['docs-billing--upgrade-plan', 'docs-billing--invoices', 'docs-auth--login']);
    const cases = findAll(root, 'testcase');
    expect(cases).toHaveLength(fixtureReport.scenarios.length);
    for (const suite of suites) {
      for (const tc of suite.children.filter((c) => c.name === 'testcase')) expect(tc.attrs['classname']).toBe(suite.attrs['name']);
    }
    expect(suites.map((s) => [s.attrs['tests'], s.attrs['failures'], s.attrs['errors'], s.attrs['skipped']])).toEqual([
      ['3', '1', '0', '0'],
      ['2', '2', '0', '0'],
      ['3', '0', '1', '1'],
    ]);
    expect([root.attrs['tests'], root.attrs['failures'], root.attrs['errors'], root.attrs['skipped']]).toEqual(['8', '3', '1', '1']);
  });

  it('maps failed/inconclusive/blocked to <failure type=CODE>, error to <error>, skipped to <skipped/>', async () => {
    const root = parseJunit((await renderOne('junit')).text);
    const byName = new Map(findAll(root, 'testcase').map((tc) => [tc.attrs['name'], tc] as const));
    const failure = (name: string): XmlElement | undefined => byName.get(name)?.children.find((c) => c.name === 'failure');
    expect(failure('Invoices are listed')?.attrs['type']).toBe('CHECK_FAILED');
    expect(failure('Invoices are listed')?.attrs['message']).toContain('row "INV-1" not found | table has 0 rows');
    expect(failure('Invoices are listed')?.text).toContain('First failing step: 2 (then) the invoice table lists INV-1');
    expect(failure('Invoice PDF looks good')?.attrs['type']).toBe('JUDGE_INCONCLUSIVE');
    expect(failure('Downgrade with open invoices')?.attrs['type']).toBe('FIXTURE_REQUIRED');
    const err = byName.get('Session expires')?.children.find((c) => c.name === 'error');
    expect(err?.attrs['type']).toBe('DRIVER_UNAVAILABLE');
    expect(byName.get('Session expires')?.children.some((c) => c.name === 'failure')).toBe(false);
    expect(byName.get('Remember me')?.children.map((c) => c.name)).toEqual(['skipped']);
    expect(byName.get('Upgrade to Pro')?.children).toEqual([]);
  });

  it('keeps healed scenarios passing but flags them with a property and a system-out note', async () => {
    const root = parseJunit((await renderOne('junit')).text);
    const tc = findAll(root, 'testcase').find((t) => t.attrs['name'] === 'Upgrade to "Pro" & see <receipt>');
    expect(tc).toBeDefined();
    const names = tc?.children.map((c) => c.name);
    expect(names).toEqual(['properties', 'system-out']);
    const prop = tc?.children[0]?.children[0];
    expect(prop?.attrs).toEqual({ name: 'ai-bdd.healed', value: 'true' });
    expect(tc?.children[1]?.text).toContain('healed step 1: when the user clicks "Upgrade to Pro"');
    expect(tc?.children.some((c) => c.name === 'failure' || c.name === 'error')).toBe(false);
  });

  it('escapes markup and invalid control characters from any user-supplied string', async () => {
    const evil = 'a & b < c > "d" \'e\' \u0000\u0008\u000b￾]]> \ud800 end';
    const report: RunReport = {
      ...fixtureReport,
      scenarios: fixtureReport.scenarios.map((s, i) =>
        i === 3
          ? { ...s, title: evil, featureId: evil, error: { code: 'CHECK_FAILED', message: evil, retryable: false }, steps: s.steps.map((st) => ({ ...st, text: evil })) }
          : s,
      ),
    };
    const { text } = await renderOne('junit', report);
    const root = parseJunit(text);
    const expected = 'a & b < c > "d" \'e\' ����]]> � end';
    expect(findAll(root, 'testcase').some((t) => t.attrs['name'] === expected)).toBe(true);
    expect(findAll(root, 'testsuite').some((t) => t.attrs['name'] === expected)).toBe(true);
    // The raw text never carries an unescaped markup character from user input.
    expect(text).not.toContain('a & b');
    expect(text).not.toContain('\u0000');
  });
});

describe('markdown reporter', () => {
  it('matches the golden', async () => {
    expectGolden('summary.md', (await renderOne('markdown')).text);
  });

  it('reports totals', async () => {
    const { text } = await renderOne('markdown');
    expect(text).toContain('## Totals');
    for (const row of ['| error | 1 |', '| failed | 1 |', '| inconclusive | 1 |', '| blocked | 1 |', '| healed | 1 |', '| passed | 2 |', '| skipped | 1 |', '| total | 8 |']) {
      expect(text).toContain(row);
    }
  });

  it('lists failures with error codes, the first failing step and a fixture stub', async () => {
    const { text } = await renderOne('markdown');
    const failures = text.slice(text.indexOf('## Failures'), text.indexOf('## Healed'));
    expect(failures).toContain('`CHECK_FAILED`');
    expect(failures).toContain('First failing step: #2 `then` the invoice table lists INV-1 — failed, `CHECK_FAILED`');
    expect(failures).toContain('`JUDGE_INCONCLUSIVE`');
    expect(failures).toContain('`FIXTURE_REQUIRED`');
    expect(failures).toContain('`DRIVER_UNAVAILABLE`');
    expect(failures).toContain('export const aCustomerWithTwoUnpaidInvoices: FixtureDefinition');
    expect(failures).not.toContain('Upgrade to Pro');
  });

  it('includes the doc-to-scenario traceability matrix with excerpts of at most 80 characters', async () => {
    const { text } = await renderOne('markdown');
    const trace = text.slice(text.indexOf('## Traceability'), text.indexOf('## Usage'));
    expect(trace).toContain('### `docs/auth.md`');
    expect(trace).toContain('### `docs/billing.md`');
    expect(trace).toContain('| Section | Chunk | Scenarios | Status |');
    expect(trace).toContain(
      '| `billing/upgrades` | Free users can upgrade to the Pro plan from the billing page. | `docs-billing--upgrade-plan/upgrade-to-pro` | passed |',
    );
    // Pipes in excerpts are escaped so the table stays intact.
    expect(trace).toContain('Select "Pro" \\| "Team" from the plan picker');
    // A scenario citing two chunks appears in both rows; a row aggregates the worst status of its scenarios.
    expect(trace).toMatch(/\| `billing\/upgrades` \|.*confirm the upgrade\. \| `docs-billing--upgrade-plan\/receipt-is-shown` \| healed \|/);
    expect(trace).toMatch(/\| `billing\/invoices` \| Invoice: INV-1; Status: paid \| `docs-billing--invoices\/list-invoices` \| failed \|/);
    const excerpts = trace
      .split('\n')
      .filter((l) => l.startsWith('| `'))
      .map((l) => l.split(/(?<!\\)\|/)[2]?.trim() ?? '');
    expect(excerpts.length).toBeGreaterThan(5);
    for (const e of excerpts) expect([...e].length).toBeLessThanOrEqual(80);
    expect(excerpts.some((e) => e.endsWith('…'))).toBe(true);
    // Rejected scenarios never appear as covering a chunk.
    expect(trace).not.toContain('rejected-idea');
  });

  it('lists uncovered and not-testable chunks per doc from coverage and plans', async () => {
    const { text } = await renderOne('markdown');
    const billing = text.slice(text.indexOf('### `docs/billing.md`'), text.indexOf('### `docs/legacy.md`'));
    expect(billing).toContain('**Uncovered chunks (1)**');
    expect(billing).toContain('- `billing/upgrades/li4` Annual plans renew automatically.');
    expect(billing).toContain('**Not testable (1)**');
    expect(billing).toContain('- `billing/performance/p1` The invoice list loads in under 200 ms at p95. — latency target is not observable through the UI');
    expect(text).toContain('Coverage: 8 of 11 chunks covered, 1 uncovered, 1 not testable.');
  });

  it('prints usage per purpose and the estimated cost line when present', async () => {
    const { text } = await renderOne('markdown');
    expect(text).toContain('| act | 7 | 5100 | 400 |');
    expect(text).toContain('| judge | 4 | 3100 | 200 |');
    expect(text).toContain('| total | 12 | 9200 | 700 |');
    expect(text).toContain('Estimated cost: $0.4217 USD');
  });

  it('omits the cost line when no estimate is present', async () => {
    const usage = { ...fixtureReport.usage };
    delete usage.estimatedCostUsd;
    const { text } = await renderOne('markdown', { ...fixtureReport, usage });
    expect(text).toContain('## Usage');
    expect(text).not.toContain('Estimated cost');
  });

  it('nothing is silent: healed, fuzzy and unreviewed scenarios are surfaced', async () => {
    const { text } = await renderOne('markdown');
    const healed = text.slice(text.indexOf('## Healed'), text.indexOf('## Fuzzy steps'));
    expect(healed).toContain('`docs-billing--upgrade-plan/receipt-is-shown` step #1 `when` the user clicks "Upgrade to Pro"');
    const fuzzy = text.slice(text.indexOf('## Fuzzy steps'), text.indexOf('## Unreviewed'));
    expect(fuzzy).toContain('volatile-content');
    expect(fuzzy).toContain('subjective');
    expect(fuzzy).toContain('the invoice looks professional');
    const unreviewed = text.slice(text.indexOf('## Unreviewed'), text.indexOf('## Traceability'));
    expect(unreviewed).toContain('`docs-billing--upgrade-plan/receipt-is-shown` — healed');
    expect(unreviewed).toContain('`docs-billing--invoices/list-invoices` — failed');
    expect(unreviewed).not.toContain('upgrade-to-pro');
    expect(text).toContain('## Warnings');
    expect(text).toContain('PLAN_CONTEXT_CHANGED');
  });

  it('says "None." for empty healed/fuzzy/unreviewed/failure sections', async () => {
    const passing = fixtureReport.scenarios.filter((s) => s.status === 'passed' && s.review === 'accepted');
    const { text } = await renderOne('markdown', { ...fixtureReport, scenarios: passing, warnings: [] });
    for (const h of ['## Failures', '## Healed', '## Fuzzy steps', '## Unreviewed scenarios that ran']) {
      const at = text.indexOf(h);
      expect(at).toBeGreaterThan(-1);
      expect(text.slice(at, at + h.length + 10)).toContain('None.');
    }
    expect(text).not.toContain('## Warnings');
  });
});

describe('determinism (R-PL4)', () => {
  it('R-PL4: renders byte-identical output on repeated runs, whatever the plan order, with no timestamps beyond the report', async () => {
    for (const name of ['json', 'junit', 'markdown'] as const) {
      const first = (await renderOne(name)).text;
      await new Promise((r) => setTimeout(r, 15));
      const second = (await renderOne(name, fixtureReport, [authPlan, billingPlan])).text;
      expect(second).toBe(first);
      expect(first.endsWith('\n')).toBe(true);
      expect(first).not.toContain('\r');
      const stamps = new Set(first.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g) ?? []);
      for (const s of stamps) expect([fixtureReport.startedAt, fixtureReport.finishedAt]).toContain(s);
    }
  });
});

describe('robustness against unknown references', () => {
  it('does not throw for scenarios, docs and chunks the plans do not know', async () => {
    const report: RunReport = {
      ...fixtureReport,
      scenarios: [
        ...fixtureReport.scenarios,
        {
          ...(fixtureReport.scenarios[0] as RunReport['scenarios'][number]),
          scenarioId: 'ghost--feature/ghost',
          featureId: 'ghost--feature',
          docUri: 'docs/ghost.md',
          title: 'Ghost',
          status: 'failed',
        },
      ],
      coverage: { docs: [...fixtureReport.coverage.docs, { docUri: 'docs/only-in-coverage.md', chunks: 1, covered: 0, uncovered: ['docs/only-in-coverage.md#x/p1'], notTestable: [] }] },
    };
    for (const name of ['json', 'junit', 'markdown'] as const) {
      const { text } = await renderOne(name, report);
      expect(text.length).toBeGreaterThan(0);
      if (name === 'junit') parseJunit(text);
    }
    const md = (await renderOne('markdown', report)).text;
    expect(md).toContain('### Scenarios not found in the supplied plans');
    expect(md).toContain('`ghost--feature/ghost`');
    expect(md).toContain('### `docs/only-in-coverage.md`');
    expect(md).toContain('No plan was supplied for this document');
    expect(md).toContain('- `x/p1`');
  });

  it('handles an empty report and no plans', async () => {
    const empty: RunReport = {
      ...fixtureReport,
      scenarios: [],
      totals: { passed: 0, failed: 0, healed: 0, blocked: 0, skipped: 0, inconclusive: 0, error: 0 },
      coverage: { docs: [] },
      warnings: [],
      exitCode: 0,
    };
    const junit = parseJunit((await renderOne('junit', empty, [])).text);
    expect(findAll(junit, 'testsuite')).toHaveLength(0);
    const md = (await renderOne('markdown', empty, [])).text;
    expect(md).toContain('| total | 0 |');
    expect(md).toContain('_No documents._');
  });

  it('tolerates plan chunk refs that point at chunks missing from the plan and plans without matching sections', async () => {
    const plan: DocPlan = { ...billingPlan, sections: [], chunks: [] };
    const md = (await renderOne('markdown', fixtureReport, [plan, authPlan])).text;
    expect(md).toContain('(chunk not in plan: ');
    expect(md).toContain('(unsectioned)');
  });
});
