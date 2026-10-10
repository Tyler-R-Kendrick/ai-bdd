import { it } from 'vitest';
import { chunkText } from './helpers.ts';
it('x', () => {
  const out: string[] = [];
  const cases: Record<string, string> = {
    mixed: '*a_b[c~d!['.repeat(7000),
    brword: '[ ' + 'a@b '.repeat(100000),
    brword2: '[ ' + 'abcd '.repeat(100000),
    refs: '[a]: x\n'.repeat(20000),
    lines: 'a\n'.repeat(100000),
    lines2: 'a\n'.repeat(250000),
    table: '|a|b|\n|-|-|\n' + '|[x]|*y*|\n'.repeat(20000),
    tablecell: '|a|b|\n|-|-|\n|[ ' + 'a@b '.repeat(50000) + '|x]|\n',
    manybr: ('[ ' + 'a@b '.repeat(300) + '\n\n').repeat(300),
    spaces: 'x ' + ' '.repeat(400000),
    under: 'a_b_'.repeat(100000),
    under2: '_a '.repeat(150000),
    star: '* '.repeat(200000),
    http: 'http://a '.repeat(50000),
    emails: 'a@b.c '.repeat(80000),
  };
  for (const [k, v] of Object.entries(cases)) { const t = performance.now(); chunkText('# T\n\n' + v + '\n'); out.push(`${k} ${v.length} ${Math.round(performance.now() - t)}`); process.getBuiltinModule('node:fs').writeFileSync('/tmp/claude-0/-home-user-ai-bdd/0a1cf405-8758-5453-981b-eb6b83c053de/scratchpad/z.out', out.join('\n')); }
}, 600000);
