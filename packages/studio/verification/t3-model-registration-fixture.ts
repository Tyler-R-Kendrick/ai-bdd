/** Real native regression: run only in a fresh disposable service account with public pinned assets. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import {join}from'node:path';
import{generateText}from'ai';
import{Store}from'../server/store.ts';
import{DiskObjectStore}from'../server/hosting/disk-objects.ts';
import{managedT3LanguageModel}from'../server/local/native-t3-runtime.ts';
import{createLocalLanguageModel,closeLocalModels}from'../server/local/model.ts';
assert.equal(process.getuid?.(),1000);
const root=await mkdtemp('/tmp/studio-model-registration-');
const store=await Store.open(':memory:');
const cpu=createLocalLanguageModel({directory:'/opt/studio-model'});
let cpuCalls=0;const counted={...cpu,async doGenerate(options:any){cpuCalls++;return cpu.doGenerate(options)}};
const events:any[]=[];const registered=process.env.STUDIO_FIXTURE_REGISTERED==='1';
const receipt:any={scope:'actual-native-manual-model-registration-with-empty-discovery',registered,passed:false};
try{
 const user=await store.createUser('synthetic-registration@example.invalid','Synthetic model registration',null);
 const project=await store.createProject(user,'Pinned local model registration','');
 const profile={harness:'t3-code',provider:'studioLocal',model:'studio-local/'+cpu.modelId}as const;
 const model=managedT3LanguageModel({store,objects:new DiskObjectStore(join(root,'objects')),localModel:counted,key:randomBytes(32),artifactId:project.mainArtifactId,toolsDirectory:'/opt/studio-native-tools',stateDirectory:join(root,'state'),onEvent:event=>{events.push(event)}},profile,'controlled-empty-native-discovery');
 if(registered){const result=await generateText({model,prompt:'What is 2 + 2? Answer briefly.',maxRetries:0,maxOutputTokens:64});assert.match(result.text,/\b4\b/);assert.equal(cpuCalls,1);receipt.output=result.text;}
 else{await assert.rejects(generateText({model,prompt:'What is 2 + 2? Answer briefly.',maxRetries:0,maxOutputTokens:64}),{statusCode:503});assert.equal(cpuCalls,0);assert.ok(events.some(event=>event.guardStage==='provider-selection'&&event.guardReason==='model-missing'));}
 const ledger=await store.one('SELECT COUNT(*) AS n,SUM(CASE WHEN owner IS NULL THEN 1 ELSE 0 END) AS released,SUM(CASE WHEN checkpoint_key IS NOT NULL THEN 1 ELSE 0 END) AS checkpoints FROM studio_native_t3_states');
 assert.equal(Number(ledger.n),1);assert.equal(Number(ledger.released),1);assert.equal(Number(ledger.checkpoints),registered?1:0);
 receipt.cpuCalls=cpuCalls;receipt.ledger={rows:Number(ledger.n),released:Number(ledger.released),checkpoints:Number(ledger.checkpoints)};receipt.guardFailures=events.filter(event=>event.phase==='t3-native-guard'&&event.state==='failure').map(event=>({stage:event.guardStage,reason:event.guardReason}));receipt.passed=true;
}catch(error:any){receipt.failure={kind:error?.name==='AssertionError'?'assertion':'native-operation',...(Number.isInteger(error?.statusCode)&&error.statusCode>=400&&error.statusCode<=599?{status:error.statusCode}:{})};process.exitCode=1;}finally{await closeLocalModels();await store.close();await rm(root,{recursive:true,force:true});console.log(JSON.stringify(receipt));}
