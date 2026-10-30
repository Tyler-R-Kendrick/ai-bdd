import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { boundedJson } from './http.ts';

/** This gate calls the selected deployment's configured model. Protocol fixtures never satisfy it implicitly. */
export async function verifyLiveIntegrations(env: NodeJS.ProcessEnv) {
  const api = env.STUDIO_LIVE_API_URL,
    token = env.STUDIO_LIVE_API_TOKEN,
    projectId = env.STUDIO_LIVE_PROJECT_ID;
  if (
    !api ||
    !token ||
    !projectId ||
    env.STUDIO_LIVE_ALLOW_PROVIDER_USAGE !== '1'
  )
    throw new Error(
      'Live verification requires a selected deployment, owner API credential, dedicated project, and explicit provider-usage flag',
    );
  const origin = new URL(api);
  if (
    origin.origin !== api ||
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password
  )
    throw new Error(
      'Live verification requires a credential-free HTTPS deployment origin',
    );
  z.string().uuid().parse(projectId);
  const call = async (path: string, method = 'GET', body?: unknown) =>
    boundedJson(
      await fetch(new URL('/api' + path, api), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(150000),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      undefined,
      4 * 1024 * 1024,
    );
  const projects = await call('/projects');
  const selected = (
    Array.isArray(projects) ? projects : projects.projects
  )?.find((project: any) => project.id === projectId);
  if (selected?.role !== 'owner')
    throw new Error(
      'Live verification requires owner access to its dedicated test project',
    );
  const waitForJob = async (artifactId: string, jobId: string) => {
    if (!jobId)
      throw new Error(
        'The deployment did not return the durable agent job identity',
      );
    const deadline = Date.now() + 600000;
    while (Date.now() < deadline) {
      const history = await call(
          `/artifacts/${artifactId}/integrations/jobs`,
        ),
        job = history.jobs.find((item: any) => item.id === jobId);
      if (job?.status === 'completed') return job;
      if (job && ['failed', 'cancelled', 'interrupted'].includes(job.status))
        throw new Error(
          'The selected live harness did not complete its durable job',
        );
      await delay(500);
    }
    throw new Error(
      'The selected live harness exceeded the bounded verification window',
    );
  };
  const created: string[] = [],
    checks: string[] = [];
  const marker = `live-${randomUUID()}`;
  let failure: unknown;
  try {
    const artifact = await call(`/projects/${projectId}/artifacts`, 'POST', {
      kind: 'document',
      title: 'Live integration acceptance ' + marker,
    });
    created.push(artifact.id);
    const bundle = await call(`/artifacts/${artifact.id}`),
      threadId = bundle.threads.find((thread: any) => !thread.anchor)?.id;
    if (!threadId || bundle.decisions.length !== 1)
      throw new Error(
        'The live artifact did not own its dedicated discussion and ADR',
      );
    checks.push('dedicated live fixture artifact, chat, and ADR');
    if (env.STUDIO_LIVE_HARNESS) {
      const view = await call(`/artifacts/${artifact.id}/agent/profile`),
        harness = view.harnesses.find(
          (value: any) => value.id === env.STUDIO_LIVE_HARNESS,
        );
      if (!harness?.configured)
        throw new Error(
          'The explicitly selected live harness is not configured',
        );
      const provider = harness.providers.find(
        (value: any) =>
          value.id === (env.STUDIO_LIVE_PROVIDER ?? harness.providers[0]?.id),
      );
      if (!provider)
        throw new Error(
          'The explicitly selected live provider is not registered',
        );
      await call(`/artifacts/${artifact.id}/agent/profile`, 'PUT', {
        harness: harness.id,
        provider: provider.id,
        model: env.STUDIO_LIVE_MODEL ?? provider.models[0],
      });
      checks.push('explicit harness/provider/model selection: ' + harness.id);
    }

    await call(`/artifacts/${artifact.id}/messages`, 'POST', {
      threadId,
      body: `Reply with exactly this marker: ${marker}`,
    });
    const chatRequest = await call(
      `/artifacts/${artifact.id}/agent`,
      'POST',
      { threadId, intent: 'chat' },
    );
    await waitForJob(artifact.id, chatRequest.id);
    const chat = await call(`/artifacts/${artifact.id}`),
      jobs = await call(`/artifacts/${artifact.id}/integrations/jobs`);
    if (
      !chat.messages.some(
        (message: any) =>
          message.role === 'assistant' && message.body.includes(marker),
      ) ||
      jobs.jobs[0]?.status !== 'completed'
    )
      throw new Error(
        'The configured live model did not return the requested marker',
      );
    checks.push(
      'configured model HTTP execution and artifact-bound persisted response',
    );
    if (env.STUDIO_LIVE_VERIFY_RESEARCH === '1') {
      const researchRequest = await call(
        `/artifacts/${artifact.id}/agent`,
        'POST',
        {
          threadId,
          intent: 'research',
          brief:
            'Explain Pact consumer-driven contract boundaries using retrieved sources.',
        },
      );
      const research = await waitForJob(artifact.id, researchRequest.id);
      if (research?.status !== 'completed' || !research.childArtifactId)
        throw new Error('Live source-backed research did not complete');
      created.push(research.childArtifactId);
      const child = await call(`/artifacts/${research.childArtifactId}`);
      if (
        !JSON.stringify(child.artifact.content).includes('excerpt SHA-256') ||
        child.decisions.length !== 1 ||
        child.threads.length !== 1
      )
        throw new Error(
          'Live research provenance or child context is missing',
        );
      checks.push(
        'actual configured source retrieval, cited child research, and independent child chat/ADR',
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const artifactId of created.reverse()) {
      try {
        await call(`/artifacts/${artifactId}/agent/cancel`, 'POST');
        await call(`/artifacts/${artifactId}/archive`, 'POST');
      } catch {
        failure ??= new Error(
          'Live verification could not archive all of its fixture artifacts',
        );
      }
    }
  }
  if (failure) throw failure;
  return {
    passed: true,
    checks,
    scope:
      'Explicit configured-deployment/model/source checks with temporary synthetic artifacts; not an independent audit of the provider, OIDC issuer, or whole-system correctness.',
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  verifyLiveIntegrations(process.env).then(
    (result) => process.stdout.write(JSON.stringify(result, null, 2) + '\n'),
    () => {
      process.stderr.write(
        'Live integration verification did not pass. Confirm its explicitly configured deployment, owner credential, source/model readiness, and test-project access. No live-provider success is certified.\n',
      );
      process.exitCode = 1;
    },
  );
}
