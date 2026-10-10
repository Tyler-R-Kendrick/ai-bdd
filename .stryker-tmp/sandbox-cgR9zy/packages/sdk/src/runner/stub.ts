// @ts-nocheck
import type { Step } from '../contracts/index.ts';

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** camelCase of the step text, at most 40 characters, always a valid identifier. */
export function fixtureNameFor(text: string): string {
  const words = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[A-Za-z0-9]+/g) ?? [];
  let out = '';
  words.forEach((w, i) => {
    const lower = w.toLowerCase();
    out += i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  if (out === '') out = 'fixture';
  if (/^[0-9]/.test(out)) out = `f${out}`;
  return out.slice(0, 40);
}

function paramType(value: string): 'string' | 'number' | 'boolean' {
  if (/^-?\d+(\.\d+)?$/.test(value)) return 'number';
  if (value === 'true' || value === 'false') return 'boolean';
  return 'string';
}

/** TypeScript `FixtureDefinition` skeleton for a `given` step that needs data state (R-FX1). */
export function buildFixtureStub(step: Pick<Step, 'text' | 'params'>): { name: string; stub: string } {
  const name = fixtureNameFor(step.text);
  const params = Object.entries(step.params);
  const paramLines = params.map(([k, v]) => {
    const key = IDENT.test(k) ? k : JSON.stringify(k);
    return `    ${key}: { type: '${paramType(v)}', description: ${JSON.stringify(`example: ${v}`)} },`;
  });
  const lines = [
    "import type { FixtureDefinition } from '@ai-bdd/sdk';",
    '',
    `export const ${name}: FixtureDefinition = {`,
    `  name: ${JSON.stringify(name)},`,
    `  description: ${JSON.stringify(step.text)},`,
    params.length > 0 ? ['  params: {', ...paramLines, '  },'].join('\n') : '  params: {},',
    '  async run(args, ctx) {',
    '    // Arrange the application state this step needs, for example with ctx.session.request(...).',
    '    // Optionally return an async function that removes that state after the scenario.',
    '  },',
    '};',
    '',
  ];
  return { name, stub: lines.join('\n') };
}
