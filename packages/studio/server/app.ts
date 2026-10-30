import { investigationExportRows } from './integrations/investigation-export.ts';
import { registerAgentProfileRoutes } from './integrations/agent-profiles.ts';
import { registerImplementationMachineRoutes } from './integrations/implementation-machines.ts';
import { SpeculativeSpikes, createSpikeJudge } from './integrations/spikes.ts';
import {
  ImplementationDrafting,
  registerImplementationDraftRoutes,
} from './integrations/implementation-drafting.ts';
import {
  registerInvestigationRoutes,
  type InvestigationService,
} from './integrations/investigations.ts';
import { validateInvestigationReferences } from './integrations/investigation-references.ts';
import { RemotePlanner } from './integrations/remote-planner.ts';
import { ImplementationGraphs } from './integrations/implementation.ts';
import { registerImplementationRoutes } from './integrations/implementation-routes.ts';
import {
  documentImplementationReady,
  documentImplementationReadiness,
} from './document-readiness.ts';
import { ArtifactTitles } from './integrations/titles.ts';
import {
  registerConversationRoutes,
  conversationExportTables,
  conversationExportPage,
} from './integrations/conversation.ts';
import {
  registerIntegrationRoutes,
  integrationExportRows,
} from './integrations/routes.ts';
import {
  compileCodePreview,
  codePreviewDependencies,
  CodeBuildError,
} from './code-bundler.ts';
import {
  registerDocumentReview,
  documentReviewExportPage,
  documentReviewExportTables,
} from './document-review.ts';
import { registerVideoRoutes } from './video.ts';
import { uploadedMediaType } from './media-files.ts';
import Fastify, { type FastifyRequest } from 'fastify';
import type { SqlDatabase } from './persistence/types.ts';
import type { DurableJobRuntime } from './runtime/contracts.ts';
import { createDurableJobRuntime } from './runtime/jobs.ts';
import type { HostingServices } from './hosting/ports.ts';
import { DiskObjectStore } from './hosting/disk-objects.ts';
import { ObjectWorkspaceStore } from './hosting/workspaces.ts';
import { LocalJobDispatcher } from './hosting/local-queue.ts';
import { registerHostingRoutes } from './hosting/routes.ts';
import { registerRepositoryIdentity } from './identity/github.ts';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { z, ZodError } from 'zod';
import { Store, HttpError, hash } from './store.ts';
import { Auth, passwordHash, type Settings } from './auth.ts';
import { Collaboration } from './collaboration.ts';
import { Runner } from './runner.ts';
import { Agent } from './agent.ts';
import { kindSchema, roleSchema } from '../shared/domain.ts';
const title = z.string().trim().min(1).max(180),
  id = z.string().uuid();
const parse = <T>(s: z.ZodType<T>, v: unknown) => s.parse(v);
const stamp = () => new Date().toISOString();
const repo = z
  .string()
  .max(300)
  .refine(
    (s) => s === '' || /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(s),
    'Use a github.com repository URL',
  );
