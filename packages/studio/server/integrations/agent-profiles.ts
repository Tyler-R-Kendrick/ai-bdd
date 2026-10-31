import type { FastifyInstance } from 'fastify';
import type { User } from '../../shared/domain.ts';
import {
  agentProfileSchema,
  type AgentProfile,
  type AgentProfileView,
} from '../../shared/agent-profile.ts';
import type { Auth, Settings } from '../auth.ts';
import { HttpError, type Store } from '../store.ts';
import type { IntegrationSettings } from './settings.ts';
import { LOCAL_MODEL_ID, LOCAL_MODELS, LOCAL_PROVIDER_ID, localModelById, localModelPresent } from '../local/catalog.ts';
import { managedT3ToolsPresent } from '../local/native-t3-runtime.ts';
import { freeGatewayModels } from '@ai-bdd/models-ai-sdk';
const fallback: AgentProfile = {
  harness: 't3-code',
  provider: 'project-default',
  model: 'project-default',
};
export class AgentProfiles {
  private gatewayModels: string[] = [];
  constructor(
    readonly store: Store,
    readonly settings: Settings,
    readonly integrations: IntegrationSettings,
  ) {}
  async initialize() {
    await this.store.tx(async () => {
      await this.store.db.lock('schema:studio.agent-profile');
      await this.store.db.exec(
        'CREATE TABLE IF NOT EXISTS studio_agent_profiles(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,harness TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL)',
      );
    });
    await this.refreshGatewayModels();
  }
  private async refreshGatewayModels() {
    if (!this.settings.model) { this.gatewayModels = []; return; }
    try {
      this.gatewayModels = await freeGatewayModels('language', {
        ...(this.integrations.gatewayMetadataFetch ? { metadataFetch: this.integrations.gatewayMetadataFetch } : {}),
      });
      const registered = [this.settings.model, ...(this.integrations.fxModels ?? [])];
      this.gatewayModels = this.gatewayModels.filter(id => registered.includes(id));
    } catch { this.gatewayModels = []; }
  }
  async selected(id: string): Promise<AgentProfile> {
    const row = await this.store.one(
      'SELECT harness,provider,model FROM studio_agent_profiles WHERE artifact_id=?',
      id,
    );
    if (row) return agentProfileSchema.parse(row);
    const provider = this.integrations.t3?.providers[0];
    const managed = this.managedAvailable();
    return provider && (!managed || !!this.integrations.t3?.mcp?.accessToken)
      ? {
          harness: 't3-code',
          provider: provider.id,
          model: provider.models[0]!,
        }
      : managed
        ? { harness: 't3-code', provider: 'studioLocal', model: 'studio-local/' + (this.integrations.localModel?.modelId ?? LOCAL_MODEL_ID) }
        : { ...fallback };
  }
  catalog(): AgentProfileView['harnesses'] {
    const t3 = this.integrations.t3;
    const managed = this.managedAvailable();
    const external = !!t3?.mcp?.accessToken && !!t3.providers.length;
    const configured = external || managed;
    const harnesses: AgentProfileView['harnesses'] = [
      {
        id: 't3-code',
        label: 'T3 Code',
        configured,
        reason:
          configured
            ? null
            : 'T3 Code requires a registered native MCP endpoint, an approved Supervised client and a concrete provider/model. CLI-only generation is disabled. Choose another harness explicitly or connect the operator-owned T3 environment.',
        providers: [
          ...(t3?.providers.length || managed
            ? []
            : [
                {
                  id: 'project-default',
                  label: 'T3 project default',
                  models: ['project-default'],
                },
              ]),
          ...(external || !managed ? t3?.providers ?? [] : []),
          ...(managed ? [{ id: 'studioLocal', label: 'Managed local CPU through native T3 / OpenCode', models: this.localModels().map(id => 'studio-local/' + id), modelCapabilities: this.localCapabilities('studio-local/') }] : []),
        ],
      },
      {
        id: 'local-cpu',
        label: 'Local CPU (offline)',
        configured: localModelPresent(this.integrations.localModel),
        reason: localModelPresent(this.integrations.localModel) ? null : 'The operator must prepare the pinned local model and configure STUDIO_LOCAL_MODEL_DIR. Inference never downloads files or falls back to a hosted provider.',
        providers: [{ id: LOCAL_PROVIDER_ID, label: 'llama.cpp CPU (Apache-2.0)', models: this.localModels(), modelCapabilities: this.localCapabilities() }],
      },
      {
        id: 'vercel-fx',
        label: 'Vercel / fx',
        configured: !!this.settings.model && this.gatewayModels.includes(this.settings.model),
        reason: this.settings.model && this.gatewayModels.includes(this.settings.model)
          ? null
          : 'Optional Gateway inference requires a currently verified free model and account access. No paid model or fallback is permitted.',
        providers: [
          {
            id: 'ai-gateway',
            label: 'Vercel AI Gateway',
            models: [...this.gatewayModels],
          },
        ],
      },
    ];
    if (this.integrations.remotePlanner)
      harnesses.push({
        id: 'remote-planner',
        label: 'Attached remote Planner',
        configured: true,
        reason:
          'An eligible authenticated Planner must be attached before executing a turn.',
        providers: [
          {
            id: 'operator-acp',
            label: 'Operator-selected remote agent',
            models: ['remote'],
          },
        ],
      });
    return harnesses;
  }
  private managedAvailable() {
    const config = this.integrations.managedT3;
    return !!config && localModelPresent(this.integrations.localModel) && managedT3ToolsPresent(config.toolsDirectory);
  }
  private localModels() {
    const available = LOCAL_MODELS.filter(model => localModelPresent(this.integrations.localModel, model.id)).map(model => model.id);
    return available.length ? available : [LOCAL_MODEL_ID];
  }
  private localCapabilities(prefix = '') {
    return Object.fromEntries(this.localModels().map(id => [prefix + id, {
      artifactEdits: localModelById(id)?.nativeArtifactEdits === true,
    }]));
  }
  assertArtifactEdits(profile: AgentProfile) {
    const modelId = profile.harness === 'local-cpu'
      ? profile.model
      : profile.harness === 't3-code' && profile.provider === 'studioLocal' && this.integrations.managedT3
        ? profile.model.startsWith('studio-local/') ? profile.model.slice('studio-local/'.length) : ''
        : null;
    if (modelId !== null && localModelById(modelId)?.nativeArtifactEdits !== true)
      throw new HttpError(409, 'The selected model does not support artifact edit proposals. Choose and save a model that supports artifact edits.');
  }
  assertAvailable(profile: AgentProfile) {
    const harness = this.catalog().find(
      (value) => value.id === profile.harness,
    );
    if (!harness)
      throw new HttpError(
        503,
        'The selected agent harness is not enabled in this workspace',
      );
    if (
      !harness.providers.some(
        (provider) =>
          provider.id === profile.provider &&
          provider.models.includes(profile.model),
      )
    )
      throw new HttpError(
        409,
        'The selected provider or model is no longer registered for this harness',
      );
    if (!harness.configured)
      throw new HttpError(
        503,
        harness.reason ?? 'The selected agent harness is not configured',
      );
  }
  async view(
    user: User,
    id: string,
    update?: AgentProfile,
  ): Promise<AgentProfileView> {
    await this.refreshGatewayModels();
    const artifact = await this.store.artifact(
      id,
      user.id,
      update ? 'write' : 'read',
    );
    if (update) {
      const value = agentProfileSchema.parse(update);
      const harness = this.catalog().find((h) => h.id === value.harness);
      if (
        !harness?.providers.some(
          (p) => p.id === value.provider && p.models.includes(value.model),
        )
      )
        throw new HttpError(
          400,
          'Choose a registered harness, provider and model',
        );
      await this.store.tx(async () => {
        await this.store.db.lock('project:' + artifact.projectId);
        await this.store.artifact(id, user.id, 'write');
        await this.store.exec(
          'INSERT INTO studio_agent_profiles VALUES(?,?,?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET harness=excluded.harness,provider=excluded.provider,model=excluded.model,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
          id,
          value.harness,
          value.provider,
          value.model,
          user.id,
          new Date().toISOString(),
        );
        await this.store.audit(
          artifact.projectId,
          id,
          user.name,
          'agent.profile.updated',
          JSON.stringify(value),
        );
      });
    }
    return {
      profile: await this.selected(id),
      defaultHarness: 't3-code',
      requiresExplicitFallback: true,
      harnesses: this.catalog(),
    };
  }
}
export function registerAgentProfileRoutes(
  app: FastifyInstance,
  dependencies: {
    profiles: AgentProfiles;
    auth: Auth;
    notify?: (projectId: string, id: string) => Promise<void>;
  },
) {
  app.get<{ Params: { id: string } }>(
    '/api/artifacts/:id/agent/profile',
    async (req) =>
      dependencies.profiles.view(
        await dependencies.auth.user(req),
        req.params.id,
      ),
  );
  app.put<{ Params: { id: string } }>(
    '/api/artifacts/:id/agent/profile',
    async (req) => {
      const user = await dependencies.auth.user(req),
        view = await dependencies.profiles.view(
          user,
          req.params.id,
          agentProfileSchema.parse(req.body),
        );
      const artifact = await dependencies.profiles.store.artifact(
        req.params.id,
        user.id,
      );
      await dependencies.notify?.(artifact.projectId, artifact.id);
      return view;
    },
  );
}
