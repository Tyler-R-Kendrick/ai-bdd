import { mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEngine, createPlanStore, loadConfig, type Engine } from '@ai-bdd/sdk';
import { docText, type User } from '../shared/domain.ts';
import { HttpError, type Store, hash } from './store.ts';
import type { Settings } from './auth.ts';
import type { Collaboration } from './collaboration.ts';

export class Runner {
  active=new Map<string,AbortController>(); engines=new Map<string,Engine>();
  constructor(readonly store:Store,readonly settings:Settings,readonly collab:Collaboration){}
  async engine(id:string,userId:string) {
    if(!this.settings.runnerConfig)throw new HttpError(503,'The workspace owner has not configured a trusted ai-bdd runner');
    const artifact=this.store.artifact(id,userId,'write');
    if(!['design','document'].includes(artifact.kind))throw new HttpError(400,'Run acceptance tests from a document artifact');
    const root=resolve(this.settings.dataDir,'workspaces',id);await mkdir(resolve(root,'docs'),{recursive:true,mode:0o700});
    await writeFile(resolve(root,'docs/design.md'),docText(artifact.content.doc),{mode:0o600});
    // Only an operator-supplied config is executable. Artifact/chat contents never select a module or shell command.
    const trusted=await loadConfig({cwd:resolve(this.settings.runnerConfig,'..'),configPath:resolve(this.settings.runnerConfig)});
    const config={...trusted,projectRoot:root,docs:['docs/design.md'],planDir:resolve(root,'plans'),recordingsDir:resolve(root,'recordings'),runsDir:resolve(root,'runs'),cacheDir:resolve(root,'cache')};
    return createEngine(config);
  }
  async compile(user:User,id:string) {
    this.store.artifact(id,user.id,'write');
    if(this.active.has(id)||this.active.size>=4)throw new HttpError(409,'A test task is already running or the workspace is at its execution limit');
    const c=new AbortController();this.active.set(id,c);const timer=setTimeout(()=>c.abort(),120000);let engine:Engine|undefined;
    try {engine=await this.engine(id,user.id);this.engines.set(id,engine);const result=await engine.compile({signal:c.signal});return {result,plans:await engine.plans()};}
    finally{clearTimeout(timer);this.active.delete(id);this.engines.delete(id);await engine?.close();}
  }
  async plans(user:User,id:string) {this.store.artifact(id,user.id);return createPlanStore({dir:resolve(this.settings.dataDir,'workspaces',id,'plans'),readOnly:true}).loadAll();}
  async review(user:User,id:string,target:string,action:'accept'|'reject'|'pin'|'unpin') {const engine=await this.engine(id,user.id);try{await engine.review(target,action);}finally{await engine.close();}}
  async run(user:User,id:string) {
    const artifact=this.store.artifact(id,user.id,'write');
    if(this.active.has(id)||this.active.size>=4)throw new HttpError(409,'A test task is already running');
    if(!this.settings.runnerConfig)throw new HttpError(503,'The workspace owner has not configured a trusted ai-bdd runner');
    const runId=randomUUID(),c=new AbortController();this.active.set(id,c);
    this.store.exec('INSERT INTO runs(id,artifact_id,artifact_version,status,created_at) VALUES(?,?,?,?,?)',runId,id,artifact.version,'queued',new Date().toISOString());
    this.collab.notify(artifact.projectId,id);
    // The durable job is visible before execution starts. A restart explicitly marks incomplete jobs interrupted.
    const promise=(async()=>{
      let engine:Engine|undefined;const timer=setTimeout(()=>c.abort(),600000);
      try {
        engine=await this.engine(id,user.id);this.engines.set(id,engine);
        this.store.exec("UPDATE runs SET status='running' WHERE id=?",runId);this.collab.notify(artifact.projectId,id);
        const result=await engine.run({signal:c.signal,frozen:true,compile:false,strict:true});
        const verification=await engine.verifyRun(resolve(engine.config.runsDir,result.runId));
        const passed=result.exitCode===0&&verification.ok&&result.scenarios.length>0&&result.scenarios.every(s=>s.status==='passed'||s.status==='healed');
        this.store.exec('UPDATE runs SET status=?,result=?,error=?,finished_at=? WHERE id=?',passed?'passed':'failed',JSON.stringify({...result,integrity:verification}),result.scenarios.length===0?'No acceptance scenarios were executed':result.scenarios.every(s=>s.status==='skipped')?'All acceptance scenarios were skipped':null,new Date().toISOString(),runId);
        this.store.audit(artifact.projectId,id,user.name,'tests.completed',`run ${runId}, exit ${result.exitCode}`);
      }catch{
        this.store.exec("UPDATE runs SET status='error',error=?,finished_at=? WHERE id=?",c.signal.aborted?'Run cancelled or timed out':'Runner failed. Inspect the trusted runner configuration and server logs.',new Date().toISOString(),runId);
      }finally{clearTimeout(timer);this.active.delete(id);this.engines.delete(id);await engine?.close();this.collab.notify(artifact.projectId,id);}
    })();
    this.pending.add(promise);void promise.finally(()=>this.pending.delete(promise));return {id:runId};
  }
  pending=new Set<Promise<void>>();
  async evidence(user:User,id:string,runId:string,evidenceId:string) {
    this.store.artifact(id,user.id);const r=this.store.runs(id).find(r=>r.id===runId);
    const refs=r?.result?.scenarios?.flatMap((s:any)=>s.steps.flatMap((step:any)=>step.evidence))??[];
    const ref=refs.find((e:any)=>e.id===evidenceId||e.path===evidenceId);
    if(!ref)throw new HttpError(404,'Evidence not found');
    const root=await realpath(resolve(this.settings.dataDir,'workspaces',id,'runs',r!.result.runId));
    const target=await realpath(resolve(root,ref.path)),rel=relative(root,target);if(rel.startsWith('..')||isAbsolute(rel))throw new HttpError(403,'Evidence path is outside the run');
    const bytes=await readFile(target);if(hash(bytes)!==ref.sha256)throw new HttpError(409,'Evidence integrity check failed');
    return {bytes,mime:ref.mime??'application/octet-stream'};
  }
  async close(){for(const c of this.active.values())c.abort();await Promise.allSettled([...this.pending]);}
}
