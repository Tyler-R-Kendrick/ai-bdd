import { it } from 'vitest';
import { createChunker } from '../../src/markdown/chunker.ts';
const chunk = (text: string) => createChunker().chunk({ uri: 'docs/x.md', absolutePath: '/x', text, sha256: '0'.repeat(64) }, { sectionDepth: 2, maxSectionChars: 12000 });
const cases: [string,(n:number)=>string][] = [
 ['[x]open',(n)=>'['.repeat(n)+'text'+']'.repeat(n)],
 ['*a',(n)=>'*a'.repeat(n)],
 ['*a* pairs',(n)=>'*a* '.repeat(n)],
 ['links',(n)=>'[a](b) '.repeat(n)],
 ['[a](b open',(n)=>'[a](b '.repeat(n)],
 ['![a](',(n)=>'![a]('.repeat(n)],
 ['_a',(n)=>'_a '.repeat(n)],
 ['`',(n)=>'` '.repeat(n)],
 ['<',(n)=>'<a '.repeat(n)],
 ['multi-line [',(n)=>'[[[[[[[[[[\n'.repeat(n/10)],
 ['code',(n)=>'`a'.repeat(n)],
 ['~~',(n)=>'~~a'.repeat(n)],
 ['![',(n)=>'!['.repeat(n)],
 ['**',(n)=>'**a'.repeat(n)],
 ['<<',(n)=>'<'.repeat(n)],
 ['&',(n)=>'&amp'.repeat(n)],
 ['\\',(n)=>'\\['.repeat(n)],
 ['http',(n)=>'http://a '.repeat(n)],
 ['www',(n)=>'www.a '.repeat(n)],
 ['@',(n)=>'a@b '.repeat(n)],
 ['[^',(n)=>'[^a '.repeat(n)],
 ['|',(n)=>'| a '.repeat(n)+'\n|--|\n'],
];
for (const [l,mk] of cases) it(l, () => {
  const r:string[]=[];
  for (const n of [10000,20000,40000]) { const s='# T\n\n'+mk(n)+'\n'; const t=performance.now(); chunk(s); r.push(`${n}:${Math.round(performance.now()-t)}ms`); }
  process.getBuiltinModule('node:fs').appendFileSync('/tmp/claude-0/-home-user-ai-bdd/0a1cf405-8758-5453-981b-eb6b83c053de/scratchpad/m.out', l+' '+r.join(' ')+'\n');
}, 120000);
