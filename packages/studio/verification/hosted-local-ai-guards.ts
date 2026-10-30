/** Offline safety/provenance guards. No network, model or filesystem access. */
export const LOCAL_WEIGHTS = {
  'qwen2.5-0.5b-instruct-q4-k-m': '6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653',
  'smollm2-135m-instruct-q4-k-m': '2e8040ceae7815abe0dcb3540b9995eaa1fa0d2ca9e797d0a635ae4433c68c2d',
} as const;
export const EXPECTED_CHAT_PROFILE = {
  harness: 't3-code', provider: 'studioLocal', model: 'studio-local/qwen2.5-0.5b-instruct-q4-k-m',
} as const;
export class HostedLocalAIGuardError extends Error {
  readonly code: string;
  constructor(code: string) {
    super('Hosted local AI acceptance guard rejected a condition');
    this.code = code;
  }
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new HostedLocalAIGuardError(code);
}
const object = (value: any) => {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'invalid-object');
  return value as Record<string, any>;
};
export function hostedLocalAITarget(env: Record<string, string | undefined>) {
  let target: URL;
  try { target = new URL(env.STUDIO_HOSTED_LOCAL_AI_ORIGIN ?? 'https://invalid.example'); }
  catch { throw new HostedLocalAIGuardError('invalid-origin'); }
  const production = target.origin === 'https://ai-bdd-studio.vercel.app';
  requireCondition(target.protocol === 'https:' && !target.port && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash, 'invalid-origin');
  requireCondition(production || /^ai-bdd-studio-[a-z0-9]+-tyler-r-kendricks-projects\.vercel\.app$/.test(target.hostname), 'unapproved-origin');
  requireCondition(env.STUDIO_HOSTED_LOCAL_AI_ALLOW_USAGE === '1' && env.STUDIO_HOSTED_LOCAL_AI_ALLOW_WRITE === '1', 'explicit-usage-and-write-required');
  requireCondition(!production || env.STUDIO_HOSTED_LOCAL_AI_ALLOW_PRODUCTION_WRITE === '1', 'explicit-production-write-required');
  requireCondition(production || !!env.VERCEL_OIDC_TOKEN, 'preview-identity-required');
  requireCondition(/^[a-f0-9]{40}$/.test(env.STUDIO_HOSTED_LOCAL_AI_SOURCE ?? '') && /^dpl_[A-Za-z0-9]+$/.test(env.STUDIO_HOSTED_LOCAL_AI_DEPLOYMENT_ID ?? ''), 'reviewed-source-deployment-required');
  return { origin: target.origin, production, previewHeaders: production ? {} : { 'x-vercel-trusted-oidc-idp-token': env.VERCEL_OIDC_TOKEN! } };
}
export function assertLocalAgentCatalog(raw: unknown) {
  const view = object(raw), profile = object(view.profile);
  requireCondition(Array.isArray(view.harnesses) && view.harnesses.length > 0, 'invalid-harness-catalog');
  for (const item of view.harnesses) {
    const h = object(item);
    requireCondition(typeof h.configured === 'boolean', 'invalid-harness-availability');
    if (!h.configured) continue;
    requireCondition(['t3-code', 'local-cpu'].includes(h.id), 'configured-nonlocal-harness');
    requireCondition(Array.isArray(h.providers) && h.providers.length > 0, 'missing-local-provider');
    for (const p of h.providers) {
      requireCondition(p.id === (h.id === 't3-code' ? 'studioLocal' : 'llama-cpp-cpu'), 'configured-nonlocal-agent-provider');
      requireCondition(Array.isArray(p.models) && p.models.length > 0 && p.models.every((id: unknown) => typeof id === 'string' && Object.keys(LOCAL_WEIGHTS).some(local => id === (h.id === 't3-code' ? 'studio-local/' + local : local))), 'configured-nonlocal-agent-model');
    }
  }
  requireCondition(Object.entries(EXPECTED_CHAT_PROFILE).every(([key, value]) => profile[key] === value), 'default-native-local-profile-required');
  requireCondition(view.harnesses.some((h: any) => h.id === 't3-code' && h.configured), 'native-t3-offline');
  requireCondition(view.harnesses.some((h: any) => h.id === 'local-cpu' && h.configured), 'explicit-local-cpu-offline');
  return { profile: { harness: profile.harness, provider: profile.provider, model: profile.model }, harnesses: view.harnesses.map((h: any) => ({ id: h.id, configured: h.configured, providers: h.configured ? h.providers.map((p: any) => ({id:p.id,models:[...p.models]})) : [] })) };
}
export function assertLocalDecisionCatalog(raw: unknown) {
  const view = object(raw), profile = object(view.profile);
  requireCondition(view.independentOfChat === true && Array.isArray(view.providers), 'independent-decision-profile-required');
  for (const p of view.providers) {
    requireCondition(typeof p.configured === 'boolean', 'invalid-decision-availability');
    if (!p.configured) continue;
    requireCondition(p.id === 'llama-cpp-cpu', 'configured-nonlocal-decision-provider');
    requireCondition(Array.isArray(p.models) && p.models.length > 0 && p.models.every((id: unknown) => typeof id === 'string' && Object.hasOwn(LOCAL_WEIGHTS, id)), 'configured-nonlocal-decision-model');
  }
  requireCondition(profile.provider === 'llama-cpp-cpu' && profile.model === 'qwen2.5-0.5b-instruct-q4-k-m', 'default-local-decision-profile-required');
  requireCondition(view.providers.some((p: any) => p.id === profile.provider && p.configured && p.models.includes(profile.model)), 'local-decision-offline');
  return {profile:{...profile},providers:view.providers.map((p:any)=>({id:p.id,configured:p.configured,models:p.configured?[...p.models]:[]}))};
}
export function assertConditionalDecisionReceipt(raw: unknown, questions: any[]) {
  const evaluation = object(raw), provenance = object(evaluation.provenance), native = object(provenance.localInference);
  requireCondition(provenance.provider === 'llama-cpp-cpu' && provenance.mode === 'native-decision' && provenance.modelResolution === 'pinned-local-weights', 'native-local-decision-required');
  const model = provenance.model as keyof typeof LOCAL_WEIGHTS;
  requireCondition(Object.hasOwn(LOCAL_WEIGHTS, model) && provenance.requestedModel === model, 'unexpected-decision-model');
  requireCondition(native.probabilityKind === 'conditional-option-likelihood' && native.calibrated === false && native.inputPreserved === true && native.contextTokens === 4096, 'native-conditional-provenance-required');
  requireCondition(native.runtimeFingerprint === `local-native-v1:${model}:node-llama-cpp@3.22.2:${LOCAL_WEIGHTS[model]}` && Number.isFinite(native.sampledPeakRssBytes) && native.sampledPeakRssBytes > 0, 'pinned-local-runtime-required');
  requireCondition(Number.isFinite(provenance.minimumConfidence) && provenance.minimumConfidence >= .5 && provenance.minimumConfidence <= 1, 'invalid-decision-threshold');
  requireCondition(Array.isArray(evaluation.answers) && evaluation.answers.length === questions.length && questions.some(q=>q.kind==='boolean') && questions.some(q=>q.kind==='choice'), 'predicate-and-choice-required');
  for (const q of questions) {
    const answer = evaluation.answers.find((a:any)=>a.questionId===q.id);
    requireCondition(answer && answer.kind===q.kind && ['answered','abstained'].includes(answer.status), 'actual-native-answer-required');
    requireCondition(Array.isArray(answer.probabilities) && answer.probabilities.length >= 2, 'native-option-likelihoods-required');
    const entries = answer.probabilities as {value:string|boolean|number;probability:number}[];
    requireCondition(entries.every(p=>Number.isFinite(p.probability)&&p.probability>=0&&p.probability<=1) && Math.abs(entries.reduce((sum,p)=>sum+p.probability,0)-1)<1e-5 && new Set(entries.map(p=>JSON.stringify(p.value))).size===entries.length, 'invalid-option-distribution');
    const top = [...entries].sort((a,b)=>b.probability-a.probability)[0]!;
    if(q.kind==='boolean') {
      const yes=entries.find(p=>p.value===true), no=entries.find(p=>p.value===false);
      requireCondition(yes&&no&&entries.length===2&&Math.abs(answer.probability-yes.probability)<1e-5&&answer.confidence===null&&answer.candidate===top.value, 'invalid-native-predicate');
    } else if(q.kind==='choice') {
      requireCondition(entries.length===q.choices.length&&entries.every(p=>q.choices.some((c:any)=>c.value===p.value))&&answer.candidate===top.value&&Number.isFinite(answer.confidence)&&Math.abs(answer.confidence-top.probability)<1e-5, 'invalid-native-choice');
    } else {
      requireCondition(entries.length===q.levels.length&&entries.every(p=>Number.isInteger(p.value)&&Number(p.value)>=0&&Number(p.value)<q.levels.length)&&Number.isFinite(answer.confidence)&&Math.abs(answer.confidence-top.probability)<1e-5&&Math.abs(answer.candidate-entries.reduce((sum,p)=>sum+Number(p.value)*p.probability,0))<1e-5, 'invalid-native-score');
    }
    if(answer.status==='abstained') requireCondition(answer.value===null,'abstention-must-not-accept-candidate');
    else {
      requireCondition(answer.value===answer.candidate,'answered-value-must-match-candidate');
      requireCondition(top.probability>=provenance.minimumConfidence && !(q.kind==='boolean'&&answer.probability===.5), 'accepted-answer-below-policy-threshold');
    }
  }
  return {probabilityKind:native.probabilityKind,calibrated:false,inputPreserved:true,runtimeFingerprint:native.runtimeFingerprint,sampledPeakRssBytes:native.sampledPeakRssBytes};
}
