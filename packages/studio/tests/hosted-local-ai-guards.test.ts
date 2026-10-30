import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostedLocalAITarget, assertLocalAgentCatalog, assertLocalDecisionCatalog, assertConditionalDecisionReceipt, LOCAL_WEIGHTS, EXPECTED_CHAT_PROFILE } from '../verification/hosted-local-ai-guards.ts';
const model='qwen2.5-0.5b-instruct-q4-k-m';
const env={STUDIO_HOSTED_LOCAL_AI_ORIGIN:'https://ai-bdd-studio-unit-tyler-r-kendricks-projects.vercel.app',STUDIO_HOSTED_LOCAL_AI_ALLOW_USAGE:'1',STUDIO_HOSTED_LOCAL_AI_ALLOW_WRITE:'1',STUDIO_HOSTED_LOCAL_AI_SOURCE:'a'.repeat(40),STUDIO_HOSTED_LOCAL_AI_DEPLOYMENT_ID:'dpl_fixture',VERCEL_OIDC_TOKEN:'explicit-nonsecret-test-identity'};
const agent=()=>({profile:{...EXPECTED_CHAT_PROFILE},harnesses:[{id:'t3-code',configured:true,providers:[{id:'studioLocal',models:['studio-local/'+model]}]},{id:'local-cpu',configured:true,providers:[{id:'llama-cpp-cpu',models:[model]}]},{id:'vercel-fx',configured:false,providers:[{id:'ai-gateway',models:['unconfigured']}]}]});
const decision=()=>({independentOfChat:true,profile:{provider:'llama-cpp-cpu',model,minimumConfidence:.7},providers:[{id:'llama-cpp-cpu',configured:true,models:[model]},{id:'openai-decisions',configured:false,models:[]}]});
const questions=[{id:'goal',kind:'boolean'},{id:'kind',kind:'choice',choices:[{value:'keep_current'},{value:'ask_user'}]}];
const receipt=():any=>({provenance:{provider:'llama-cpp-cpu',model,requestedModel:model,mode:'native-decision',modelResolution:'pinned-local-weights',minimumConfidence:.7,localInference:{probabilityKind:'conditional-option-likelihood',calibrated:false,inputPreserved:true,contextTokens:4096,runtimeFingerprint:`local-native-v1:${model}:node-llama-cpp@3.22.2:${LOCAL_WEIGHTS[model]}`,sampledPeakRssBytes:512000000}},answers:[{questionId:'goal',kind:'boolean',status:'answered',value:true,candidate:true,probability:.8,confidence:null,probabilities:[{value:true,probability:.8},{value:false,probability:.2}]},{questionId:'kind',kind:'choice',status:'abstained',value:null,candidate:'keep_current',probability:null,confidence:.6,probabilities:[{value:'keep_current',probability:.6},{value:'ask_user',probability:.4}]}]});
describe('hosted local-only acceptance safety guards (offline; no inference)',()=>{
 it('loads in the actual native Node runtime without a TypeScript transform hook',async()=>{
  const moduleUrl=new URL('../verification/hosted-local-ai-guards.ts',import.meta.url).href;
  const code='const m=await import('+JSON.stringify(moduleUrl)+'); let refused=false; try {m.hostedLocalAITarget({})}catch(e){refused=e.code==="unapproved-origin"} console.log(JSON.stringify({imported:true,refused,networkOrInference:false}));';
  const result=await promisify(execFile)(process.execPath,['--input-type=module','--eval',code],{timeout:5000,maxBuffer:1024});
  expect(JSON.parse(result.stdout)).toEqual({imported:true,refused:true,networkOrInference:false});
 });
 it('requires both write/usage opt-ins and a separately approved production opt-in',()=>{
  expect(hostedLocalAITarget(env).production).toBe(false);
  expect(()=>hostedLocalAITarget({...env,STUDIO_HOSTED_LOCAL_AI_ALLOW_USAGE:'0'})).toThrow();
  expect(()=>hostedLocalAITarget({...env,STUDIO_HOSTED_LOCAL_AI_ALLOW_WRITE:'0'})).toThrow();
  expect(()=>hostedLocalAITarget({...env,STUDIO_HOSTED_LOCAL_AI_ORIGIN:'https://ai-bdd-studio.vercel.app'})).toThrow();
  expect(hostedLocalAITarget({...env,STUDIO_HOSTED_LOCAL_AI_ORIGIN:'https://ai-bdd-studio.vercel.app',STUDIO_HOSTED_LOCAL_AI_ALLOW_PRODUCTION_WRITE:'1'}).previewHeaders).toEqual({});
 });
 it.each(['https://evil.example','https://ai-bdd-studio.vercel.app.evil.example','http://ai-bdd-studio.vercel.app','https://ai-bdd-studio.vercel.app/path','https://user:pass@ai-bdd-studio.vercel.app'])('rejects foreign/noncanonical origin %s',origin=>expect(()=>hostedLocalAITarget({...env,STUDIO_HOSTED_LOCAL_AI_ORIGIN:origin})).toThrow());
 it('accepts registered local-only catalogs and rejects configured Gateway even when local is selected',()=>{
  expect(assertLocalAgentCatalog(agent()).profile).toEqual(EXPECTED_CHAT_PROFILE);
  const enabled=agent(); enabled.harnesses[2]!.configured=true;
  expect(()=>assertLocalAgentCatalog(enabled)).toThrow();
  const paid=agent();paid.harnesses[0]!.providers[0]!.models.push('openai/gpt-5.2');
  expect(()=>assertLocalAgentCatalog(paid)).toThrow();
  expect(assertLocalDecisionCatalog(decision()).profile.minimumConfidence).toBe(.7);
  const external=decision();external.providers[1]!.configured=true;
  expect(()=>assertLocalDecisionCatalog(external)).toThrow();
 });
 it('preserves actual conditional probabilities and honest abstention without inventing confidence',()=>{
  expect(assertConditionalDecisionReceipt(receipt(),questions).calibrated).toBe(false);
  const invented=receipt(); invented.answers[1]!.confidence=.99;
  expect(()=>assertConditionalDecisionReceipt(invented,questions)).toThrow();
  const calibrated=receipt();calibrated.provenance.localInference.calibrated=true;
  expect(()=>assertConditionalDecisionReceipt(calibrated,questions)).toThrow();
  const accepted=receipt();accepted.answers[1]!.status='answered';accepted.answers[1]!.value='keep_current';
  expect(()=>assertConditionalDecisionReceipt(accepted,questions)).toThrow();
  const missing=receipt();missing.answers[0]!.probabilities=[];
  expect(()=>assertConditionalDecisionReceipt(missing,questions)).toThrow();
 });
});
