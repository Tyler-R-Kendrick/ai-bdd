import type { Scenario, SpecDocument } from '@ai-bdd/contracts';

/**
 * e2e's replay cache is keyed on the test title, so the title must be stable and
 * unique across a project (F-E5). The shape is
 * `<spec name> › <scenario name>[row]`.
 */
export function titleFor(document: SpecDocument, scenario: Scenario): string {
  const row = scenario.dataRow && scenario.dataRow.length > 0 ? `[${scenario.dataRow.join(',')}]` : '';
  const title = `${document.name} › ${scenario.name}${row}`;
  // e2e requires 1..512 UTF-8 bytes; truncate deterministically and keep it unique.
  if (Buffer.byteLength(title, 'utf8') <= 512) return title;
  return `${title.slice(0, 400)}#${hash(title).slice(0, 8)}`;
}

function hash(value: string): string {
  let hashValue = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 0x01000193) >>> 0;
  }
  return hashValue.toString(16).padStart(8, '0');
}

export function tagNames(tags: string[]): string[] {
  return tags.map((tag) => tag.replace(/^@/u, ''));
}
