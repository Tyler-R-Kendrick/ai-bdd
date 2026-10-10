// @ts-nocheck
import type {
  CreateActor,
  CreateAsserter,
  CreateChunker,
  CreateEvidenceStore,
  CreateExtractor,
  CreateJudge,
  CreatePlanStore,
  CreatePlanner,
  CreateRecorder,
  CreateRecordingStore,
  CreateRedactor,
  CreateReporters,
  CreateRunner,
  CreateSettler,
  DiscoverDocs,
  EngineDeps,
  VerifyRun,
} from '../contracts/index.ts';
import { createActor } from '../agent/index.ts';
import { createAsserter } from '../assert/index.ts';
import { createEvidenceStore, createRedactor, createSettler, systemClock, verifyRun } from '../evidence/index.ts';
import { createExtractor, EXTRACT_PROMPT_VERSION } from '../extract/index.ts';
import { createJudge } from '../judge/index.ts';
import { createChunker, discoverDocs } from '../markdown/index.ts';
import { createPlanStore, createPlanner } from '../plan/index.ts';
import { createRecorder, createRecordingStore } from '../recording/index.ts';
import { createReporters } from '../report/index.ts';
import { createRunner } from '../runner/index.ts';

/**
 * Every sibling module the engine wires, as factories. The defaults are the real implementations;
 * tests inject in-memory fakes through `createEngine(config, { modules })`.
 */
export interface EngineModules {
  discoverDocs: DiscoverDocs;
  createChunker: CreateChunker;
  createExtractor: CreateExtractor;
  extractPromptVersion: string;
  createPlanner: (config: Parameters<CreatePlanner>[0], redact?: (text: string) => string) => ReturnType<CreatePlanner>;
  createPlanStore: CreatePlanStore;
  createActor: CreateActor;
  createRecorder: CreateRecorder;
  createRecordingStore: CreateRecordingStore;
  createAsserter: CreateAsserter;
  createJudge: CreateJudge;
  createEvidenceStore: CreateEvidenceStore;
  createRedactor: CreateRedactor;
  createSettler: CreateSettler;
  verifyRun: VerifyRun;
  createRunner: CreateRunner;
  createReporters: CreateReporters;
}

/** Extra, internal-only overrides accepted by `createEngine` next to the public `EngineDeps`. */
export interface EngineOverrides extends Partial<EngineDeps> {
  modules?: Partial<EngineModules>;
}

/** Thin wrappers resolve the sibling export at call time, so stubs and late-landing modules never fail at import. */
export function defaultModules(): EngineModules {
  return {
    discoverDocs: (c) => discoverDocs(c),
    createChunker: () => createChunker(),
    createExtractor: (d) => createExtractor(d),
    extractPromptVersion: EXTRACT_PROMPT_VERSION,
    createPlanner: (c, redact) => createPlanner(c, redact),
    createPlanStore: (o) => createPlanStore(o),
    createActor: (d) => createActor(d),
    createRecorder: (d) => createRecorder(d),
    createRecordingStore: (o) => createRecordingStore(o),
    createAsserter: (d) => createAsserter(d),
    createJudge: (d) => createJudge(d),
    createEvidenceStore: (o) => createEvidenceStore(o),
    createRedactor: (s) => createRedactor(s),
    createSettler: (o) => createSettler(o),
    verifyRun: (d) => verifyRun(d),
    createRunner: (d) => createRunner(d),
    createReporters: (n) => createReporters(n),
  };
}

export { systemClock };
