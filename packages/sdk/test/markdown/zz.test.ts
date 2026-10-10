import { it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteral } from '/home/user/ai-bdd/node_modules/.pnpm/micromark-extension-gfm-autolink-literal@2.1.0/node_modules/micromark-extension-gfm-autolink-literal/index.js';
it('x', () => {
  const out: string[] = [];
  for (const pre of ['', '[ ', '( ', '* ', '_ ', '~ ', '< ', '[x] ', '] ', '"', '[[[[ ', 'w ']) for (const word of ['abcd ', 'a@b ', 'www.a ']) {
    const v = '# T\n\n' + pre + word.repeat(10000);
    const t = performance.now(); fromMarkdown(v, { extensions: [gfmAutolinkLiteral()] }); out.push(`${JSON.stringify(pre)} ${JSON.stringify(word)} ${v.length} ${Math.round(performance.now() - t)}`);
  }
  process.getBuiltinModule('node:fs').writeFileSync('/tmp/claude-0/-home-user-ai-bdd/0a1cf405-8758-5453-981b-eb6b83c053de/scratchpad/z.out', out.join('\n'));
}, 300000);
