// Explicit real-host acceptance only. Do not run before the operator confirms the reviewed deployment Ready.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  hostedLocalAITarget,
  assertLocalAgentCatalog,
  assertLocalDecisionCatalog,
  assertConditionalDecisionReceipt,
  HostedLocalAIGuardError,
} from './hosted-local-ai-guards.ts';
const target = hostedLocalAITarget(process.env), origin = target.origin;
if (!process.env.STUDIO_HOSTED_LOCAL_AI_REPORT || !process.env.STUDIO_HOSTED_LOCAL_AI_PASSWORD_FILE || !process.env.STUDIO_HOSTED_LOCAL_AI_EMAIL)
  throw new HostedLocalAIGuardError('owner-credential-reference-and-fresh-report-required');
const path = process.env.STUDIO_HOSTED_LOCAL_AI_REPORT;
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
try { await lstat(path); throw new HostedLocalAIGuardError('fresh-report-required'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const sha = value => createHash('sha256').update(value).digest('hex');
const question = 'What is 2 + 2? Reply with only the numeral.';
const fixtureText = 'Implement a tiny calculator. When a user submits 2 + 2, display 4. Acceptance: the displayed result equals 4. Keep the existing T3 Code authoring runtime; no change in tools is required.';
const report = {
  schemaVersion: 1, kind: 'hosted downloaded local-model chat and decisions',
  origin, environment: target.production ? 'production' : 'preview',
  previewIdentityHeaderSent: !target.production,
  deploymentSourceProvidedByOperator: process.env.STUDIO_HOSTED_LOCAL_AI_SOURCE,
  deploymentIdProvidedByOperator: process.env.STUDIO_HOSTED_LOCAL_AI_DEPLOYMENT_ID,
  startedAt: new Date().toISOString(), state: 'running', passed: false,
  fixture: { question, source: fixtureText }, resources: {}, steps: [], jobHistory: [],
  explicitInferenceAdmissions: { chat: 0, designReview: 0 },
  externalModelProvidersAllowed: false, credentialsRecorded: false, redirectsFollowed: 0,
};
let phase = 'setup', catalogsVerified = false;
const sessions = new Set();
async function persist() {
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
await persist();
class ProbeError extends Error {
  constructor(code, status = null) { super('Hosted local-model acceptance did not pass'); this.code = code; this.status = status; }
}
async function request(stage, route, { method = 'GET', cookie = '', body, expected = 200 } = {}) {
  phase = stage;
  const url = new URL(route, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/api/') || url.username || url.password)
    throw new ProbeError('foreign-target-refused');
  if (method !== 'GET' && /\/(messages|agent|decision-review)$/.test(url.pathname) && !catalogsVerified)
    throw new ProbeError('local-catalogs-required-before-inference');
  let response;
  const start = Date.now();
  try {
    response = await fetch(url, {
      method, redirect: 'manual', signal: AbortSignal.timeout(60000),
      headers: { ...target.previewHeaders, origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new ProbeError('transport-failure', 0); }
  report.steps.push({ stage, method, path: url.pathname, status: response.status, durationMs: Date.now() - start, at: new Date().toISOString() });
  await persist();
  const parts = []; let size = 0;
  for await (const part of response.body ?? []) {
    size += part.length;
    if (size > 2 * 1024 * 1024) throw new ProbeError('response-budget', response.status);
    parts.push(Buffer.from(part));
  }
  if (response.status !== expected) throw new ProbeError(response.status >= 500 ? 'server-failure' : 'unexpected-status', response.status);
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new ProbeError('non-json-response', response.status); }
  return { value, response };
}
const password = (await readFile(process.env.STUDIO_HOSTED_LOCAL_AI_PASSWORD_FILE, 'utf8')).replace(/\r?\n$/, '');
assert(password.length >= 16);
async function login(stage) {
  const { value, response } = await request(stage, '/api/auth/login', { method: 'POST', body: { email: process.env.STUDIO_HOSTED_LOCAL_AI_EMAIL, password } });
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).find(value => value.startsWith('studio_session='));
  if (!cookie || !value.id) throw new ProbeError('person-session-required', response.status);
  sessions.add(cookie); return cookie;
}
async function guardProfiles(cookie, artifactId) {
  const { value: agent } = await request('read-agent-profile', `/api/artifacts/${artifactId}/agent/profile`, { cookie });
  const { value: decision } = await request('read-decision-profile', `/api/artifacts/${artifactId}/decision/profile`, { cookie });
  const safe = { agent: assertLocalAgentCatalog(agent), decision: assertLocalDecisionCatalog(decision) };
  catalogsVerified = true;
  return safe;
}
function terminal(job) {
  if (['failed', 'cancelled', 'interrupted'].includes(job.status)) {
    report.jobFailure = { id: job.id, status: job.status, errorPresent: !!job.error, errorSha256: job.error ? sha(String(job.error)) : null };
    throw new ProbeError('terminal-job-failure');
  }
}
async function poll(stage, load, id) {
  const deadline = Date.now() + 480000;
  let previous = '', notice = 0;
  while (true) {
    const job = await load();
    if (!job || job.id !== id) throw new ProbeError('admitted-job-missing');
    if (job.status !== previous) {
      report.jobHistory.push({ stage, id, status: job.status, at: new Date().toISOString(), finishedAt: job.finishedAt ?? null });
      await persist(); previous = job.status;
    }
    if (Date.now() - notice >= 15000) { console.log(JSON.stringify({ stage, id, status: job.status })); notice = Date.now(); }
    terminal(job);
    if (job.status === 'completed') return job;
    if (Date.now() >= deadline) throw new ProbeError('completion-timeout');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
try {
  assert.equal((await request('health', '/api/health')).value.ok, true);
  assert.equal((await request('readiness', '/api/hosting/readiness')).value.ready, true);
  const owner = await login('owner-login');
  let prior = null;
  if (process.env.STUDIO_HOSTED_LOCAL_AI_RESUME_FILE) {
    const bytes = await readFile(process.env.STUDIO_HOSTED_LOCAL_AI_RESUME_FILE);
    assert(bytes.length < 2 * 1024 * 1024);
    prior = JSON.parse(bytes.toString('utf8'));
    assert.equal(prior.kind, report.kind);
    assert.equal(prior.fixture.question, question);
    assert.equal(prior.fixture.source, fixtureText);
    report.resources = { ...prior.resources };
    report.projectTitle = prior.projectTitle;
    report.sourceVersion = prior.sourceVersion;
    report.sourceHash = prior.sourceHash;
    report.profilePersistence = prior.profilePersistence;
    report.recovery = { priorTraceSha256: sha(bytes), originalAdmissionSource: prior.deploymentSourceProvidedByOperator, originalAdmissionDeployment: prior.deploymentIdProvidedByOperator, originalAdmissionOrigin: prior.origin, noRepeatedChatAdmission: !!prior.resources.chatJobId, noRepeatedReviewAdmission: !!prior.resources.reviewJobId };
    const { value: projects } = await request('verify-owned-synthetic-project', '/api/projects', { cookie: owner });
    const matches = projects.filter(project => report.resources.projectId ? project.id === report.resources.projectId : project.title === report.projectTitle);
    assert.equal(matches.length, 1);
    const project = matches[0];
    assert(project.title === report.projectTitle && project.title.startsWith('Hosted local AI acceptance '));
    report.resources.projectId = project.id;
    report.resources.artifactId ??= project.mainArtifactId;
    for (const key of ['projectId', 'artifactId']) assert.match(report.resources[key], /^[a-f0-9-]{36}$/);
  } else {
    // This route creates only SQL project/default document/ADR records. No model endpoint is called before the catalog guards.
    report.projectTitle = 'Hosted local AI acceptance ' + randomUUID().slice(0, 8);
    await persist();
    const { value: project } = await request('create-owned-synthetic-project', '/api/projects', { method: 'POST', cookie: owner, expected: 201, body: { title: report.projectTitle, description: 'Synthetic acceptance of downloaded local model chat and native finite decisions. No external provider.', repository: '' } });
    report.resources = { projectId: project.id, artifactId: project.mainArtifactId };
    await persist();
  }
  const id = report.resources.artifactId;
  let { value: bundle } = await request('read-owned-artifact', `/api/artifacts/${id}`, { cookie: owner });
  assert.equal(bundle.artifact.projectId, report.resources.projectId);
  assert.equal(bundle.artifact.kind, 'design');
  assert.equal(bundle.artifact.archived, false);
  report.localCatalogs = await guardProfiles(owner, id);
  if (prior && !report.profilePersistence && report.localCatalogs.decision.profile.minimumConfidence === .71 && prior.steps.some(step => step.stage === 'save-independent-threshold' && step.status === 200)) {
    await request('restore-interrupted-profile-check', `/api/artifacts/${id}/decision/profile`, {method:'PUT',cookie:owner,body:{...report.localCatalogs.decision.profile,minimumConfidence:.7}});
    report.localCatalogs = await guardProfiles(owner,id);
  }
  assert.equal(report.localCatalogs.decision.profile.minimumConfidence, .7);
  await persist();
  if (!report.sourceHash) {
    await request('keep-title-human', `/api/artifacts/${id}/title-policy`, { method: 'PATCH', cookie: owner, body: { mode: 'human', seedGoal: false } });
    await request('keep-participation-manual', `/api/artifacts/${id}/integrations/policy`, { method: 'PUT', cookie: owner, body: { mode: 'manual', paused: false } });
    const { value: artifact } = await request('save-explicit-fixture-source', `/api/artifacts/${id}`, { method: 'PATCH', cookie: owner, body: { version: bundle.artifact.version, content: { ...bundle.artifact.content, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: fixtureText }] }] } } } });
    bundle = (await request('read-saved-source', `/api/artifacts/${id}`, { cookie: owner })).value;
    assert.equal(bundle.artifact.version, artifact.version);
    report.sourceVersion = artifact.version;
    report.sourceHash = sha(JSON.stringify(bundle.artifact.content));
    report.resources.threadId = bundle.threads[0].id;
    await persist();
  } else assert.equal(sha(JSON.stringify(bundle.artifact.content)), report.sourceHash);
  if (!report.profilePersistence) {
    const originalChat = report.localCatalogs.agent.profile;
    const initial = report.localCatalogs.decision.profile;
    await request('save-independent-threshold', `/api/artifacts/${id}/decision/profile`, { method: 'PUT', cookie: owner, body: { ...initial, minimumConfidence: .71 } });
    const changed = await guardProfiles(owner, id);
    assert.equal(changed.decision.profile.minimumConfidence, .71);
    assert.deepEqual(changed.agent.profile, originalChat);
    await request('restore-normal-threshold', `/api/artifacts/${id}/decision/profile`, { method: 'PUT', cookie: owner, body: { ...changed.decision.profile, minimumConfidence: .7 } });
    const restored = await guardProfiles(owner, id);
    assert.equal(restored.decision.profile.minimumConfidence, .7);
    assert.deepEqual(restored.agent.profile, originalChat);
    report.profilePersistence = { independentOfChat: true, changedFields: ['minimumConfidence'], savedAndReloadedThreshold: .71, restoredEvaluationThreshold: .7, generativeUnchanged: true, chatProfile: originalChat, decisionProfile: restored.decision.profile };
    await persist();
  }
  if (!report.resources.userMessageId) {
    const existing = bundle.messages.filter(message => message.threadId === report.resources.threadId && message.role === 'user' && message.body === question);
    assert(existing.length <= 1);
    if (existing.length) report.resources.userMessageId = existing[0].id;
  }
  if (!report.resources.userMessageId) {
    await guardProfiles(owner, id);
    const { value: message } = await request('retain-human-chat-question', `/api/artifacts/${id}/messages`, { method: 'POST', cookie: owner, expected: 201, body: { threadId: report.resources.threadId, body: question } });
    report.resources.userMessageId = message.id; await persist();
  }
  if (!report.resources.chatJobId) {
    report.resources.chatRequestId ??= randomUUID();
    await persist();
    await guardProfiles(owner, id);
    const { value: job } = await request('request-native-local-chat', `/api/artifacts/${id}/agent`, { method: 'POST', cookie: owner, body: { threadId: report.resources.threadId, intent: 'chat', brief: question, artifactVersion: report.sourceVersion, idempotencyKey: report.resources.chatRequestId } });
    report.resources.chatJobId = job.id; report.explicitInferenceAdmissions.chat = 1; await persist();
  }
  await poll('native-local-chat', async () => (await request('poll-chat', `/api/artifacts/${id}/integrations/jobs`, { cookie: owner })).value.jobs.find(job => job.id === report.resources.chatJobId), report.resources.chatJobId);
  bundle = (await request('read-persisted-chat', `/api/artifacts/${id}`, { cookie: owner })).value;
  const assistant = bundle.messages.filter(message => message.threadId === report.resources.threadId && message.role === 'assistant').at(-1);
  assert(assistant);
  assert.match(assistant.body.trim(), /^(?:\*\*)?4(?:\*\*)?[.!]?$/);
  report.resources.assistantMessageId = assistant.id;
  report.chat = { answer: assistant.body, expectedNumeral: '4', actualDefaultNativeProfile: (await guardProfiles(owner, id)).agent.profile, retainedInArtifactThread: true, completed: true };
  await persist();
  const { value: review } = await request('read-design-review-source', `/api/artifacts/${id}/decision-review`, { cookie: owner });
  assert.equal(review.available, true);
  const passage = review.passages.find(passage => passage.quote === fixtureText);
  assert(passage);
  if (!report.resources.reviewJobId) {
    report.resources.reviewRequestId ??= randomUUID();
    await persist();
    const guarded = await guardProfiles(owner, id);
    assert.equal(guarded.decision.profile.minimumConfidence, .7);
    const { value: job } = await request('request-native-local-decisions', `/api/artifacts/${id}/decision-review`, { method: 'POST', cookie: owner, body: { requestId: report.resources.reviewRequestId, blockIds: [passage.id] } });
    report.resources.reviewJobId = job.id; report.explicitInferenceAdmissions.designReview = 1; await persist();
  }
  const reviewJob = await poll('native-local-decisions', async () => (await request('poll-design-review', `/api/artifacts/${id}/decision-review`, { cookie: owner })).value.jobs.find(job => job.id === report.resources.reviewJobId), report.resources.reviewJobId);
  assert(reviewJob.result && !reviewJob.stale);
  const result = reviewJob.result, evaluation = result.evaluation;
  assert.equal(result.artifactVersion, report.sourceVersion);
  assert.equal(result.passages[0].quote, fixtureText);
  assert.equal(evaluation.provenance.minimumConfidence, .7);
  report.nativeDecisionMechanism = assertConditionalDecisionReceipt(evaluation, result.questions);
  report.resources.evaluationId = evaluation.id;
  report.decision = { questions: result.questions, evaluation, artifactVersion: result.artifactVersion, sourceHash: result.sourceHash, acceptedDecisionHash: result.acceptedDecisionHash };
  const goal = evaluation.answers.find(answer => answer.questionId === 'goal'), harness = evaluation.answers.find(answer => answer.questionId === 'harness');
  report.qualityObservations = {
    scope: 'One explicit synthetic passage; observations are not an accuracy or calibration guarantee.',
    goalExpectedCandidate: true, actualGoalCandidate: goal.candidate, actualGoalValue: goal.value, goalStatus: goal.status, goalCandidateMatched: goal.candidate === true,
    harnessExpectedCandidate: 'keep_current', actualHarnessCandidate: harness.candidate, actualHarnessValue: harness.value, harnessStatus: harness.status, harnessCandidateMatched: harness.candidate === 'keep_current',
    abstainedQuestionIds: evaluation.answers.filter(answer => answer.status === 'abstained').map(answer => answer.questionId),
    humanApprovalOrReadinessChangedByThisScript: false,
  };
  const { value: storedEvaluation } = await request('read-retained-evaluation', `/api/artifacts/${id}/decision/evaluations/${evaluation.id}`, { cookie: owner });
  assert.deepEqual(storedEvaluation, evaluation);
  const fresh = await login('fresh-owner-login');
  const { value: again } = await request('fresh-artifact-chat', `/api/artifacts/${id}`, { cookie: fresh });
  assert.equal(again.artifact.version, report.sourceVersion);
  assert.equal(sha(JSON.stringify(again.artifact.content)), report.sourceHash);
  assert(again.messages.some(message => message.id === report.resources.userMessageId && message.body === question));
  assert(again.messages.some(message => message.id === assistant.id && message.body === assistant.body));
  const profiles = await guardProfiles(fresh, id);
  assert.deepEqual(profiles.agent.profile, report.profilePersistence.chatProfile);
  assert.equal(profiles.decision.profile.minimumConfidence, .7);
  const { value: retained } = await request('fresh-decision-receipt', `/api/artifacts/${id}/decision/evaluations/${evaluation.id}`, { cookie: fresh });
  assert.deepEqual(retained, evaluation);
  report.freshSessionPersistence = true;
  const denied = await request('anonymous-artifact-denial', `/api/artifacts/${id}`, { expected: 401 });
  assert.equal(denied.value.error, 'Sign in to continue');
  const evaluationDenied = await request('anonymous-decision-denial', `/api/artifacts/${id}/decision/evaluations/${evaluation.id}`, { expected: 401 });
  assert.equal(evaluationDenied.value.error, 'Sign in to continue');
  report.unauthorizedDenied = true;
  report.passed = true;
} catch (error) {
  report.failure = { phase, code: error instanceof HostedLocalAIGuardError || error instanceof ProbeError ? error.code : 'acceptance-assertion-failed', httpStatus: error instanceof ProbeError ? error.status : null };
  process.exitCode = 1;
} finally {
  let closed = 0;
  for (const cookie of sessions) {
    try { await request('close-owned-verification-session', '/api/auth/logout', { method: 'POST', cookie, body: {} }); closed++; }
    catch { /* Keep failures finite; never print cookies or raw transport errors. */ }
  }
  report.ownedSessionCleanup = { created: sessions.size, closed };
  if (closed !== sessions.size) { report.passed = false; process.exitCode = 1; }
}
report.completedAt = new Date().toISOString();
report.state = report.passed ? 'completed' : 'incomplete';
report.syntheticResourcesRetainedForReview = true;
await persist();
console.log(JSON.stringify({ passed: report.passed, resources: report.resources, failure: report.failure ?? null, qualityObservations: report.qualityObservations ?? null }));
