import type { JsonValue } from './primitives.js';

/** Verbs a driver may support. Capabilities decide which are actually present. */
export const VERBS = [
  'tap',
  'doubleTap',
  'longPress',
  'secondaryTap',
  'hover',
  'type',
  'typeSecret',
  'press',
  'select',
  'check',
  'scroll',
  'scrollTo',
  'drag',
  'navigate',
  'back',
  'upload',
  'tapAt',
  'typeAt',
  'invokeMenu',
] as const;

export type Verb = (typeof VERBS)[number];

export interface Capabilities {
  verbs: Verb[];
  /** Screenshots are available. */
  pixels: boolean;
  /** An accessibility/semantic tree is available. */
  tree: boolean;
  video: boolean;
  /** The driver can evaluate predicates natively (Cua `verify_state`). */
  nativePredicates: boolean;
  /** The driver proves that secret fields were masked in a capture. */
  maskingProven: boolean;
  deliveryModes?: Array<'background' | 'foreground'>;
}

export interface ConcurrencyDeclaration {
  maxSessions: number;
  /** When set, only one session at a time may hold this resource (R-K13). */
  exclusiveResource?: string;
}

/** Structural selector recorded by a running act program. */
export interface Selector {
  role: string;
  name?: string;
  testId?: string;
  text?: string;
  /** Nearest named ancestors, at most three, outermost first. */
  ancestors?: Array<{ role: string; name?: string }>;
  /** Index among same-role siblings without names. */
  index?: number;
}

export interface ObservedNode {
  ref: string;
  role: string;
  name: string;
  testId?: string;
  text?: string;
  /** Named state flags, e.g. `{checked: true, disabled: false}`. */
  state?: Record<string, JsonValue>;
  children?: ObservedNode[];
}

export interface ArtifactRef {
  sha256: string;
  ext: string;
  mediaType?: string;
  path: string;
  bytes?: number;
}

export interface Observation {
  revision: number;
  nodes: ObservedNode[];
  treeHash: string;
  url?: string;
  route?: string;
  title?: string;
  screenshot?: ArtifactRef;
  /** True after a secret fill in this session until a clean re-observation. */
  tainted: boolean;
  maskingProven: boolean;
  settled: boolean;
  capturedAt: string;
}

export interface Action {
  verb: Verb;
  selector?: Selector;
  ref?: string;
  value?: string;
  secretName?: string;
  params?: JsonValue;
  delivery?: 'background' | 'foreground';
  coords?: { x: number; y: number };
  captureId?: string;
  /** Wall-clock deadline for this single action. */
  timeoutMs?: number;
}

export interface ActionResult {
  ok: boolean;
  verb: Verb;
  error?: string;
  code?: string;
  /** True when the driver tainted the session because of this action. */
  tainted?: boolean;
  route?: string;
}

export interface DriverContext {
  sessionId: string;
  scenarioId: string;
  driver?: string;
  target?: JsonValue;
  config: JsonValue;
  logger?: (message: string) => void;
}

export interface DriverSession {
  id: string;
  driverId: string;
  driverMajor: number;
  target?: JsonValue;
  observe(options?: { pixels?: boolean }): Promise<Observation>;
  perform(action: Action): Promise<ActionResult>;
  /** Evaluate a driver-native predicate (Cua `verify_state`). */
  verifyNative?(predicates: JsonValue): Promise<Array<'satisfied' | 'unsatisfied' | 'unknown'>>;
  startRecording?(): Promise<void>;
  stopRecording?(): Promise<ArtifactRef | undefined>;
  /** Whether a secret fill produced a masked capture (R-K15). */
  maskingProven?(): boolean;
  close(): Promise<void>;
}

export interface SelfCheckResult {
  ok: boolean;
  driver: string;
  problems: string[];
  details?: JsonValue;
}

export interface Driver {
  id: string;
  /** Major version of the driver implementation, part of act/check cache keys. */
  major: number;
  capabilities: Capabilities;
  concurrency: ConcurrencyDeclaration;
  selfCheck(): Promise<SelfCheckResult>;
  openSession(ctx: DriverContext): Promise<DriverSession>;
}

export interface DriverFactory {
  id: string;
  /** Configured target name, e.g. `web` or `mobile`. */
  target: string;
  create(ctx: DriverContext): Promise<Driver>;
}
