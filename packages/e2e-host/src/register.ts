import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scenario, SpecDocument } from '@ai-bdd/contracts';
import { parseGaugeSpec } from '@ai-bdd/spec-gauge';
import { parseGherkin } from '@ai-bdd/spec-gherkin';
import { normalizeSpecGlobs } from './globs.js';
import { tagNames, titleFor } from './titles.js';

/** The slice of e2e's public surface this host uses. */
export interface E2eTestApi {
  (title: string, options: Record<string, unknown>, body: (fixtures: E2eFixtures) => Promise<void>): void;
}

export interface E2eFixtures {
  agent: {
    act: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
    assert: (text: string, options?: Record<string, unknown>) => Promise<unknown>;
  };
  app?: unknown;
  screen?: unknown;
  [key: string]: unknown;
}

export interface RegisterSpecsOptions {
  globs: string[];
  projectRoot?: string;
  /** Injected in tests; production reads it from the `e2e` peer dependency. */
  test?: E2eTestApi;
  /** Runs a bound step locally. Defaults to the registry this host builds. */
  runBoundStep?: (scenario: string, text: string) => Promise<'handled' | 'unbound'>;
  onScenario?: (scenario: Scenario, document: SpecDocument) => void;
}

export interface Registration {
  titles: string[];
  documents: SpecDocument[];
  skipped: Array<{ uri: string; reason: string }>;
}

/**
 * Registers one e2e `test()` per spec scenario during module evaluation (F-E2).
 *
 * Everything here is synchronous on purpose: e2e collects tests while the module
 * is evaluated, so a host that needs an `await` before registering would be
 * collected as "no tests". Parsing, concept expansion and title computation are
 * therefore sync, and only the test bodies are async.
 *
 * e2e's own `run()` is not a public export (VERIFY V1), so this host is meant to
 * be imported by a file inside `tests/**` that e2e's runner collects. Projects
 * that cannot use top-level-await registration should use
 * `ai-bdd e2e-host generate`, which writes the static equivalent (VERIFY V2).
 */
export function registerSpecs(options: RegisterSpecsOptions): Registration {
  const projectRoot = options.projectRoot ?? process.cwd();
  const test = options.test ?? loadE2eTest();
  const registration: Registration = { titles: [], documents: [], skipped: [] };
  const seen = new Set<string>();

  for (const file of normalizeSpecGlobs(projectRoot, options.globs)) {
    let document: SpecDocument;
    try {
      const text = readFileSync(file, 'utf8');
      const parsed = file.endsWith('.feature') ? parseGherkin(text, file) : parseGaugeSpec(text, file);
      document = parsed.document;
    } catch (error) {
      registration.skipped.push({ uri: file, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    registration.documents.push(document);

    for (const scenario of document.scenarios) {
      const title = titleFor(document, scenario);
      if (seen.has(title)) {
        // e2e treats a duplicate title path inside one file as COLLECTION_ERROR, so
        // the host must not emit one; the data row keeps the title unique.
        registration.skipped.push({ uri: document.uri, reason: `duplicate title ${title}` });
        continue;
      }
      seen.add(title);
      registration.titles.push(title);
      options.onScenario?.(scenario, document);

      test(title, { tags: tagNames([...document.tags, ...scenario.tags]) }, async ({ agent }) => {
        for (const step of scenario.steps) {
          if (options.runBoundStep) {
            const outcome = await options.runBoundStep(scenario.name, step.text);
            if (outcome === 'handled') continue;
          }
          if (step.kind === 'action') {
            await agent.act(step.text, { params: Object.fromEntries(scenario.dataRow?.map((value, index) => [`col${index}`, value]) ?? []) });
            continue;
          }
          if (step.kind === 'assertion') {
            // VERIFY V16: e2e@0.19 exposes no public screenshot fixture, so the
            // ternary agent.assert is the only assertion layer available here; the
            // report marks these as judge: 'e2e-ternary'.
            await agent.assert(step.text, { vision: true });
          }
        }
      });
    }
  }
  return registration;
}

function loadE2eTest(): E2eTestApi {
  // Loaded lazily so the package is importable without e2e installed.
  const required = createRequire(join(process.cwd(), 'package.json'))('e2e') as { test?: E2eTestApi };
  if (typeof required.test !== 'function') {
    throw new Error('the installed e2e package does not export test');
  }
  return required.test;
}

import { createRequire } from 'node:module';
