/**
 * Concept expansion (P9) and step parameter resolution (P6).
 */
import {
  csvToTable,
  parseCsv,
  type Line,
} from './text.js';
import { matchTemplate, renderTemplate } from '@ai-bdd/contracts';
import type {
  Concept,
  Diagnostic,
  SourceLocation,
  StepArg,
  StepOptions,
  StepOrigin,
  StepPhase,
} from '@ai-bdd/contracts';
import type { RawStep } from './blocks.js';

export interface ExpandedStep {
  text: string;
  args: StepArg[];
  options: Partial<StepOptions>;
  location: SourceLocation;
  phase: StepPhase;
  originChain: StepOrigin[];
  conceptArgs?: Record<string, string>;
}

function substituteInTableArg(arg: StepArg, values: Record<string, string>): StepArg {
  if (arg.type === 'table') {
    return {
      ...arg,
      table: {
        header: arg.table.header.map((cell) => renderTemplate(cell, values)),
        rows: arg.table.rows.map((row) => row.map((cell) => renderTemplate(cell, values))),
      },
    };
  }
  if (arg.type === 'docString') {
    return { ...arg, content: renderTemplate(arg.content, values) };
  }
  return arg;
}

function expandOne(
  raw: RawStep,
  concepts: Concept[],
  diagnostics: Diagnostic[],
  chain: StepOrigin[],
): ExpandedStep[] {
  const concept = concepts.find((candidate) => matchTemplate(candidate.signature, raw.text) !== null);
  if (concept === undefined) {
    const leaf: ExpandedStep = {
      text: raw.text,
      args: raw.args,
      options: raw.options,
      location: raw.location,
      phase: raw.phase,
      originChain: chain,
    };
    const innermost = chain[chain.length - 1];
    if (innermost !== undefined) leaf.conceptArgs = innermost.args;
    return [leaf];
  }

  if (chain.some((origin) => origin.conceptId === concept.id)) {
    diagnostics.push({
      code: 'GAUGE_CONCEPT_CYCLE',
      severity: 'error',
      message: `Concept "${concept.signature}" expands recursively.`,
      location: raw.location,
      details: { conceptId: concept.id },
    });
    return [
      {
        text: raw.text,
        args: raw.args,
        options: raw.options,
        location: raw.location,
        phase: raw.phase,
        originChain: chain,
      },
    ];
  }

  const match = matchTemplate(concept.signature, raw.text);
  const args = match?.params ?? {};
  const origin: StepOrigin = {
    conceptId: concept.id,
    signature: concept.signature,
    definition: concept.location,
    callSite: raw.location,
    args,
  };
  const nextChain = [...chain, origin];
  const expanded: ExpandedStep[] = [];
  for (const body of concept.body) {
    const substituted: RawStep = {
      text: renderTemplate(body.text, args),
      args: body.args.map((arg) => substituteInTableArg(arg, args)),
      options: raw.options,
      location: raw.location,
      phase: raw.phase,
    };
    expanded.push(...expandOne(substituted, concepts, diagnostics, nextChain));
  }
  return expanded;
}

/** Expand every concept call in place, recording origin chains (P9). */
export function expandConcepts(
  steps: RawStep[],
  concepts: Concept[],
  diagnostics: Diagnostic[],
): ExpandedStep[] {
  const out: ExpandedStep[] = [];
  for (const step of steps) out.push(...expandOne(step, concepts, diagnostics, []));
  return out;
}
