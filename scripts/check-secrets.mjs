#!/usr/bin/env node
/**
 * AC6: no declared secret value may appear anywhere under .ai-bdd/, in reporter
 * outputs, in the lockfile, or in any model call log. Searches for the raw
 * value plus its URL-encoded and base64 forms.
 *
 * Secrets come from AI_BDD_CHECK_SECRETS (comma separated) and from the
 * `secrets` block of ai-bdd.config.json when present.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function declaredSecrets() {
  const values = new Set();
  for (const raw of (process.env.AI_BDD_CHECK_SECRETS ?? '').split(',')) {
    const value = raw.trim();
    if (value.length >= 4) values.add(value);
  }
  const configPath = join(ROOT, 'ai-bdd.config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      for (const decl of Object.values(config.secrets ?? {})) {
        const value = decl?.value ?? (decl?.env ? process.env[decl.env] : undefined);
        if (typeof value === 'string' && value.length >= 4) values.add(value);
      }
    } catch {
      // ignore malformed config here; the CLI reports it
    }
  }
  return [...values];
}

function variants(value) {
  return [value, encodeURIComponent(value), Buffer.from(value, 'utf8').toString('base64')];
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const secrets = declaredSecrets();
if (secrets.length === 0) {
  process.stdout.write('no secrets declared (set AI_BDD_CHECK_SECRETS to scan)\n');
  process.exit(0);
}

const needles = secrets.flatMap(variants);
const targets = [
  ...walk(join(ROOT, '.ai-bdd')),
  ...walk(join(ROOT, 'reports')),
  join(ROOT, 'ai-bdd.lock.json'),
];
const hits = [];
for (const file of targets) {
  if (!existsSync(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'latin1');
  } catch {
    continue;
  }
  for (const needle of needles) {
    if (text.includes(needle)) hits.push(`${relative(ROOT, file)}: contains a secret variant`);
  }
}

if (hits.length > 0) {
  process.stderr.write(`secret leak detected:\n${hits.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`scanned ${targets.length} files, no secret variants found\n`);
