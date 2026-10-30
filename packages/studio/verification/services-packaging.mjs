import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the same pinned official resolver used by the actual cloud build.
// This reads public CLI/source files only, without auth, env pulls, or network.
const cliRoot = process.argv[2];
assert.ok(
  cliRoot && isAbsolute(cliRoot),
  'Supply the installed Vercel CLI package directory',
);
const cli = JSON.parse(
  await readFile(resolve(cliRoot, 'package.json'), 'utf8'),
);
assert.equal(cli.name, 'vercel');
assert.equal(
  cli.version,
  '65.8.0',
  'Review the resolver import when updating the pinned CLI',
);
const { require_dist2 } = await import(
  pathToFileURL(resolve(cliRoot, 'dist/chunks/chunk-3P4Y46MS.js')).href
);
const { LocalFileSystemDetector, resolveAllConfiguredServicesV2 } =
  require_dist2();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const config = JSON.parse(
  await readFile(resolve(repoRoot, 'vercel.json'), 'utf8'),
);
const fs = new LocalFileSystemDetector(repoRoot);
const resolved = await resolveAllConfiguredServicesV2(config.services, fs);
assert.deepEqual(resolved.errors, []);
const names = ['jobs', 'maintenance', 'bootstrap'];
const entries = [
  'api/studio-jobs.ts',
  'api/studio-maintenance.ts',
  'api/studio-maintenance-bootstrap.ts',
];
const durations = [300, 120, 120];
const topics = ['studio-jobs-v1', 'studio-maintenance-v1', null];
const native = names.map((name, i) => {
  const service = resolved.services.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(service, 'Missing native service ' + name);
  assert.equal(service.runtime, 'node');
  assert.equal(service.entrypoint, entries[i]);
  assert.equal(service.builder.use, '@vercel/backends');
  assert.equal(service.builder.src, 'packages/studio/' + entries[i]);
  assert.equal(service.builder.config.serviceName, name);
  assert.deepEqual(service.bindings, [
    {
      type: 'service',
      service: 'backend',
      format: 'url',
      env: 'STUDIO_BACKEND_URL',
    },
  ]);
  assert.equal(service.functions[entries[i]].maxDuration, durations[i]);
  const triggers = service.functions[entries[i]].experimentalTriggers ?? [];
  if (topics[i]) {
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].type, 'queue/v2beta');
    assert.equal(triggers[0].topic, topics[i]);
    assert.equal(triggers[0].maxDeliveries, 10);
    assert.equal(triggers[0].retryAfterSeconds, 30);
    assert.equal(triggers[0].maxConcurrency, i === 0 ? 8 : 1);
    assert.ok(
      !config.rewrites.some((rule) => rule.destination?.service === name),
      'Queue consumers must remain private',
    );
  } else {
    assert.deepEqual(triggers, []);
    assert.deepEqual(
      config.rewrites
        .filter((rule) => rule.destination?.service === name)
        .map((rule) => rule.source),
      ['/api/studio-maintenance-bootstrap'],
    );
  }
  return {
    name,
    entrypoint: service.entrypoint,
    builder: service.builder.use,
    topic: topics[i],
    maxDuration: durations[i],
    binding: 'backend',
    publicRoute: topics[i] ? null : '/api/studio-maintenance-bootstrap',
  };
});
const frontend = resolved.services.find(
  (service) => service.name === 'frontend',
);
assert.equal(frontend.builder.use, '@vercel/static-build');
assert.equal(frontend.functions, undefined);

// Reproduce why a functions map on the previous static-only service was insufficient.
const previous = structuredClone(config.services.frontend);
previous.functions = Object.fromEntries(
  names.map((name, i) => [
    entries[i],
    config.services[name].functions[entries[i]],
  ]),
);
const old = await resolveAllConfiguredServicesV2(
  { frontend: previous, backend: config.services.backend },
  fs,
);
assert.deepEqual(old.errors, []);
assert.equal(old.services.length, 2);
assert.equal(
  old.services.filter((service) => service.builder.use === '@vercel/backends')
    .length,
  0,
);
assert.equal(
  resolved.services.filter(
    (service) => service.builder.use === '@vercel/backends',
  ).length,
  3,
);
console.log(
  JSON.stringify(
    {
      passed: true,
      cli: cli.version,
      networkCalls: 0,
      oldNativeBuilders: 0,
      newNativeBuilders: 3,
      services: native,
    },
    null,
    2,
  ),
);
