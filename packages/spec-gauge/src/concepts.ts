/**
 * Gauge concept (`.cpt`) parsing (sections 4.3 and P9).
 *
 * A `#` heading (or an `=`-underlined line) is a concept signature; the `*`
 * steps that follow it are the concept body. A file may hold several concepts.
 */
import type { Concept, ConceptStep, Diagnostic } from '@ai-bdd/contracts';
import { readStepBlock } from './blocks.js';
import { isFence, isSpecHeading, isUnderlineEq, splitLines, type Line } from './text.js';

const PARAMETER = /<\s*([^<>]+?)\s*>/gu;

/** Ordered `<param>` names in a signature, excluding the special parameters. */
export function conceptParameters(signature: string): string[] {
  const names: string[] = [];
  for (const match of signature.matchAll(PARAMETER)) {
    const name = (match[1] ?? '').trim();
    if (name.length === 0) continue;
    if (/^(?:file|table|secret)\s*:/iu.test(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export function parseConcepts(text: string, uri: string): { concepts: Concept[]; diagnostics: Diagnostic[] } {
  const lines = splitLines(text);
  const concepts: Concept[] = [];
  const diagnostics: Diagnostic[] = [];
  let current: Concept | null = null;
  const currentConcept = (): Concept | null => current;
  let fence: string | null = null;

  const startConcept = (signature: string, line: Line): void => {
    current = {
      id: `${uri}#${signature}`,
      signature,
      parameters: conceptParameters(signature),
      body: [],
      location: { uri, line: line.number, column: line.column },
      uri,
    };
    concepts.push(current);
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as Line;
    const trimmed = line.text;
    if (fence !== null) {
      if (isFence(trimmed)) fence = null;
      index += 1;
      continue;
    }
    if (isFence(trimmed)) {
      fence = trimmed[0] ?? null;
      index += 1;
      continue;
    }
    if (trimmed === '') {
      index += 1;
      continue;
    }
    if (isSpecHeading(trimmed)) {
      startConcept(trimmed.slice(1).trim(), line);
      index += 1;
      continue;
    }
    if (index + 1 < lines.length && isUnderlineEq((lines[index + 1] as Line).text)) {
      startConcept(trimmed, line);
      index += 2;
      continue;
    }
    if (trimmed.startsWith('*') && !trimmed.startsWith('**')) {
      const block = readStepBlock(lines, index, uri, 'scenario', diagnostics);
      if (currentConcept() !== null) {
        const step: ConceptStep = {
          text: block.raw.text,
          args: block.raw.args,
          location: block.raw.location,
        };
        currentConcept()!.body.push(step);
      }
      index = block.next;
      continue;
    }
    index += 1;
  }

  return { concepts, diagnostics };
}
