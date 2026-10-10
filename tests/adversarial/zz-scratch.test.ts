import { it } from 'vitest';
import { createChunker } from '@ai-bdd/sdk';

const chunk = (text: string) => createChunker().chunk({ uri: 'docs/x.md', absolutePath: '/x', text, sha256: '0'.repeat(64) }, { sectionDepth: 2, maxSectionChars: 12000 });
const time = (label: string, text: string) => { const t = performance.now(); let err = ''; try { chunk(text); } catch (e) { err = String(e).slice(0, 80); } console.log(label, text.length, (performance.now() - t).toFixed(0), 'ms', err); };

it('scratch', () => {
  for (const n of [20000, 40000]) {
    time(`fm alias colons n=${n}`, `---\na: *${':'.repeat(n)}x\n---\n\n# T\n\ntext here\n`);
    time(`fm tags array n=${n}`, `---\nai-bdd:\n  tags: [${Array.from({ length: n }, (_, i) => `t${i}`).join(',')}]\n---\n\n# T\n\ntext here\n`);
    time(`directive many`, `# T\n\n` + Array.from({ length: n }, () => '<!-- ai-bdd: tags=a,b -->\n\ntext\n\n').join(''));
    time(`unterminated comment`, `# T\n\n<!-- ai-bdd: ${'a=b '.repeat(n)}\n\ntext`);
    time(`quoted backslashes`, `# T\n\n<!-- ai-bdd: x="${'\\\\'.repeat(n)}" -->\n\ntext`);
    time(`brackets`, `# T\n\n${'['.repeat(n)}text${']'.repeat(n)}\n`);
    time(`emphasis`, `# T\n\n${'*a'.repeat(n)}\n`);
    time(`emphasis underscore`, `# T\n\n${'_a'.repeat(n)}\n`);
    time(`backticks`, `# T\n\n${'`'.repeat(n)} x ${'`'.repeat(n - 1)}\n`);
    time(`links`, `# T\n\n${'[a](b '.repeat(n)}\n`);
    time(`images`, `# T\n\n${'![a]('.repeat(n)}\n`);
    time(`html open`, `# T\n\n${'<a '.repeat(n)}\n`);
    time(`table cols`, `# T\n\n|${' a |'.repeat(n)}\n|${'---|'.repeat(n)}\n|${' b |'.repeat(n)}\n`);
    time(`table rows`, `# T\n\n| a | b |\n|---|---|\n${'| c | d |\n'.repeat(n)}`);
    time(`indent nest`, '# T\n\n' + Array.from({ length: Math.min(n / 20, 2000) }, (_, i) => `${' '.repeat(i * 2)}- item ${i}`).join('\n') + '\n');
    time(`blockquote nest lines`, '# T\n\n' + Array.from({ length: Math.min(n / 20, 3000) }, (_, i) => `${'>'.repeat(i % 90 + 1)} q`).join('\n') + '\n');
    time(`many headings`, Array.from({ length: n }, (_, i) => `## H${i}\n\ntext ${i}\n`).join('\n'));
    time(`setext`, `${'a\n'.repeat(n)}===\n`);
    time(`list items`, Array.from({ length: n }, (_, i) => `- item ${i}`).join('\n'));
    time(`ref defs`, Array.from({ length: n }, (_, i) => `[r${i}]: http://x/${i}`).join('\n') + '\n\n[r1]\n');
    time(`entities`, `# T\n\n${'&amp;'.repeat(n)}\n`);
    time(`html comment lines`, `# T\n\n${'<!-- c -->\n'.repeat(n)}\ntext`);
    time(`dupe headings`, Array.from({ length: n }, () => `## Same\n\ntext\n`).join('\n'));
  }
}, 600000);
