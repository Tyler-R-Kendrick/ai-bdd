import { existsSync, readFileSync } from 'node:fs';
import type { Concept, Diagnostic, ParseResult, SpecDocument } from '@ai-bdd/contracts';
import { AiBddError } from '@ai-bdd/contracts';
import { parseConcepts, parseGaugeSpec } from '@ai-bdd/spec-gauge';
import { parseGherkin } from '@ai-bdd/spec-gherkin';
import { expandGlobs } from './glob.js';

export interface DiscoveryResult {
  documents: SpecDocument[];
  concepts: Concept[];
  diagnostics: Diagnostic[];
}

const PROJECT_ROOT_GUARD = (projectRoot: string, path: string): string => {
  if (!path.startsWith(projectRoot)) {
    throw new AiBddError('POLICY_DENIED', `<file:> and <table:> paths must stay inside the project root: ${path}`);
  }
  return path;
};

/** Discovers specs by glob, parses them by dialect and loads the concepts. */
export function discover(projectRoot: string, specs: string[], concepts: string[]): DiscoveryResult {
  const diagnostics: Diagnostic[] = [];
  const documents: SpecDocument[] = [];

  let conceptSet: Concept[] = [];
  for (const file of expandGlobs(projectRoot, concepts)) {
    const text = readFileSync(file, 'utf8');
    const parsed = parseConcepts(text, file);
    conceptSet.push(...parsed.concepts);
    diagnostics.push(...parsed.diagnostics);
  }

  for (const file of expandGlobs(projectRoot, specs)) {
    const text = readFileSync(file, 'utf8');
    const result: ParseResult = file.endsWith('.feature')
      ? parseGherkin(text, file)
      : parseGaugeSpec(text, file, {
          concepts: conceptSet,
          readFile: (path: string) => {
            const resolved = path.startsWith('/') ? path : `${projectRoot}/${path}`;
            if (!existsSync(resolved)) throw new AiBddError('POLICY_DENIED', `the spec references a missing file: ${path}`);
            return readFileSync(PROJECT_ROOT_GUARD(projectRoot, resolved), 'utf8');
          },
        });
    documents.push(result.document);
    diagnostics.push(...result.diagnostics);
  }

  return { documents, concepts: conceptSet, diagnostics };
}

export { expandGlobs };
