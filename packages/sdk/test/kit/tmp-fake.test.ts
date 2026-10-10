import { afterAll, beforeAll } from 'vitest';
import { startAcmeApp } from '@ai-bdd/testing';
import { playwright } from '@ai-bdd/driver-playwright';
import { runDriverConformance } from './driver-conformance.ts';

const app = await startAcmeApp({ port: 0 });
afterAll(async () => { await app.close(); });
void beforeAll;
runDriverConformance('playwright (ad hoc)', () => playwright(), { appUrl: app.url });
