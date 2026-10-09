import type {
  Action,
  ActionResult,
  ArtifactRef,
  Capabilities,
  DriverSession,
  JsonValue,
  Observation,
} from '@ai-bdd/contracts';
import { AiBddError, sha256Hex } from '@ai-bdd/contracts';
import { E2E_VERB_MAP, capabilitiesFromCatalog } from './verbs.js';
import { parseObserveText, toObservation } from './observe.js';
import { extractErrorCode, type McpCaller } from './mcp.js';

export interface E2eSessionOptions {
  caller: McpCaller;
  sessionId: string;
  catalog: string[];
  driverId: string;
  driverMajor: number;
  target?: string;
  initialRoute?: string;
  now?: () => Date;
}

/** One `e2e mcp` session, exposed through the ai-bdd driver contract. */
export class E2eSession implements DriverSession {
  readonly id: string;
  readonly driverId: string;
  readonly driverMajor: number;
  readonly target?: JsonValue;
  readonly capabilities: Capabilities;

  private readonly caller: McpCaller;
  private readonly catalog: string[];
  private readonly now: () => Date;
  private revision = 0;
  private tainted = false;
  private closed = false;
  private route?: string;

  constructor(options: E2eSessionOptions) {
    this.caller = options.caller;
    this.id = options.sessionId;
    this.driverId = options.driverId;
    this.driverMajor = options.driverMajor;
    this.catalog = options.catalog;
    this.now = options.now ?? (() => new Date());
    this.capabilities = capabilitiesFromCatalog(options.catalog);
    if (options.target !== undefined) this.target = { target: options.target };
    if (options.initialRoute !== undefined) this.route = options.initialRoute;
  }

  private assertOpen(): void {
    if (this.closed) throw new AiBddError('NO_SESSION', 'the session is closed');
  }

  async observe(options: { pixels?: boolean } = {}): Promise<Observation> {
    this.assertOpen();
    this.revision += 1;
    const payload = await this.caller.call(this.id, 'observe', {});
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
    const parsed = parseObserveText(text, this.revision);
    const route = extractRoute(payload) ?? this.route;
    if (route) this.route = route;

    let screenshot: ArtifactRef | undefined;
    if (options.pixels && this.capabilities.pixels && !this.tainted) {
      const shot = await this.caller.call(this.id, 'screenshot', {});
      const bytes = screenshotBytes(shot);
      if (bytes) {
        const sha256 = sha256Hex(bytes);
        screenshot = {
          sha256,
          ext: 'png',
          mediaType: 'image/png',
          path: `artifacts/${sha256}.png`,
          bytes: bytes.length,
        };
      }
    }

    const url = extractUrl(payload);
    return toObservation({
      revision: this.revision,
      nodes: parsed.nodes,
      ...(route !== undefined ? { route } : {}),
      ...(url !== undefined ? { url } : {}),
      tainted: this.tainted,
      maskingProven: this.capabilities.maskingProven,
      settled: true,
      capturedAt: this.now().toISOString(),
      ...(screenshot !== undefined ? { screenshot } : {}),
    });
  }

  async perform(action: Action): Promise<ActionResult> {
    this.assertOpen();
    const tool = E2E_VERB_MAP[action.verb];
    if (tool === null || !this.catalog.includes(tool)) {
      return {
        ok: false,
        verb: action.verb,
        error: `the e2e target does not support ${action.verb}`,
        code: 'DRIVER_INCOMPATIBLE',
      };
    }
    const args: Record<string, JsonValue> = {};
    if (action.ref) args.id = action.ref;
    if (action.selector) args.selector = action.selector as unknown as JsonValue;
    if (action.value !== undefined) args.text = action.value;
    if (action.secretName !== undefined) args.name = action.secretName;
    if (action.coords) {
      args.x = action.coords.x;
      args.y = action.coords.y;
    }
    if (action.params !== undefined) args.params = action.params;
    try {
      const payload = await this.caller.call(this.id, tool, args);
      if (action.verb === 'typeSecret') this.tainted = true;
      const route = extractRoute(payload);
      if (route) this.route = route;
      return {
        ok: true,
        verb: action.verb,
        ...(route ? { route } : {}),
        ...(this.tainted ? { tainted: true } : {}),
      };
    } catch (error) {
      const code = error instanceof AiBddError ? error.code : extractErrorCode(String(error));
      return {
        ok: false,
        verb: action.verb,
        error: error instanceof Error ? error.message : String(error),
        ...(code ? { code: String(code) } : {}),
      };
    }
  }

  async startRecording(): Promise<void> {
    this.assertOpen();
    if (this.catalog.includes('start_recording')) await this.caller.call(this.id, 'start_recording', {});
  }

  async stopRecording(): Promise<ArtifactRef | undefined> {
    if (this.closed || !this.catalog.includes('stop_recording')) return undefined;
    const payload = await this.caller.call(this.id, 'stop_recording', {});
    const bytes = screenshotBytes(payload);
    if (!bytes) return undefined;
    const sha256 = sha256Hex(bytes);
    return { sha256, ext: 'webm', mediaType: 'video/webm', path: `artifacts/${sha256}.webm`, bytes: bytes.length };
  }

  maskingProven(): boolean {
    return this.capabilities.maskingProven;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.caller.closeSession(this.id);
  }
}

function extractRoute(payload: JsonValue): string | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, JsonValue>;
    const value = record.url ?? record.route;
    if (typeof value === 'string') return routeOf(value);
  }
  if (typeof payload === 'string') {
    const match = /(?:url|route)[=:]\s*"?(?<url>[^\s"]+)/iu.exec(payload);
    if (match?.groups?.url) return routeOf(match.groups.url);
  }
  return undefined;
}

function extractUrl(payload: JsonValue): string | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = (payload as Record<string, JsonValue>).url;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function routeOf(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Accepts base64 payloads, data URLs and local file paths for screenshots. */
function screenshotBytes(payload: JsonValue): Uint8Array | undefined {
  if (payload instanceof Uint8Array) return payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, JsonValue>;
    const base64 = record.base64 ?? record.data;
    if (typeof base64 === 'string') return Uint8Array.from(Buffer.from(base64, 'base64'));
  }
  if (typeof payload === 'string') {
    if (payload.startsWith('data:image')) {
      const base64 = payload.split(',')[1] ?? '';
      return Uint8Array.from(Buffer.from(base64, 'base64'));
    }
    if (/^[A-Za-z0-9+/=\s]+$/u.test(payload) && payload.length > 64) {
      return Uint8Array.from(Buffer.from(payload, 'base64'));
    }
  }
  return undefined;
}
