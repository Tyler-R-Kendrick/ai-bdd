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
  for (const n of [2500,5000,10000]) { const s='# T\n\n'+mk(n)+'\n'; const t=performance.now(); chunk(s); r.push(`${n}:${Math.round(performance.now()-t)}ms`); }
  console.log(l, r.join(' '));
}, 120000);
