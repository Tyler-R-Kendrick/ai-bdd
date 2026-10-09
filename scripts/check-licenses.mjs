#!/usr/bin/env node
/**
 * Section 17: no dependency may be AGPL (the cua-perception extension is
 * forbidden by N6). Reads installed package metadata only, so it works offline.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'BlueOak-1.0.0',
  'Python-2.0',
  'MPL-2.0',
  'Unlicense',
  'CC-BY-4.0',
  // Data/metadata licenses seen in build tooling (SPDX exception tables).
  'CC-BY-3.0',
  'CC0-1.0',
  'Apache-2.0 WITH LLVM-exception',
  '(MIT OR CC0-1.0)',
  'MIT OR Apache-2.0',
  'Apache-2.0 OR MIT',
  '(MIT AND Zlib)',
]);
const FORBIDDEN = /AGPL|GPL-3|SSPL|BUSL/iu;
const FORBIDDEN_NAMES = [/cua-perception/u];

const store = join(ROOT, 'node_modules', '.pnpm');
const problems = [];
let scanned = 0;

if (existsSync(store)) {
  for (const entry of readdirSync(store)) {
    if (FORBIDDEN_NAMES.some((re) => re.test(entry))) {
      problems.push(`${entry}: forbidden package`);
      continue;
    }
    const pkgPath = join(store, entry, 'node_modules', entry.split('@')[0]?.includes('/') ? entry.split('@')[0] : entry);
    const candidates = [pkgPath, join(store, entry, 'node_modules', entry.split('@').slice(0, -1).join('@'))];
    for (const candidate of candidates) {
      const manifest = join(candidate, 'package.json');
      if (!existsSync(manifest)) continue;
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        const license = typeof pkg.license === 'string' ? pkg.license : (pkg.licenses ?? []).map((l) => l.type).join(' OR ');
        scanned += 1;
        if (!license) {
          problems.push(`${pkg.name}: missing license field`);
          break;
        }
        if (FORBIDDEN.test(license)) problems.push(`${pkg.name}: ${license}`);
        else if (!ALLOWED.has(license) && !/^(\(|.*\bOR\b)/u.test(license)) {
          problems.push(`${pkg.name}: ${license} (not in the allowlist)`);
        }
        break;
      } catch {
        continue;
      }
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`license audit found ${problems.length} problem(s):\n${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`license audit clean (${scanned} packages scanned)\n`);
