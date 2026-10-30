import { copyFile, mkdir } from 'node:fs/promises';
await mkdir(new URL('../dist/server/', import.meta.url), { recursive: true });
await copyFile(
  new URL('../server/local/studio-local-worker.mjs', import.meta.url),
  new URL('../dist/server/studio-local-worker.mjs', import.meta.url),
);

await copyFile(
  new URL('../server/local/studio-local-decisions.mjs', import.meta.url),
  new URL('../dist/server/studio-local-decisions.mjs', import.meta.url),
);

await copyFile(
  new URL('../verification/native-app-smoke.mjs', import.meta.url),
  new URL('../dist/server/studio-native-app-smoke.mjs', import.meta.url),
);
