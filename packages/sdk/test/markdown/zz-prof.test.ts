import { it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
it('p', () => {
  const out: string[] = [];
  const P = '';
  const variants: Record<string, string> = {
    'inert [': (P + 'a](b ').repeat(20000),
    'inert [ and (': (P + 'a]' + P + 'b ').repeat(20000),
    'only ]': ']'.repeat(40000),
    'a] ': 'a] '.repeat(20000),
    'plain': 'abc '.repeat(30000),
    'gfm none': 'x'.repeat(100000),
    '(': '('.repeat(40000),
    '](': ']('.repeat(20000),
  };
  for (const [k, v] of Object.entries(variants)) {
    for (const ext of [false, true]) {
      const t = performance.now();
      fromMarkdown('# T\n\n' + v + '\n', ext ? { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] } : {});
      out.push(`${k} gfm=${ext} ${Math.round(performance.now() - t)}`);
    }
  }
  process.getBuiltinModule('node:fs').writeFileSync('/tmp/claude-0/-home-user-ai-bdd/0a1cf405-8758-5453-981b-eb6b83c053de/scratchpad/p.out', out.join('\n'));
}, 120000);
