import {
  LOCAL_MODELS,
  localModelFingerprint,
  localModelPresent,
} from '../local/catalog.ts';
import type { LocalInferenceObserver } from '../local/local-diagnostics.ts';
import { retainLocalModel } from '../local/model.ts';
import { localDecisionProvider } from './local.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { IdentityExecutionContext } from '../hosting/identity-context.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { User } from '../../shared/domain.ts';
import {
  decisionProfileSchema,
  decisionQuestionsSchema,
  decisionPurposes,
  type DecisionProfile,
  type DecisionProfileView,
  type DecisionAnswer,
  type DecisionEvaluation,
} from '../../shared/decision-profile.ts';
import { HttpError, type Store } from '../store.ts';
import type {
  DecisionInvocation,
  DecisionProvider,
  DecisionSettings,
  ProviderDecision,
} from './contracts.ts';
import {
  DecisionProviderError,
  openaiDecisionProvider,
  jevDecisionProvider,
  structuredDecisionProvider,
} from './providers.ts';
const hash = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const stamp = () => new Date().toISOString();
const promptVersion = 'studio-decision-questions-v1';
class DecisionLeaseLostError extends Error {}
const terminal = (status: string) =>
  ['completed', 'error', 'cancelled'].includes(status);
export class DecisionModels {
  readonly ready: Promise<void>;
  private readonly providers = new Map<
    DecisionProfile['provider'],
    DecisionProvider
  >();
  private readonly owner = randomUUID();
  private readonly controllers = new Set<AbortController>();
  private readonly tasks = new Set<Promise<DecisionEvaluation>>();
  private closing = false;
  private releaseLocal?: () => Promise<void>;
  constructor(
    readonly options: {
      store: Store;
      settings: DecisionSettings;
      identityExecutionContext?: IdentityExecutionContext;
      onLocalInferenceEvent?: LocalInferenceObserver;
      notify?: (projectId: string, artifactId: string) => Promise<void>;
    },
  ) {
    const settings = options.settings;
    if (settings.local) {
      this.releaseLocal = retainLocalModel(settings.local.directory);
      this.providers.set(
        'llama-cpp-cpu',
        localDecisionProvider(settings.local, options.onLocalInferenceEvent),
      );
    }
    if (settings.openai)
      this.providers.set(
        'openai-decisions',
        openaiDecisionProvider(settings.openai),
      );
    if (settings.jev)
      this.providers.set('jev', jevDecisionProvider(settings.jev));
    if (settings.structured)
      this.providers.set(
        'vercel-structured',
        structuredDecisionProvider(
          settings.structured,
          options.identityExecutionContext,
        ),
      );
    this.ready = this.initialize();
    void this.ready.catch(() => {});
  }
  private get store() {
    return this.options.store;
  }
  async initialize() {
    if (this.ready) return this.ready;
    await this.store.tx(async () => {
      await this.store.db.lock('schema:studio.decision-models');
      await this.store.db.exec(`
   CREATE TABLE IF NOT EXISTS studio_decision_profiles(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,profile_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS studio_decision_calls(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),artifact_version INTEGER NOT NULL,purpose TEXT NOT NULL,input_hash TEXT NOT NULL,request_hash TEXT NOT NULL,idempotency_key TEXT UNIQUE NOT NULL,profile_json TEXT NOT NULL,request_json TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,fence BIGINT NOT NULL DEFAULT 0,lease_owner TEXT,lease_expires BIGINT,result_json TEXT,result_sha256 TEXT,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS studio_decision_admissions(call_id TEXT NOT NULL REFERENCES studio_decision_calls(id) ON DELETE CASCADE,fence BIGINT NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),admitted_at BIGINT NOT NULL,PRIMARY KEY(call_id,fence));
   CREATE INDEX IF NOT EXISTS studio_decision_admission_project ON studio_decision_admissions(project_id,admitted_at);
   CREATE INDEX IF NOT EXISTS studio_decision_admission_user ON studio_decision_admissions(user_id,admitted_at);
   CREATE INDEX IF NOT EXISTS studio_decision_active ON studio_decision_calls(status,lease_expires,user_id,project_id);
   CREATE INDEX IF NOT EXISTS studio_decision_cache ON studio_decision_calls(project_id,artifact_id,user_id,request_hash,status,created_at);
  `);
      if (this.store.db.dialect === 'sqlite') {
        const columns = await this.store.all(
          'PRAGMA table_info(studio_decision_calls)',
        );
        if (!columns.some((column) => column.name === 'result_sha256'))
          await this.store.exec(
            'ALTER TABLE studio_decision_calls ADD COLUMN result_sha256 TEXT',
          );
      } else {
        await this.store.exec(
          'ALTER TABLE studio_decision_calls ADD COLUMN IF NOT EXISTS result_sha256 TEXT',
        );
      }
      // Legacy receipts predate integrity metadata. Establish their upgrade baseline once.
      for (const row of await this.store.all(
        'SELECT id,result_json FROM studio_decision_calls WHERE result_json IS NOT NULL AND result_sha256 IS NULL',
      ))
        await this.store.exec(
          'UPDATE studio_decision_calls SET result_sha256=? WHERE id=?',
          hash(row.result_json),
          row.id,
        );
    });
  }
  private receipt(row: any): DecisionEvaluation | null {
    if (!row.result_json) return null;
    if (hash(row.result_json) !== row.result_sha256)
      throw new HttpError(
        409,
        'The stored decision receipt failed integrity verification',
      );
    const value = JSON.parse(row.result_json) as DecisionEvaluation;
    if (
      value.id !== row.id ||
      value.provenance?.requestHash !== row.request_hash ||
      value.provenance?.inputHash !== row.input_hash ||
      value.provenance?.artifactVersion !== Number(row.artifact_version)
    )
      throw new HttpError(
        409,
        'The stored decision receipt does not match its immutable request',
      );
    return value;
  }
  private budget() {
    return (
      this.options.settings.budget ?? {
        principalPerHour: 120,
        projectPerHour: 600,
        principalConcurrent: 4,
        projectConcurrent: 8,
      }
    );
  }
  private async admit(row: any): Promise<boolean> {
    // Project is already locked; this lock also serializes one principal across projects.
    await this.store.db.lock('decision-budget:' + row.user_id);
    const cutoff = Date.now() - 3600000,
      limits = this.budget();
    const count = async (sql: string, ...args: any[]) =>
      Number((await this.store.one(sql, ...args))?.n ?? 0);
    if (
      (await count(
        'SELECT COUNT(*) AS n FROM studio_decision_admissions WHERE user_id=? AND admitted_at>=?',
        row.user_id,
        cutoff,
      )) >= limits.principalPerHour ||
      (await count(
        'SELECT COUNT(*) AS n FROM studio_decision_admissions WHERE project_id=? AND admitted_at>=?',
        row.project_id,
        cutoff,
      )) >= limits.projectPerHour ||
      (await count(
        "SELECT COUNT(*) AS n FROM studio_decision_calls WHERE user_id=? AND status='running' AND lease_expires>?",
        row.user_id,
        Date.now(),
      )) >= limits.principalConcurrent ||
      (await count(
        "SELECT COUNT(*) AS n FROM studio_decision_calls WHERE project_id=? AND status='running' AND lease_expires>?",
        row.project_id,
        Date.now(),
      )) >= limits.projectConcurrent
    )
      return false;
    await this.store.exec(
      'INSERT INTO studio_decision_admissions(call_id,fence,project_id,user_id,admitted_at) VALUES(?,?,?,?,?)',
      row.id,
      Number(row.fence) + 1,
      row.project_id,
      row.user_id,
      Date.now(),
    );
    return true;
  }
  private registration(profile: Pick<DecisionProfile, 'provider' | 'model'>) {
    const settings = this.options.settings;
    const config =
      profile.provider === 'llama-cpp-cpu'
        ? undefined
        : profile.provider === 'openai-decisions'
          ? settings.openai
          : profile.provider === 'jev'
            ? settings.jev
            : settings.structured;
    return hash({
      ...(profile.provider === 'llama-cpp-cpu'
        ? {
            localRuntimeFingerprint: LOCAL_MODELS.some(
              (item) => item.id === profile.model,
            )
              ? localModelFingerprint(profile.model)
              : 'unregistered',
          }
        : {}),
      provider: profile.provider,
      modelCatalog: config?.models ?? [],
      baseUrl:
        config?.baseUrl ??
        (profile.provider === 'vercel-structured'
          ? 'https://ai-gateway.vercel.sh/v3/ai'
          : null),
      adapterVersion:
        this.providers.get(profile.provider)?.version ?? 'unconfigured',
      configurationVersion: settings.configRevision ?? 'v1',
      questionPolicyVersion: 'decision-policy-v1',
    });
  }
  private captured(profile: DecisionProfile): DecisionProfile {
    return {
      ...profile,
      configRevision: this.registration(profile),
      policyVersion: 'decision-policy-v1',
    };
  }
  catalog(): DecisionProfileView['providers'] {
    const settings = this.options.settings;
    return [
      {
        id: 'llama-cpp-cpu',
        label: 'Local CPU · native probabilities (uncalibrated)',
        maxInputBytes: 12000,
        maxQuestions: 64,
        contextTokens: 4096,
        probabilityKind: 'conditional-option-likelihood',
        calibrated: false,
        configured:
          !!settings.local &&
          LOCAL_MODELS.some((item) =>
            localModelPresent(settings.local, item.id),
          ),
        reason:
          settings.local &&
          LOCAL_MODELS.some((item) =>
            localModelPresent(settings.local, item.id),
          )
            ? null
            : 'The verified local model directory is not configured or its pinned weights are unavailable.',
        models: LOCAL_MODELS.map((item) => item.id),
        availableModels: LOCAL_MODELS.filter((item) =>
          localModelPresent(settings.local, item.id),
        ).map((item) => item.id),
        mode: 'native-decision',
      },
      {
        id: 'openai-decisions',
        maxInputBytes: 120000,
        maxQuestions: 64,
        label: 'OpenAI Decisions API',
        configured: !!settings.openai,
        reason: settings.openai
          ? null
          : 'The native OpenAI Decisions API credential is not configured.',
        models: settings.openai?.models ?? ['gpt-6-luna'],
        mode: 'native-decision',
      },
      {
        id: 'jev',
        maxInputBytes: 32000,
        maxQuestions: 64,
        label: 'Jev / TypeSafe',
        configured: !!settings.jev,
        reason: settings.jev
          ? null
          : 'The native Jev/TypeSafe credential is not configured.',
        models: settings.jev?.models ?? ['jev-latest'],
        mode: 'native-decision',
      },
      {
        id: 'vercel-structured',
        maxInputBytes: 120000,
        maxQuestions: 64,
        label: 'Vercel AI SDK structured generation',
        configured: !!settings.structured,
        reason: settings.structured
          ? null
          : 'No explicit structured decision model is registered. Chat configuration does not enable this provider.',
        models: settings.structured?.models ?? [],
        mode: 'structured-generation',
      },
    ];
  }
  capabilities(profile: DecisionProfile) {
    return {
      maxInputBytes:
        profile.provider === 'llama-cpp-cpu'
          ? 12000
          : profile.provider === 'jev'
            ? 32000
            : 120000,
      maxQuestions: 64,
      nativeProbabilities: profile.provider !== 'vercel-structured',
    };
  }
  async profile(
    user: User,
    id: string,
    update?: DecisionProfile,
  ): Promise<DecisionProfileView> {
    await this.ready;
    const artifact = await this.store.artifact(
        id,
        user.id,
        update ? 'write' : 'read',
      ),
      outer = this.store.db.inTransaction();
    if (update) {
      const value = decisionProfileSchema.parse(update),
        provider = this.catalog().find(
          (provider) => provider.id === value.provider,
        );
      if (!provider?.models.includes(value.model))
        throw new HttpError(
          400,
          'Choose a registered decision provider and model',
        );
      const captured = this.captured(value);
      await this.store.tx(async () => {
        await this.store.db.lock('project:' + artifact.projectId);
        await this.store.artifact(id, user.id, 'write');
        await this.store.exec(
          'INSERT INTO studio_decision_profiles(artifact_id,profile_json,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET profile_json=excluded.profile_json,revision=studio_decision_profiles.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
          id,
          JSON.stringify(captured),
          user.id,
          stamp(),
        );
        await this.store.audit(
          artifact.projectId,
          id,
          user.name,
          'decision.profile.updated',
          JSON.stringify(captured),
        );
      });
      if (!outer)
        await this.options.notify?.(artifact.projectId, id).catch(() => {});
    }
    return {
      profile: await this.captureProfile(user, id),
      independentOfChat: true,
      requiresExplicitFallback: true,
      providers: this.catalog(),
    };
  }
  async captureProfile(user: User, id: string): Promise<DecisionProfile> {
    await this.ready;
    await this.store.artifact(id, user.id);
    const row = await this.store.one(
      'SELECT profile_json FROM studio_decision_profiles WHERE artifact_id=?',
      id,
    );
    return this.captured(
      decisionProfileSchema.parse(
        row
          ? JSON.parse(row.profile_json)
          : this.options.settings.defaultProfile,
      ),
    );
  }
  async readEvaluation(
    user: User,
    id: string,
  ): Promise<DecisionEvaluation | null> {
    await this.ready;
    const row = await this.store.one(
      'SELECT * FROM studio_decision_calls WHERE id=?',
      id,
    );
    if (!row) throw new HttpError(404, 'Decision evaluation not found');
    await this.store.artifact(row.artifact_id, user.id);
    return this.receipt(row);
  }
  async history(user: User, id: string): Promise<DecisionEvaluation[]> {
    await this.ready;
    await this.store.artifact(id, user.id);
    const rows = await this.store.all(
      'SELECT * FROM studio_decision_calls WHERE artifact_id=? AND result_json IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 100',
      id,
    );
    return rows.map((row) => this.receipt(row)!);
  }
  private async locked<T>(id: string, operation: (row: any) => Promise<T>) {
    const scope = await this.store.one(
      'SELECT project_id FROM studio_decision_calls WHERE id=?',
      id,
    );
    if (!scope)
      throw new DecisionLeaseLostError(
        'The decision request no longer exists',
      );
    return this.store.tx(async () => {
      await this.store.db.lock('project:' + scope.project_id);
      await this.store.db.lock('decision-call:' + id);
      const row = await this.store.one(
        'SELECT * FROM studio_decision_calls WHERE id=?',
        id,
      );
      if (!row)
        throw new DecisionLeaseLostError(
          'The decision request no longer exists',
        );
      return operation(row);
    });
  }
  private assertLease(row: any, fence: number) {
    if (
      row.status !== 'running' ||
      row.lease_owner !== this.owner ||
      Number(row.fence) !== fence ||
      Number(row.lease_expires) <= Date.now()
    )
      throw new DecisionLeaseLostError(
        'The decision attempt lost its result lease',
      );
  }
  private normalize(
    id: string,
    input: DecisionInvocation,
    result: ProviderDecision | undefined,
    startedAt: string,
    error?: DecisionAnswer['error'],
  ): DecisionEvaluation {
    const answers: DecisionAnswer[] = input.questions.map(
      (question, index) => {
        const native = result?.answers[index];
        if (error)
          return {
            questionId: question.id,
            kind: question.kind,
            status: 'error',
            value: null,
            candidate: null,
            probability: null,
            confidence: null,
            probabilities: [],
            error,
          };
        if (
          !native ||
          native.questionId !== question.id ||
          native.kind !== question.kind
        )
          throw new DecisionProviderError('invalid-response', false);
        if (native.refused)
          return {
            questionId: question.id,
            kind: question.kind,
            status: 'refused',
            value: null,
            candidate: null,
            probability: null,
            confidence: null,
            probabilities: [],
            error: 'provider-refusal',
          };
        const certainty =
          native.probability !== undefined
            ? Math.max(native.probability, 1 - native.probability)
            : native.confidence;
        const abstained =
          native.abstained ||
          certainty === undefined ||
          (certainty !== undefined &&
            (certainty < input.profile.minimumConfidence ||
              (question.kind === 'boolean' && certainty === 0.5)));
        return {
          questionId: question.id,
          kind: question.kind,
          status: abstained ? 'abstained' : 'answered',
          value: abstained ? null : (native.value ?? null),
          candidate: native.value ?? null,
          probability: native.probability ?? null,
          confidence: native.confidence ?? null,
          probabilities: native.probabilities ?? [],
          ...(abstained
            ? {
                error: (native.abstained
                  ? 'provider-abstention'
                  : certainty === undefined
                    ? 'unscored-answer'
                    : 'low-confidence') as DecisionAnswer['error'],
              }
            : {}),
        };
      },
    );
    const statuses = new Set(answers.map((answer) => answer.status));
    const status: DecisionEvaluation['status'] =
      error === 'cancelled' || error === 'access-revoked'
        ? 'cancelled'
        : statuses.size > 1
          ? 'partial'
          : answers[0]!.status;
    const finishedAt = stamp(),
      provider = this.providers.get(input.profile.provider);
    return {
      id,
      status,
      answers,
      provenance: {
        provider: input.profile.provider,
        requestedModel: input.profile.model,
        model: result?.model ?? input.profile.model,
        adapterVersion: provider?.version ?? 'unconfigured',
        promptVersion: input.policyVersion ?? promptVersion,
        inputHash: hash(input.input),
        requestHash: this.requestHash(input),
        artifactVersion: input.artifactVersion,
        minimumConfidence: input.profile.minimumConfidence,
        configRevision:
          input.profile.configRevision ?? this.registration(input.profile),
        purpose: input.purpose,
        modelResolution:
          input.profile.provider === 'llama-cpp-cpu'
            ? 'pinned-local-weights'
            : 'provider-reported-unresolved',
        ...(result?.localInference
          ? { localInference: result.localInference }
          : {}),
        startedAt,
        finishedAt,
        latencyMs: Date.parse(finishedAt) - Date.parse(startedAt),
        providerRequestId: result?.providerRequestId ?? null,
        usage: result?.usage ?? {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
        },
        cachedFrom: null,
        mode:
          provider?.mode ??
          (input.profile.provider === 'vercel-structured'
            ? 'structured-generation'
            : 'native-decision'),
      },
    };
  }
  private requestHash(input: DecisionInvocation) {
    return hash({
      artifactId: input.artifactId,
      actor: input.user.id,
      artifactVersion: input.artifactVersion,
      profile: input.profile,
      purpose: input.purpose,
      policyVersion: input.policyVersion ?? promptVersion,
      input: input.input,
      questions: input.questions,
    });
  }
  async decide(input: DecisionInvocation): Promise<DecisionEvaluation> {
    await this.ready;
    if (this.closing)
      throw new HttpError(503, 'Decision models are shutting down');
    if (this.store.db.inTransaction())
      throw new Error(
        'Decision model network evaluation must run outside source SQL transactions',
      );
    const task = this.drive(input);
    this.tasks.add(task);
    try {
      return await task;
    } finally {
      this.tasks.delete(task);
    }
  }
  private async drive(
    value: DecisionInvocation,
  ): Promise<DecisionEvaluation> {
    const input: DecisionInvocation = {
      ...value,
      profile: decisionProfileSchema.parse(value.profile),
      questions: decisionQuestionsSchema.parse(value.questions),
    };
    z.enum(decisionPurposes).parse(input.purpose);
    z.number().int().positive().parse(input.artifactVersion);
    if (!input.idempotencyKey || input.idempotencyKey.length > 300)
      throw new HttpError(
        400,
        'A bounded stable decision idempotency key is required',
      );
    if (typeof input.input !== 'string' || !input.input.trim())
      throw new HttpError(
        400,
        'Decision evaluation needs immutable source input',
      );
    const limit = this.capabilities(input.profile).maxInputBytes;
    if (
      Buffer.byteLength(
        JSON.stringify({ input: input.input, questions: input.questions }),
      ) > limit
    )
      throw new HttpError(
        413,
        'The decision source and questions exceed this provider’s bounded text context; split the assessment explicitly',
      );
    if (
      input.profile.configRevision &&
      input.profile.configRevision !== this.registration(input.profile)
    )
      throw new HttpError(
        409,
        'The captured decision provider registration changed; review and resubmit this assessment',
      );
    input.profile = this.captured(input.profile);
    const registered = this.catalog().find(
      (provider) => provider.id === input.profile.provider,
    );
    if (!registered?.models.includes(input.profile.model))
      throw new HttpError(
        409,
        'The captured decision model is no longer registered',
      );
    if (!registered.configured)
      throw new HttpError(
        503,
        registered.reason ?? 'The selected decision provider is unavailable',
      );
    if (
      input.profile.provider === 'llama-cpp-cpu' &&
      !localModelPresent(this.options.settings.local, input.profile.model)
    )
      throw new HttpError(
        503,
        'The selected local decision weights are unavailable.',
      );
    const provider = this.providers.get(input.profile.provider)!;
    const artifact = await this.store.artifact(
        input.artifactId,
        input.user.id,
        'write',
      ),
      fingerprint = this.requestHash(input),
      key = hash([
        artifact.projectId,
        input.artifactId,
        input.user.id,
        input.idempotencyKey,
      ]);
    const row = await this.store.tx(async () => {
      await this.store.db.lock('project:' + artifact.projectId);
      await this.store.artifact(input.artifactId, input.user.id, 'write');
      const old = await this.store.one(
        'SELECT * FROM studio_decision_calls WHERE idempotency_key=?',
        key,
      );
      if (old) {
        if (old.request_hash !== fingerprint)
          throw new HttpError(
            409,
            'This decision idempotency key already evaluated different source, questions or model settings',
          );
        return old;
      }
      const cached = await this.store.one(
        "SELECT * FROM studio_decision_calls WHERE project_id=? AND artifact_id=? AND user_id=? AND request_hash=? AND status='completed' AND created_at>=? ORDER BY created_at DESC LIMIT 1",
        artifact.projectId,
        input.artifactId,
        input.user.id,
        fingerprint,
        new Date(Date.now() - 1800000).toISOString(),
      );
      const id = randomUUID(),
        at = stamp();
      let result: string | null = null;
      if (cached?.result_json) {
        const reuse = this.receipt(cached)!;
        result = JSON.stringify({
          ...reuse,
          id,
          provenance: {
            ...reuse.provenance,
            cachedFrom: reuse.id,
            startedAt: at,
            finishedAt: at,
            latencyMs: 0,
            usage: {
              inputTokens: null,
              outputTokens: null,
              totalTokens: null,
            },
          },
        });
      }
      await this.store.exec(
        'INSERT INTO studio_decision_calls(id,project_id,artifact_id,user_id,artifact_version,purpose,input_hash,request_hash,idempotency_key,profile_json,request_json,status,result_json,result_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        artifact.projectId,
        input.artifactId,
        input.user.id,
        input.artifactVersion,
        input.purpose,
        hash(input.input),
        fingerprint,
        key,
        JSON.stringify(input.profile),
        JSON.stringify({
          purpose: input.purpose,
          input: input.input,
          questions: input.questions,
          policyVersion: input.policyVersion ?? promptVersion,
        }),
        result ? 'completed' : 'queued',
        result,
        result ? hash(result) : null,
        at,
        at,
      );
      return await this.store.one(
        'SELECT * FROM studio_decision_calls WHERE id=?',
        id,
      );
    });
    if (row.result_json) return this.receipt(row)!;
    const overall = AbortSignal.any([
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(this.options.settings.timeoutMs),
    ]);
    while (true) {
      overall.throwIfAborted();
      // Repository entitlement renewal may call the provider. Do it before
      // entering the transaction; the locked check still fences revocation.
      await this.store.artifact(input.artifactId, input.user.id, 'write');
      if (this.closing)
        throw new HttpError(
          503,
          'Decision models are shutting down; the queued intent can be resumed',
        );
      overall.throwIfAborted();
      const claimed = await this.locked(row.id, async (current) => {
        await this.store.artifact(input.artifactId, input.user.id, 'write');
        if (terminal(current.status))
          return { result: this.receipt(current)! };
        if (
          current.status === 'running' &&
          Number(current.lease_expires) > Date.now()
        )
          return null;
        const exhausted = Number(current.attempts) >= 3;
        if (exhausted || !(await this.admit(current))) {
          const failed = this.normalize(
            current.id,
            input,
            undefined,
            current.created_at,
            exhausted ? 'provider-error' : 'budget-exhausted',
          );
          await this.store.exec(
            "UPDATE studio_decision_calls SET status='error',result_json=?,result_sha256=?,lease_owner=NULL,lease_expires=NULL,error_code=?,updated_at=? WHERE id=?",
            JSON.stringify(failed),
            hash(JSON.stringify(failed)),
            exhausted ? 'provider-error' : 'budget-exhausted',
            stamp(),
            current.id,
          );
          return { result: failed };
        }
        const lease = this.options.settings.leaseMs ?? 45000;
        await this.store.exec(
          "UPDATE studio_decision_calls SET status='running',attempts=attempts+1,fence=fence+1,lease_owner=?,lease_expires=?,updated_at=? WHERE id=?",
          this.owner,
          Date.now() + lease,
          stamp(),
          current.id,
        );
        return { fence: Number(current.fence) + 1 };
      });
      if (claimed && 'result' in claimed) return claimed.result!;
      if (!claimed) {
        await delay(25, undefined, { signal: overall });
        continue;
      }
      const controller = new AbortController();
      this.controllers.add(controller);
      if (this.closing)
        controller.abort(
          new Error('Decision model service is shutting down'),
        );
      const signal = AbortSignal.any([overall, controller.signal]);
      let heartbeat: Promise<void> | undefined, heartbeatError: unknown;
      const timer = setInterval(
        () => {
          if (heartbeat) return;
          heartbeat = this.store
            .artifact(input.artifactId, input.user.id, 'write')
            .then(() =>
              this.locked(row.id, async (current) => {
                this.assertLease(current, claimed.fence!);
                await this.store.artifact(
                  input.artifactId,
                  input.user.id,
                  'write',
                );
                await this.store.exec(
                  'UPDATE studio_decision_calls SET lease_expires=? WHERE id=? AND fence=?',
                  Date.now() + (this.options.settings.leaseMs ?? 45000),
                  row.id,
                  claimed.fence!,
                );
              }),
            )
            .catch((error) => {
              heartbeatError = error;
              controller.abort(error);
            })
            .finally(() => {
              heartbeat = undefined;
            });
        },
        Math.max(
          25,
          Math.floor((this.options.settings.leaseMs ?? 45000) / 3),
        ),
      );
      timer.unref();
      let response: ProviderDecision | undefined,
        error: unknown,
        started = stamp();
      try {
        response = await provider.evaluate({
          profile: input.profile,
          input: input.input,
          questions: input.questions,
          idempotencyKey: key,
          signal,
        });
        signal.throwIfAborted();
      } catch (caught) {
        error = caught;
      }
      clearInterval(timer);
      await heartbeat;
      this.controllers.delete(controller);
      const retry =
        error instanceof DecisionProviderError &&
        error.retryable &&
        !signal.aborted;
      const errorCode: DecisionAnswer['error'] | undefined = error
        ? signal.aborted
          ? 'cancelled'
          : error instanceof DecisionProviderError &&
              error.code === 'context-overflow'
            ? 'context-overflow'
            : error instanceof z.ZodError ||
                (error instanceof DecisionProviderError &&
                  error.code === 'invalid-response')
              ? 'invalid-response'
              : 'provider-error'
        : undefined;
      const evaluation = this.normalize(
        row.id,
        input,
        response,
        started,
        errorCode,
      );
      let preflightError: unknown = heartbeatError;
      try {
        await this.store.artifact(input.artifactId, input.user.id, 'write');
      } catch (denied) {
        preflightError = denied;
      }
      const published = await this.locked(row.id, async (current) => {
        this.assertLease(current, claimed.fence!);
        try {
          if (preflightError) throw preflightError;
          await this.store.artifact(input.artifactId, input.user.id, 'write');
        } catch (denied) {
          if (
            !(denied instanceof HttpError) ||
            ![401, 403, 404].includes(denied.statusCode)
          ) {
            // A temporary entitlement provider failure cannot establish either
            // authorization or revocation. Discard the answer and resume later.
            await this.store.exec(
              "UPDATE studio_decision_calls SET status='queued',lease_owner=NULL,lease_expires=NULL,error_code='authorization-unavailable',updated_at=? WHERE id=? AND fence=?",
              stamp(),
              row.id,
              claimed.fence!,
            );
            return { denied };
          }
          const cancelled = this.normalize(
            row.id,
            input,
            undefined,
            started,
            'access-revoked',
          );
          await this.store.exec(
            "UPDATE studio_decision_calls SET status='cancelled',result_json=?,result_sha256=?,lease_owner=NULL,lease_expires=NULL,error_code='access-revoked',updated_at=? WHERE id=? AND fence=?",
            JSON.stringify(cancelled),
            hash(JSON.stringify(cancelled)),
            stamp(),
            row.id,
            claimed.fence!,
          );
          return { denied };
        }
        if (this.closing && controller.signal.aborted) {
          // Instance shutdown is not an explicit request cancellation. Another
          // executor may resume this immutable intent after our lease releases.
          await this.store.exec(
            "UPDATE studio_decision_calls SET status='queued',lease_owner=NULL,lease_expires=NULL,error_code='worker-shutdown',updated_at=? WHERE id=? AND fence=?",
            stamp(),
            row.id,
            claimed.fence!,
          );
          return { shutdown: true };
        }
        if (retry && Number(current.attempts) < 3) {
          await this.store.exec(
            "UPDATE studio_decision_calls SET status='queued',lease_owner=NULL,lease_expires=NULL,error_code='provider-error',updated_at=? WHERE id=? AND fence=?",
            stamp(),
            row.id,
            claimed.fence!,
          );
          return false;
        }
        await this.store.exec(
          'UPDATE studio_decision_calls SET status=?,result_json=?,result_sha256=?,lease_owner=NULL,lease_expires=NULL,error_code=?,updated_at=? WHERE id=? AND fence=?',
          evaluation.status === 'error'
            ? 'error'
            : evaluation.status === 'cancelled'
              ? 'cancelled'
              : 'completed',
          JSON.stringify(evaluation),
          hash(JSON.stringify(evaluation)),
          errorCode ?? null,
          stamp(),
          row.id,
          claimed.fence!,
        );
        return true;
      });
      if (published && typeof published === 'object') {
        if ('denied' in published) throw published.denied;
        throw new HttpError(
          503,
          'The decision worker shut down before publication; the immutable request can be resumed',
        );
      }
      if (published) {
        await this.options
          .notify?.(artifact.projectId, input.artifactId)
          .catch(() => {});
        return evaluation;
      }
      await delay(200, undefined, { signal: overall });
    }
  }
  async close() {
    this.closing = true;
    for (const controller of this.controllers)
      controller.abort(new Error('Decision model service is shutting down'));
    await Promise.allSettled([...this.tasks]);
    await this.ready.catch(() => {});
    const release = this.releaseLocal;
    this.releaseLocal = undefined;
    await release?.();
  }
}