export async function createApp(
  settings: Settings,
  options: {
    db?: string;
    database?: SqlDatabase;
    store?: Store;
    runtime?: DurableJobRuntime;
    hosting?: HostingServices;
    logger?: boolean;
    clientDir?: string;
  } = {},
) {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            'req.url',
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers.set-cookie',
          ],
        }
      : false,
    bodyLimit: 2100000,
    requestTimeout: 150000,
    connectionTimeout: 15000,
    trustProxy: settings.trustedProxies ?? false,
  });
  const store =
    options.store ??
    (await Store.open(
      options.database ??
        options.db ??
        resolve(settings.dataDir, 'studio.sqlite'),
    ));
  const startupCleanup: (() => Promise<unknown>)[] = [() => store.close()];
  try {
    const localDispatcher =
      !options.runtime && !options.hosting
        ? new LocalJobDispatcher()
        : undefined;
    if (localDispatcher) startupCleanup.unshift(() => localDispatcher.close());
    const objects =
      options.hosting?.objects ??
      new DiskObjectStore(resolve(settings.dataDir, 'objects'));
    const hosting = options.hosting ?? {
      objects,
      workspaces: new ObjectWorkspaceStore(objects),
      jobs: localDispatcher!,
    };
    const runtime =
      options.runtime ??
      (await createDurableJobRuntime({ store, dispatcher: hosting.jobs }));
    if ('options' in runtime && (runtime as any).options.store !== store)
      throw new Error(
        'The application and durable runtime must share one Store',
      );
    startupCleanup.unshift(() => runtime.close());
    localDispatcher?.bind(runtime.executeJob);
    const auth = new Auth(store, settings);
    await auth.initialize();
    const collab = new Collaboration(store, auth);
    startupCleanup.unshift(() => collab.close());
    await collab.initialize();
    let investigations: InvestigationService | undefined;
    const graphs = new ImplementationGraphs({
      store,
      notify: ({ projectId, artifactId }) =>
        collab.notify(projectId, artifactId),
      assertReady: async (artifact) => {
        await documentImplementationReady(store, artifact);
        await investigations?.assertReady(artifact.id);
      },
    });
    await graphs.initialize();
    store.artifactWriteGuard = (artifact) =>
      graphs.assertPlanEditable(artifact.id);
    const runner = new Runner(store, settings, collab, { runtime, hosting }),
      agent = new Agent(store, settings, collab, {
        runtime,
        implementationLocked: async (id) => !!(await graphs.editingLock(id)),
      });
    await agent.initialize();
    const remotePlanner = settings.integrations?.remotePlanner
      ? new RemotePlanner({
          store,
          settings,
          authenticate: (req) => auth.user(req),
          claim: (user, id) => agent.claimPlanner(user, id),
          allowed: (user, id) => agent.canParticipate(user, id),
        })
      : undefined;
    if (remotePlanner) {
      startupCleanup.unshift(() => remotePlanner.close());
      await remotePlanner.initialize();
      agent.options.remote = remotePlanner;
    }
    await runner.initialize();
    const titles = new ArtifactTitles({
      store,
      runtime,
      provider: agent.profiles.catalog().some((harness) => harness.configured)
        ? (input) => agent.generateTitle(input)
        : undefined,
      captureProfile: (user, id) => agent.captureProfile(user, id),
      allowed: (user, id) => agent.canParticipate(user, id),
      notify: (projectId, id) => collab.publishDocumentMetadata(projectId, id),
      onAdmit: (user, id) => agent.claimBackgroundOwnership(user, id),
    });
    await titles.initialize();
    agent.options.onGeneratedArtifact = (id) => titles.markGenerated(id);
    agent.options.observeMessage = (user, id, thread) =>
      titles.observeMessage(user, id, thread);
    await app.register(cookie);
    await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          mediaSrc: ["'self'", 'blob:'],
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'"],
          connectSrc: [
            "'self'",
            ...(hosting.objects.provider === 'vercel-blob'
              ? ['https://vercel.com/api/blob/']
              : []),
          ],
          workerSrc: ["'self'", 'blob:'],
          frameSrc: ['blob:', "'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    });
    await app.register(rateLimit, {
      max: 240,
      timeWindow: '1 minute',
      allowList: (req) => !req.url.startsWith('/api/'),
      keyGenerator: async (req) => {
        try {
          return 'user:' + (await auth.user(req)).id;
        } catch {
          return req.ip;
        }
      },
    });
    await app.register(websocket, {
      options: { maxPayload: 1024 * 1024, perMessageDeflate: false },
    });
    await app.register(multipart, {
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1 },
    });
    app.setErrorHandler((error, req, reply) => {
      if (error instanceof ZodError)
        return reply.code(400).send({
          error: 'Invalid request',
          issues: error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
      const status = (error as any).statusCode ?? 500;
      if (status >= 500) req.log.error({ err: error }, 'Request failed');
      return reply.code(status).send({
        ...(status === 409 && Array.isArray((error as any).blockers)
          ? { blockers: (error as any).blockers.slice(0, 200) }
          : {}),
        error:
          status < 500 || (error instanceof HttpError && status === 503)
            ? (error as Error).message
            : 'The server could not complete this request',
      });
    });
    app.addHook('onRequest', async (req) => {
      if (
        req.url.startsWith('/api/') &&
        !req.url.startsWith('/api/auth/') &&
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      )
        auth.assertOrigin(req);
    });
    app.addHook('onSend', async (req, reply, payload) => {
      if (/^\/assets\/kernel\.worker-[A-Za-z0-9_-]+\.js$/.test(req.url))
        reply.header(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'",
        );
      reply.header('Cache-Control', 'no-store');
      return payload;
    });
    await auth.routes(app);
    registerAgentProfileRoutes(app, {
      auth,
      profiles: agent.profiles,
      notify: (projectId, id) => collab.notify(projectId, id),
    });
    remotePlanner?.register(app);
    const identity = await registerRepositoryIdentity(app, {
      store,
      auth,
      settings,
    });
    if (settings.repositoryIdentity) {
      agent.options.repositoryRead = (user, repository, input, signal) =>
        identity.readRepository(user, repository, input, signal);
      if (remotePlanner)
        remotePlanner.options.repositoryRead = (
          user,
          repository,
          input,
          signal,
        ) => identity.readRepository(user, repository, input, signal);
    }
    if (settings.repositoryIdentity)
      store.repositoryAuthorizer = async (
        projectId,
        userId,
        action,
        atomic,
      ) => {
        const project = await store.one(
          'SELECT repository FROM projects WHERE id=?',
          projectId,
        );
        if (!project?.repository) return;
        const permission = action === 'read' ? 'read' : 'write';
        if (atomic) {
          await store.lock('repository-identity:' + userId);
          if (
            !(await identity.checkLease(userId, project.repository, permission))
          )
            throw new HttpError(
              403,
              'Repository permission changed. Reconnect or refresh access.',
            );
        } else
          await identity.assertRepository(
            await store.publicUser(userId),
            project.repository,
            permission,
          );
      };
    await registerHostingRoutes(app, {
      uploads: hosting.uploads,
      user: (req) => auth.user(req),
      assertOrigin: (req) => auth.assertOrigin(req),
    });
    await registerDocumentReview(app, { store, auth, collab });
    await registerImplementationRoutes(app, { auth, graphs });
    app.get<{ Params: { id: string } }>(
      '/api/artifacts/:id/implementation/readiness',
      async (req) => {
        const user = await auth.user(req),
          artifact = await store.artifact(req.params.id, user.id);
        return store.tx(async () => {
          await store.lock('project:' + artifact.projectId);
          const current = await store.artifact(artifact.id, user.id);
          const readiness = await documentImplementationReadiness(
              store,
              current,
            ),
            required = await investigations!.required(current.id);
          return {
            ready: readiness.ready && required.length === 0,
            blockers: [
              ...readiness.blockers,
              ...required.map((row) => ({
                kind: 'investigation',
                id: row.id,
                message:
                  'Incorporate required investigation findings: ' + row.brief,
                reason: row.reason,
                status: row.status,
              })),
            ],
          };
        });
      },
    );
    const conversation = await registerConversationRoutes(app, {
      store,
      auth,
      collab,
      runtime,
      settings,
      enabled: process.env.STUDIO_CONVERSATION_CARDS === '1',
      startResearch: (input) => agent.startResearch(input),
    });
    const video = await registerVideoRoutes(app, {
      store,
      auth,
      settings,
      runtime,
      objects: hosting.objects,
    });
    const integrations = await registerIntegrationRoutes(app, {
      store,
      auth,
      collab,
      agent,
      settings,
    });
    const spikeJudge = createSpikeJudge(settings),
      spikesEnabled = process.env.STUDIO_SPECULATIVE_SPIKES === '1';
    investigations = await registerInvestigationRoutes(app, {
      store,
      auth,
      machines: integrations.machines,
      objects: hosting.objects,
      spikes: { enabled: spikesEnabled, judge: spikeJudge },
      implementationLocked: async (id) => !!(await graphs.editingLock(id)),
      notify: (projectId, id) => {
        void collab.notify(projectId, id).catch(() => {});
      },
    });
    integrations.machines.hooks.otherWorkActive = (id) =>
      investigations!.activeOnMachine(id);
    store.contentReferenceValidator = (input) =>
      validateInvestigationReferences(store, input);
    const implementationMachines = await registerImplementationMachineRoutes(
      app,
      {
        store,
        auth,
        machines: integrations.machines,
        graphs,
        otherWorkActive: (id) => investigations!.activeOnMachine(id),
        notify: (projectId, id) => {
          void collab.notify(projectId, id).catch(() => {});
        },
      },
    );
    graphs.options.externalEditingLock = (id) =>
      implementationMachines.editingLock(id);
    investigations.dependencies.otherWorkActive = (id) =>
      implementationMachines.activeOnMachine(id);
    integrations.machines.hooks.otherWorkActive = async (id) =>
      (await investigations!.activeOnMachine(id)) ||
      (await implementationMachines.activeOnMachine(id));
    const spikes = new SpeculativeSpikes({
      store,
      runtime,
      investigations,
      enabled: spikesEnabled,
      judge: spikeJudge,
    });
    await spikes.initialize();
    store.sourceObserver = async (user, previous, current) => {
      if (current.kind === 'design' || current.kind === 'document') {
        await collab.publishDocumentMetadata(current.projectId, current.id);
        store.db.afterCommit(async () => {
          void collab.refreshArtifact(current.id, user.id).catch(() => {});
        });
      }
      await spikes.observe(user, previous, current);
    };
    const drafting = new ImplementationDrafting({
      store,
      runtime,
      graphs,
      provider: agent.profiles.catalog().some((harness) => harness.configured)
        ? (input) => agent.generateImplementationGraph(input)
        : undefined,
      captureProfile: (user, id) => agent.captureProfile(user, id),
      allowed: (user, id) => agent.canParticipate(user, id),
      onAdmit: (user, id) => agent.claimBackgroundOwnership(user, id),
      assertReady: async (artifact) => {
        await documentImplementationReady(store, artifact);
        await investigations!.assertReady(artifact.id);
      },
      publish: (projectId, id) => collab.publishDocumentMetadata(projectId, id),
    });
    await drafting.initialize();
    registerImplementationDraftRoutes(app, auth, drafting);
    // Project mutations and membership changes share this lock. Authorization is read again after waiting.
    const projectWrite = async <T>(
      request: FastifyRequest,
      projectId: string,
      action: 'write' | 'admin',
      operation: () => Promise<T>,
    ) =>
      store.tx(async () => {
        await store.lock('project:' + projectId);
        const principal = await auth.user(request);
        await store.lock('user:' + principal.id);
        await auth.user(request);
        await store.role(projectId, principal.id, action);
        return operation();
      });
    await runtime.recover();
    await runtime.flushOutbox();
    app.get('/api/health', async () => {
      await store.one('SELECT 1');
      return { ok: true };
    });
    app.get('/api/capabilities', async (req) => {
      await auth.user(req);
      return {
        agent: agent.profiles.catalog().some((harness) => harness.configured),
        remotePlanner: !!remotePlanner,
        runner: !!settings.runnerConfig,
        oidc: !!settings.oidcIssuer,
        github: true,
        githubAuthenticated:
          !!settings.githubToken && !!settings.githubRepositories?.length,
        openDesign: !!settings.integrations?.openDesign,
        research: true,
        machines: true,
        magnetar: false,
      };
    });
    const previews = new Map<
      string,
      {
        userId: string;
        artifactId: string;
        html: string;
        expires: number;
      }
    >();
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/previews', async (req, reply) => {
      const user = await auth.user(req),
        artifact = await store.artifact(req.params.id, user.id);
      if (artifact.kind !== 'code')
        throw new HttpError(400, 'Code previews require a code artifact');
      const source = parse(
        z.union([
          z.object({ html: z.string().max(2000000) }).strict(),
          z
            .object({
              files: z.record(z.string().max(200), z.string().max(500000)),
              entry: z.string().max(200),
              channel: z.string().uuid(),
            })
            .strict(),
        ]),
        req.body,
      );
      let html: string,
        build: Record<string, unknown> = {};
      if ('html' in source) html = source.html;
      else {
        try {
          const compiled = await compileCodePreview(source);
          html = compiled.html;
          build = {
            diagnostics: compiled.diagnostics,
            dependencies: compiled.dependencies,
            modules: compiled.modules,
            availableDependencies: codePreviewDependencies(),
          };
        } catch (error) {
          if (error instanceof CodeBuildError)
            return reply
              .code(400)
              .send({ error: error.message, diagnostics: error.diagnostics });
          throw error;
        }
        await store.artifact(artifact.id, user.id);
      }
      for (const [key, value] of previews)
        if (value.expires < Date.now()) previews.delete(key);
      // Replacing a user's old draft bounds memory independently of typing frequency.
      for (const [key, value] of previews)
        if (value.userId === user.id && value.artifactId === artifact.id)
          previews.delete(key);
      if (previews.size >= 40)
        throw new HttpError(429, 'Too many live previews. Try again shortly.');
      const token = randomBytes(24).toString('base64url');
      previews.set(token, {
        userId: user.id,
        artifactId: artifact.id,
        html,
        expires: Date.now() + 120000,
      });
      return reply.code(201).send({ url: '/api/previews/' + token, ...build });
    });
    app.get<{
      Params: {
        token: string;
      };
    }>('/api/previews/:token', async (req, reply) => {
      const user = await auth.user(req),
        preview = previews.get(req.params.token);
      if (
        !preview ||
        preview.expires < Date.now() ||
        preview.userId !== user.id
      )
        throw new HttpError(
          404,
          'Preview expired. Refresh the preview to continue.',
        );
      await store.artifact(preview.artifactId, user.id);
      return reply
        .type('text/html; charset=utf-8')
        .header(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts",
        )
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .send(preview.html);
    });
    app.get('/api/projects', async (req) => {
      const user = await auth.user(req);
      return settings.repositoryIdentity
        ? identity.filteredProjects(user)
        : store.projects(user.id);
    });
    app.post('/api/projects', async (req, reply) => {
      const b = parse(
        z
          .object({
            title,
            description: z.string().max(4000).default(''),
            repository: repo.default(''),
          })
          .strict(),
        req.body,
      );
      const user = await auth.user(req);
      if (b.repository && settings.repositoryIdentity)
        await identity.assertRepository(user, b.repository, 'write');
      const project = await store.createProject(
        user,
        b.title,
        b.description,
        b.repository,
      );
      return reply.code(201).send(project);
    });
    app.patch<{
      Params: {
        id: string;
      };
    }>('/api/projects/:id', async (req) => {
      const user = await auth.user(req);
      await store.role(req.params.id, user.id, 'admin');
      const b = parse(
        z
          .object({
            title,
            description: z.string().max(4000),
            repository: repo,
          })
          .strict(),
        req.body,
      );
      if (b.repository && settings.repositoryIdentity)
        await identity.assertRepository(user, b.repository, 'write');
      await projectWrite(req, req.params.id, 'admin', async () => {
        const currentProject = await store.one(
          'SELECT repository FROM projects WHERE id=?',
          req.params.id,
        );
        if (
          currentProject.repository !== b.repository &&
          store.artifactWriteGuard
        )
          for (const artifact of await store.artifacts(req.params.id, user.id))
            await store.artifactWriteGuard(artifact, user.id);
        if (b.repository && settings.repositoryIdentity) {
          await store.lock('repository-identity:' + user.id);
          if (!(await identity.checkLease(user.id, b.repository, 'write')))
            throw new HttpError(403, 'Repository permission changed');
        }
        await store.exec(
          'UPDATE projects SET title=?,description=?,repository=?,updated_at=? WHERE id=?',
          b.title,
          b.description,
          b.repository,
          stamp(),
          req.params.id,
        );
        await store.audit(req.params.id, null, user.name, 'project.updated');
      });
      await collab.notify(req.params.id);
      return { ok: true };
    });
    app.get<{
      Params: {
        id: string;
      };
    }>('/api/projects/:id/members', async (req) => {
      const user = await auth.user(req);
      await store.role(req.params.id, user.id);
      return await store.all(
        'SELECT u.id,u.email,u.name,u.color,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.project_id=? ORDER BY u.name',
        req.params.id,
      );
    });
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/projects/:id/members', async (req) => {
      const owner = await auth.user(req);
      await store.role(req.params.id, owner.id, 'admin');
      const b = parse(
        z
          .object({
            email: z.email().max(254),
            name: z.string().trim().min(1).max(100),
            role: roleSchema,
          })
          .strict(),
        req.body,
      );
      let user = await store.userByEmail(b.email);
      let temporaryPassword: string | null = null;
      let encoded: string | null = null;
      if (!user && !settings.oidcIssuer) {
        temporaryPassword = randomBytes(18).toString('base64url');
        encoded = await passwordHash(temporaryPassword);
      }
      await projectWrite(req, req.params.id, 'admin', async () => {
        await store.lock('identity:email:' + b.email.toLowerCase());
        user = await store.userByEmail(b.email);
        if (user) temporaryPassword = null;
        await store.role(req.params.id, owner.id, 'admin');
        if (!user) user = await store.createUser(b.email, b.name, encoded);
        const owners = (
          await store.one(
            "SELECT count(*) AS n FROM memberships WHERE project_id=? AND role='owner'",
            req.params.id,
          )
        ).n;
        const old = await store.one(
          'SELECT role FROM memberships WHERE project_id=? AND user_id=?',
          req.params.id,
          user.id,
        );
        if (old?.role === 'owner' && owners === 1 && b.role !== 'owner')
          throw new HttpError(409, 'A project must keep at least one owner');
        await store.exec(
          'INSERT INTO memberships VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role',
          req.params.id,
          user.id,
          b.role,
        );
        await store.audit(
          req.params.id,
          null,
          owner.name,
          'member.updated',
          `${b.email}: ${b.role}`,
        );
      });
      await collab.notify(req.params.id);
      return { ok: true, temporaryPassword };
    });
    app.delete<{
      Params: {
        id: string;
        userId: string;
      };
    }>('/api/projects/:id/members/:userId', async (req) => {
      const user = await auth.user(req);
      await store.role(req.params.id, user.id, 'admin');
      await projectWrite(req, req.params.id, 'admin', async () => {
        const target = await store.one(
          'SELECT role FROM memberships WHERE project_id=? AND user_id=?',
          req.params.id,
          req.params.userId,
        );
        if (
          target?.role === 'owner' &&
          (
            await store.one(
              "SELECT count(*) AS n FROM memberships WHERE project_id=? AND role='owner'",
              req.params.id,
            )
          ).n <= 1
        )
          throw new HttpError(409, 'A project must keep at least one owner');
        await store.exec(
          'DELETE FROM memberships WHERE project_id=? AND user_id=?',
          req.params.id,
          req.params.userId,
        );
        await store.audit(
          req.params.id,
          null,
          user.name,
          'member.removed',
          req.params.userId,
        );
      });
      await collab.notify(req.params.id);
      return { ok: true };
    });
    app.post('/api/me/password', async (req) => {
      const user = await auth.user(req);
      const b = parse(
        z
          .object({
            current: z.string().max(256),
            password: z.string().min(16).max(256),
          })
          .strict(),
        req.body,
      );
      const { passwordValid } = await import('./auth.ts');
      const old = await store.userByEmail(user.email);
      if (!old.password || !(await passwordValid(b.current, old.password)))
        throw new HttpError(403, 'Current password is incorrect');
      const encoded = await passwordHash(b.password);
      await store.tx(async () => {
        await store.lock('user:' + user.id);
        await auth.user(req);
        if ((await store.userByEmail(user.email))?.password !== old.password)
          throw new HttpError(409, 'Account changed. Sign in again.');
        await store.exec(
          'UPDATE users SET password=? WHERE id=?',
          encoded,
          user.id,
        );
        await store.exec('DELETE FROM sessions WHERE user_id=?', user.id);
      });
      return { ok: true };
    });
    app.post('/api/tokens', async (req) => {
      const user = await auth.user(req),
        token = randomBytes(32).toString('base64url');
      await store.tx(async () => {
        await store.lock('user:' + user.id);
        await auth.user(req);
        await store.exec(
          "INSERT INTO sessions VALUES(?,?,?,'api')",
          hash(token),
          user.id,
          Date.now() + 30 * 86400000,
        );
      });
      return {
        token,
        expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      };
    });
    app.delete('/api/tokens', async (req) => {
      const user = await auth.user(req);
      await store.tx(async () => {
        await store.lock('user:' + user.id);
        await auth.user(req);
        await store.exec(
          "DELETE FROM sessions WHERE user_id=? AND kind='api'",
          user.id,
        );
      });
      return { ok: true };
    });
    app.get<{
      Params: {
        id: string;
      };
    }>(
      '/api/projects/:id/artifacts',
      async (req) =>
        await store.artifacts(req.params.id, (await auth.user(req)).id),
    );
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/projects/:id/artifacts', async (req, reply) => {
      const b = parse(
        z
          .object({
            kind: kindSchema,
            title,
            content: z.record(z.string(), z.json()).optional(),
          })
          .strict(),
        req.body,
      );
      const a = await store.createArtifact(
        await auth.user(req),
        req.params.id,
        b.kind,
        b.title,
        b.content,
      );
      await collab.notify(a.projectId, a.id);
      return reply.code(201).send(a);
    });
    app.get<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id', async (req) => {
      const a = await store.artifact(req.params.id, (await auth.user(req)).id);
      return {
        artifact: a,
        threads: await store.threads(a.id),
        messages: await store.messages(a.id),
        decisions: await store.decisions(a.id),
        runs: await store.runs(a.id),
        links: await store.all(
          'SELECT id,label,url,kind,state,updated_at AS updatedAt FROM links WHERE artifact_id=?',
          a.id,
        ),
        agentActive: await agent.isActive(a.id),
        agentAvailable: await agent.canParticipate(await auth.user(req), a.id),
        agentProfile: await agent.profiles.view(await auth.user(req), a.id),
        runnerActive: await runner.isActive(a.id),
      };
    });
    app.patch<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id', async (req) => {
      const user = await auth.user(req),
        a = await store.artifact(req.params.id, user.id, 'write');
      const b = parse(
        z
          .object({
            version: z.number().int().positive(),
            title: title.optional(),
            content: z.record(z.string(), z.json()),
          })
          .strict(),
        req.body,
      );
      let result;
      if (a.kind === 'design' || a.kind === 'document') {
        if (b.title && b.title !== a.title)
          throw new HttpError(
            400,
            'Use the title endpoint to rename a document',
          );
        result = await collab.replace(a.id, user, b.content, b.version);
      } else
        result = await store.updateArtifact(
          user,
          a.id,
          b.version,
          b.content,
          b.title,
          b.title ? () => titles.markHuman(a.id) : undefined,
        );
      await collab.notify(a.projectId, a.id);
      return result;
    });
    app.patch<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/title', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write'),
        b = parse(z.object({ title }).strict(), req.body);
      await projectWrite(req, a.projectId, 'write', async () => {
        await store.artifactWriteGuard?.(
          await store.artifact(a.id, u.id, 'write'),
          u.id,
        );
        await titles.markHuman(a.id);
        await store.exec(
          'UPDATE artifacts SET title=?,updated_at=? WHERE id=?',
          b.title,
          stamp(),
          a.id,
        );
        await store.audit(
          a.projectId,
          a.id,
          u.name,
          'artifact.renamed',
          b.title,
        );
      });
      await collab.notify(a.projectId, a.id);
      return { ok: true };
    });
    app.get<{ Params: { id: string } }>(
      '/api/artifacts/:id/title-policy',
      async (req) => titles.policy(await auth.user(req), req.params.id),
    );
    app.patch<{ Params: { id: string } }>(
      '/api/artifacts/:id/title-policy',
      async (req) =>
        titles.policy(
          await auth.user(req),
          req.params.id,
          parse(
            z.object({ mode: z.enum(['human', 'automatic']) }).strict(),
            req.body,
          ).mode,
        ),
    );
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/archive', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'admin');
      await projectWrite(req, a.projectId, 'admin', async () => {
        if (
          (
            await store.one(
              'SELECT main_artifact_id FROM projects WHERE id=?',
              a.projectId,
            )
          ).main_artifact_id === a.id
        )
          throw new HttpError(
            409,
            'The main design document cannot be archived',
          );
        await store.exec('UPDATE artifacts SET archived=1 WHERE id=?', a.id);
        await store.audit(a.projectId, a.id, u.name, 'artifact.archived');
      });
      await collab.notify(a.projectId, a.id);
      return { ok: true };
    });
    app.get<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/history', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id);
      return {
        revisions: await store.all(
          'SELECT version,actor,created_at AS createdAt FROM revisions WHERE artifact_id=? ORDER BY version DESC LIMIT 200',
          a.id,
        ),
        audit: await store.all(
          'SELECT id,artifact_id AS artifactId,actor,action,detail,created_at AS createdAt FROM audit WHERE artifact_id=? ORDER BY id DESC LIMIT 300',
          a.id,
        ),
      };
    });
    app.get<{
      Params: {
        id: string;
        version: string;
      };
    }>('/api/artifacts/:id/history/:version', async (req) => {
      await store.artifact(req.params.id, (await auth.user(req)).id);
      const r = await store.one(
        'SELECT version,content,actor,created_at AS createdAt FROM revisions WHERE artifact_id=? AND version=?',
        req.params.id,
        Number(req.params.version),
      );
      if (!r) throw new HttpError(404, 'Revision not found');
      return { ...r, content: JSON.parse(r.content) };
    });
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/threads', async (req, reply) => {
      const user = await auth.user(req),
        a = await store.artifact(req.params.id, user.id, 'write'),
        b = parse(
          z
            .object({
              anchor: z.string().max(200).nullable(),
              quote: z.string().max(5000).default(''),
              body: z.string().trim().min(1).max(20000),
            })
            .strict(),
          req.body,
        ),
        tid = randomUUID();
      await projectWrite(req, a.projectId, 'write', async () => {
        await store.artifact(a.id, user.id, 'write');
        await store.exec(
          'INSERT INTO threads(id,artifact_id,anchor,quote,created_at) VALUES(?,?,?,?,?)',
          tid,
          a.id,
          b.anchor,
          b.quote,
          stamp(),
        );
        await store.message(user, a.id, tid, b.body);
        await conversation.observe(user, a.id, tid);
        await store.audit(
          a.projectId,
          a.id,
          user.name,
          'comment.created',
          b.quote.slice(0, 200),
        );
      });
      await collab.notify(a.projectId, a.id);
      return reply.code(201).send({ id: tid });
    });
    app.patch<{
      Params: {
        id: string;
        threadId: string;
      };
    }>('/api/artifacts/:id/threads/:threadId', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write'),
        b = parse(z.object({ resolved: z.boolean() }).strict(), req.body);
      await projectWrite(req, a.projectId, 'write', async () => {
        if (
          (
            await store.exec(
              'UPDATE threads SET resolved=? WHERE id=? AND artifact_id=?',
              b.resolved ? 1 : 0,
              req.params.threadId,
              a.id,
            )
          ).changes !== 1
        )
          throw new HttpError(404, 'Discussion not found');
        await store.audit(
          a.projectId,
          a.id,
          u.name,
          b.resolved ? 'comment.resolved' : 'comment.reopened',
          req.params.threadId,
        );
      });
      await collab.notify(a.projectId, a.id);
      return { ok: true };
    });
    app.get<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/messages', async (req) => {
      const user = await auth.user(req),
        artifact = await store.artifact(req.params.id, user.id);
      const query = parse(
        z
          .object({
            threadId: id,
            limit: z.coerce.number().int().min(1).max(200).default(100),
            before: id.optional(),
          })
          .strict(),
        req.query,
      );
      return await store.messagePage(artifact.id, query.threadId, {
        limit: query.limit,
        before: query.before,
      });
    });
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/messages', async (req, reply) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write'),
        b = parse(
          z
            .object({
              threadId: id,
              body: z.string().trim().min(1).max(20000),
            })
            .strict(),
          req.body,
        );
      const m = await projectWrite(req, a.projectId, 'write', async () => {
        const saved = await store.message(u, a.id, b.threadId, b.body);
        await conversation.observe(u, a.id, b.threadId);
        return saved;
      });
      await runtime.flushOutbox();
      await agent.observeMessage(u, a.id, b.threadId, b.body);
      await collab.notify(a.projectId, a.id);
      return reply.code(201).send(m);
    });
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/agent', async (req) => {
      const u = await auth.user(req),
        b = parse(
          z
            .object({
              threadId: id,
              intent: z.enum(['chat', 'edit', 'research']),
              brief: z.string().max(2000).optional(),
            })
            .strict(),
          req.body,
        );
      return agent.respond(u, req.params.id, b.threadId, b.intent, b.brief);
    });
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/agent/cancel', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write');
      await agent.cancel(u, a.id);
      return { ok: true };
    });
    app.post<{
      Params: {
        id: string;
        messageId: string;
      };
    }>('/api/artifacts/:id/proposals/:messageId/apply', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write'),
        m = await store.messageById(a.id, req.params.messageId);
      if (!m?.proposal?.content)
        throw new HttpError(404, 'Edit proposal not found');
      if (a.kind === 'design' || a.kind === 'document')
        throw new HttpError(
          400,
          'Document proposals use the dedicated document apply route',
        );
      await store.updateArtifact(
        u,
        a.id,
        m.proposal.version,
        m.proposal.content,
        undefined,
        async () => {
          await store.exec(
            'UPDATE messages SET proposal=NULL WHERE id=? AND artifact_id=?',
            m.id,
            a.id,
          );
        },
      );
      await collab.notify(a.projectId, a.id);
      return { ok: true };
    });
    app.post<{
      Params: {
        id: string;
        messageId: string;
      };
    }>(
      '/api/artifacts/:id/proposals/:messageId/apply-document',
      async (req) => {
        const u = await auth.user(req),
          a = await store.artifact(req.params.id, u.id, 'write'),
          m = await store.messageById(a.id, req.params.messageId);
        if (!m?.proposal?.content)
          throw new HttpError(404, 'Edit proposal not found');
        await collab.replace(
          a.id,
          u,
          m.proposal.content,
          m.proposal.version,
          async () => {
            await store.exec(
              'UPDATE messages SET proposal=NULL WHERE id=? AND artifact_id=?',
              m.id,
              a.id,
            );
          },
        );
        await collab.notify(a.projectId, a.id);
        return { ok: true };
      },
    );
    app.put<{
      Params: {
        id: string;
        decisionId: string;
      };
    }>('/api/artifacts/:id/decisions/:decisionId', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write'),
        b = parse(
          z
            .object({
              title,
              context: z.string().max(20000),
              decision: z.string().max(20000),
              consequences: z.string().max(20000),
              status: z.enum(['proposed', 'accepted', 'superseded']),
              version: z.number().int().positive(),
            })
            .strict(),
          req.body,
        );
      await projectWrite(req, a.projectId, 'write', async () => {
        await store.artifactWriteGuard?.(
          await store.artifact(a.id, u.id, 'write'),
          u.id,
        );
        const previous = (await store.decisions(a.id)).find(
          (d) => d.id === req.params.decisionId,
        );
        if (!previous) throw new HttpError(404, 'ADR not found');
        if (
          (
            await store.exec(
              'UPDATE decisions SET title=?,context=?,decision=?,consequences=?,status=?,version=version+1,author=?,updated_at=? WHERE id=? AND artifact_id=? AND version=?',
              b.title,
              b.context,
              b.decision,
              b.consequences,
              b.status,
              u.name,
              stamp(),
              req.params.decisionId,
              a.id,
              b.version,
            )
          ).changes !== 1
        )
          throw new HttpError(409, 'The ADR changed. Reload before saving.');
        await store.audit(
          a.projectId,
          a.id,
          u.name,
          'decision.updated',
          JSON.stringify({ previous, next: b }),
        );
      });
      await collab.notify(a.projectId, a.id);
      return { ok: true };
    });
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/links', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write'),
        b = parse(
          z
            .object({
              label: title,
              url: z
                .url()
                .max(2000)
                .refine((s) => s.startsWith('https://')),
              kind: z.enum(['pull-request', 'issue', 'test', 'reference']),
            })
            .strict(),
          req.body,
        );
      await projectWrite(req, a.projectId, 'write', async () => {
        await store.exec(
          'INSERT INTO links VALUES(?,?,?,?,?,?,?)',
          randomUUID(),
          a.id,
          b.label,
          b.url,
          b.kind,
          'unknown',
          stamp(),
        );
        await store.audit(a.projectId, a.id, u.name, 'link.added', b.url);
      });
      await collab.notify(a.projectId, a.id);
      return { ok: true };
    });
    app.post<{
      Params: {
        id: string;
        linkId: string;
      };
    }>('/api/artifacts/:id/links/:linkId/refresh', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write'),
        link = await store.one(
          'SELECT * FROM links WHERE id=? AND artifact_id=?',
          req.params.linkId,
          a.id,
        );
      const m = link?.url.match(
        /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/,
      );
      if (!m)
        throw new HttpError(
          400,
          'Only GitHub pull requests support automatic state refresh',
        );
      let pr: any;
      if (settings.repositoryIdentity)
        pr = await identity.readRepository(
          u,
          `https://github.com/${m[1]}/${m[2]}`,
          { kind: 'pull_request', number: Number(m[3]) },
        );
      else {
        const authenticated =
          settings.githubToken &&
          settings.githubRepositories?.includes(
            `${m[1]}/${m[2]}`.toLowerCase(),
          );
        const response = await fetch(
          `https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': 'ai-bdd-studio',
              ...(authenticated
                ? { Authorization: `Bearer ${settings.githubToken}` }
                : {}),
            },
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
          },
        );
        if (!response.ok)
          throw new HttpError(
            502,
            'GitHub could not return this pull request. Use a public repository or an operator-allowlisted private repository.',
          );
        pr = await response.json();
      }
      await projectWrite(req, a.projectId, 'write', async () => {
        await store.artifact(a.id, u.id, 'write');
        await store.exec(
          'UPDATE links SET state=?,updated_at=? WHERE id=? AND artifact_id=? AND url=?',
          pr.merged ? 'merged' : pr.state,
          stamp(),
          link.id,
          a.id,
          link.url,
        );
        await store.audit(
          a.projectId,
          a.id,
          u.name,
          'link.refreshed',
          link.url,
        );
      });
      await collab.notify(a.projectId, a.id);
      return { ok: true };
    });
    app.delete<{
      Params: {
        id: string;
        linkId: string;
      };
    }>('/api/artifacts/:id/links/:linkId', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write');
      await projectWrite(req, a.projectId, 'write', async () => {
        await store.exec(
          'DELETE FROM links WHERE id=? AND artifact_id=?',
          req.params.linkId,
          a.id,
        );
      });
      await collab.notify(a.projectId, a.id);
      return { ok: true };
    });
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/files', async (req, reply) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write'),
        part = await req.file();
      if (!part) throw new HttpError(400, 'Choose a file');
      const bytes = await part.toBuffer();
      await store.artifact(a.id, u.id, 'write');
      const mime = uploadedMediaType(bytes, part.filename, part.mimetype);
      const fid = randomUUID(),
        sha256 = hash(bytes);
      const storageKey = `studio/v1/files/${a.projectId}/${sha256}`;
      await hosting.objects.put(storageKey, bytes, { contentType: mime });
      await store.registerFile(u, a.id, {
        id: fid,
        name: part.filename.slice(0, 200),
        mime,
        sha256,
        storageKey,
        byteSize: bytes.length,
      });
      return reply
        .code(201)
        .send({ id: fid, url: `/api/files/${fid}`, mime, sha256 });
    });
    app.get<{
      Params: {
        id: string;
      };
    }>('/api/files/:id', async (req, reply) => {
      const u = await auth.user(req),
        file = await store.file(req.params.id, u.id);
      const object = file.storageKey
        ? await hosting.objects.get(file.storageKey, {
            maxBytes: file.byteSize,
            expectedSha256: file.sha256,
          })
        : null;
      const bytes = object ? Buffer.from(object.bytes) : file.bytes;
      if (
        !bytes ||
        bytes.length !== file.byteSize ||
        hash(bytes) !== file.sha256
      )
        throw new HttpError(
          409,
          'File is missing or failed its integrity check',
        );
      await auth.user(req);
      await store.file(file.id, u.id);
      return reply
        .type(file.mime)
        .header('Content-Disposition', 'inline; filename="asset"')
        .header('X-Content-Type-Options', 'nosniff')
        .send(Readable.from([bytes]));
    });
    app.get<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/export', async (req, reply) => {
      const user = await auth.user(req),
        a = await store.artifact(req.params.id, user.id);
      const bounds = await store.exportBounds(a.id);
      const checkAccess = async () => {
        await auth.user(req);
        await store.role(a.projectId, user.id);
      };
      async function* content() {
        await checkAccess();
        yield JSON.stringify({ schemaVersion: 1, artifact: a }).slice(0, -1);
        for (const table of [
          'decisions',
          'threads',
          'messages',
          'links',
          'runs',
          'revisions',
          'audit',
          'files',
        ] as const) {
          yield `,"${table}":[`;
          let first = true;
          for await (const row of store.exportRows(
            table,
            a.id,
            bounds[table],
            checkAccess,
          )) {
            yield (first ? '' : ',') + JSON.stringify(row);
            first = false;
          }
          yield ']';
        }
        yield ',"documentReview":{';
        for (
          let index = 0;
          index < documentReviewExportTables.length;
          index++
        ) {
          const table = documentReviewExportTables[index]!;
          const cutoff = (
            await store.one(
              `SELECT coalesce(max(rowid),0) AS last FROM ${table} WHERE artifact_id=?`,
              a.id,
            )
          ).last;
          yield (index ? ',' : '') + JSON.stringify(table) + ':[';
          let cursor = 0,
            first = true;
          while (cursor < cutoff) {
            await checkAccess();
            const page = await documentReviewExportPage(
              store,
              a.id,
              table,
              cursor,
              100,
            );
            if (!page.rows.length) break;
            for (const row of page.rows) {
              if (row.sequence > cutoff) break;
              yield (first ? '' : ',') + JSON.stringify(row);
              first = false;
              cursor = row.sequence;
            }
            if (page.nextCursor === null || cursor >= cutoff) break;
          }
          yield ']';
        }
        yield '},"conversation":{';
        for (let index = 0; index < conversationExportTables.length; index++) {
          const table = conversationExportTables[index]!,
            cutoff = (
              await store.one(
                `SELECT coalesce(max(rowid),0) AS last FROM ${table} WHERE artifact_id=?`,
                a.id,
              )
            ).last;
          yield (index ? ',' : '') + JSON.stringify(table) + ':[';
          let cursor = 0,
            first = true;
          while (cursor < cutoff) {
            await checkAccess();
            const page = await conversationExportPage(
              store,
              a.id,
              table,
              cursor,
              100,
            );
            if (!page.rows.length) break;
            for (const row of page.rows) {
              if (row.sequence > cutoff) break;
              yield (first ? '' : ',') + JSON.stringify(row);
              first = false;
              cursor = row.sequence;
            }
            if (page.nextCursor === null || cursor >= cutoff) break;
          }
          yield ']';
        }
        yield '},"videoRenders":[';
        const renderCutoff = (
          await store.one(
            'SELECT coalesce(max(rowid),0) AS last FROM video_render_jobs WHERE artifact_id=?',
            a.id,
          )
        ).last;
        let renderCursor = 0,
          firstRender = true;
        while (renderCursor < renderCutoff) {
          await checkAccess();
          const rows = await video.exportPage(
            a.id,
            renderCursor,
            renderCutoff,
            25,
          );
          if (!rows.length) break;
          for (const row of rows) {
            yield (firstRender ? '' : ',') + JSON.stringify(row);
            firstRender = false;
            renderCursor = row.sequence;
          }
        }
        yield '],"implementation":{';
        await checkAccess();
        const implementationSnapshot = await graphs.read(user, a.id);
        yield '"snapshot":' +
          JSON.stringify(implementationSnapshot) +
          ',"events":[';
        let implementationBefore = Number.MAX_SAFE_INTEGER,
          firstEvent = true;
        while (true) {
          await checkAccess();
          const events = await graphs.history(user, a.id, {
            before: implementationBefore,
            limit: 100,
          });
          if (!events.length) break;
          for (const event of events) {
            if (event.revision > implementationSnapshot.revision) continue;
            yield (firstEvent ? '' : ',') + JSON.stringify(event);
            firstEvent = false;
          }
          implementationBefore = events.at(-1)!.revision;
          if (events.length < 100) break;
        }
        yield ']},"investigations":[';
        let firstInvestigation = true;
        for await (const row of investigationExportRows(
          store,
          a.id,
          checkAccess,
        )) {
          yield (firstInvestigation ? '' : ',') + JSON.stringify(row);
          firstInvestigation = false;
        }
        yield '],"integrationHistory":[';
        let firstIntegration = true;
        for await (const row of integrationExportRows(store, user, a.id)) {
          await checkAccess();
          yield (firstIntegration ? '' : ',') + JSON.stringify(row);
          firstIntegration = false;
        }
        yield ']}';
      }
      return reply
        .type('application/json; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="artifact-${a.id}.json"`,
        )
        .send(
          Readable.from(content(), {
            objectMode: false,
            highWaterMark: 64 * 1024,
          }),
        );
    });
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/compile', async (req) =>
      runner.compile(await auth.user(req), req.params.id),
    );
    app.get<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/plans', async (req) =>
      runner.plans(await auth.user(req), req.params.id),
    );
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/review', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write'),
        b = parse(
          z
            .object({
              target: z.string().min(1).max(1000),
              action: z.enum(['accept', 'reject', 'pin', 'unpin']),
            })
            .strict(),
          req.body,
        );
      await runner.review(u, a.id, b.target, b.action);
      await store.audit(
        a.projectId,
        a.id,
        u.name,
        'tests.reviewed',
        b.target + ': ' + b.action,
      );
      await collab.notify(a.projectId, a.id);
      return { ok: true };
    });
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/runs', async (req, reply) =>
      reply
        .code(202)
        .send(await runner.run(await auth.user(req), req.params.id)),
    );
    app.post<{
      Params: {
        id: string;
      };
    }>('/api/artifacts/:id/runs/cancel', async (req) => {
      const u = await auth.user(req),
        a = await store.artifact(req.params.id, u.id, 'write');
      await runner.cancel(u, a.id);
      return { ok: true };
    });
    app.get<{
      Params: {
        id: string;
        runId: string;
        evidenceId: string;
      };
    }>(
      '/api/artifacts/:id/runs/:runId/evidence/:evidenceId',
      async (req, reply) => {
        const result = await runner.evidence(
          await auth.user(req),
          req.params.id,
          req.params.runId,
          decodeURIComponent(req.params.evidenceId),
        );
        return reply
          .type(result.mime)
          .header('Content-Disposition', 'attachment; filename="evidence"')
          .send(result.bytes);
      },
    );
    collab.routes(app);
    const clientDir =
      options.clientDir ?? resolve(import.meta.dirname, '../client');
    if (existsSync(resolve(clientDir, 'index.html'))) {
      await app.register(fastifyStatic, { root: clientDir });
      app.setNotFoundHandler((req, reply) =>
        req.url.startsWith('/api/')
          ? reply.code(404).send({ error: 'Route not found' })
          : reply.sendFile('index.html'),
      );
    }
    app.addHook('onClose', async () => {
      await remotePlanner?.close();
      await runtime.close();
      await agent.close();
      await video.close();
      await runner.close();
      await collab.close();
      await localDispatcher?.close();
      await store.close();
    });
    return {
      app,
      store,
      auth,
      collab,
      runner,
      agent,
      video,
      integrations,
      identity,
      titles,
      conversation,
      graphs,
      remotePlanner,
      investigations,
      implementationMachines,
      maintenance: async () => {
        await investigations!.expire();
        await implementationMachines.expire();
      },
      spikes,
      drafting,
      runtime,
      hosting,
    };
  } catch (error) {
    await app.close().catch(() => {});
    for (const close of startupCleanup) {
      try {
        await close();
      } catch {}
    }
    throw error;
  }
}
