import { describe, expect, it } from 'vitest';
import { consumeRubricTable, consumeRubricTableDetailed } from '../src/index.js';

describe('consumeRubricTable (section 7.3 data-table rubric)', () => {
  it('consumes a table whose header is exactly | ai-bdd | value |', () => {
    expect(
      consumeRubricTable({
        header: ['ai-bdd', 'value'],
        rows: [
          ['kind', 'action'],
          ['mode', 'judge'],
          ['threshold', '0.85'],
        ],
      }),
    ).toEqual({ kind: 'action', mode: 'judge', threshold: 0.85 });
  });

  it('returns null for any other header', () => {
    expect(consumeRubricTable({ header: ['name', 'value'], rows: [['kind', 'action']] })).toBeNull();
    expect(consumeRubricTable({ header: ['ai-bdd', 'result'], rows: [] })).toBeNull();
    expect(consumeRubricTable({ header: ['ai-bdd'], rows: [] })).toBeNull();
    expect(consumeRubricTable({ header: [], rows: [] })).toBeNull();
  });

  it('skips empty rows', () => {
    expect(consumeRubricTable({ header: ['ai-bdd', 'value'], rows: [['', ''], ['kind', 'setup']] })).toEqual({
      kind: 'setup',
    });
  });

  it('reports invalid rows through the detailed form', () => {
    const result = consumeRubricTableDetailed({
      header: ['ai-bdd', 'value'],
      rows: [
        ['kind', 'action'],
        ['mode', 'maybe'],
        ['mystery', '1'],
      ],
    });
    expect(result?.options).toEqual({ kind: 'action' });
    expect(result?.diagnostics.map((d) => d.code)).toEqual([
      'DIRECTIVE_INVALID_VALUE',
      'DIRECTIVE_UNKNOWN_KEY',
    ]);
  });

  it('validates failThreshold against threshold in the same table', () => {
    const result = consumeRubricTableDetailed({
      header: ['ai-bdd', 'value'],
      rows: [
        ['threshold', '0.5'],
        ['failThreshold', '0.6'],
      ],
    });
    expect(result?.diagnostics.map((d) => d.code)).toEqual(['DIRECTIVE_INVALID_VALUE']);
  });
});
