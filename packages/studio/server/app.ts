import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { Store, HttpError, hash } from './store.ts';
import { Auth, passwordHash, type Settings } from './auth.ts';
import { Collaboration } from './collaboration.ts';
import { Runner } from './runner.ts';
import { Agent } from './agent.ts';
import { kindSchema, roleSchema, initialContent, type User } from '../shared/domain.ts';
const title=z.string().trim().min(1).max(180),id=z.string().uuid();
const parse=<T>(s:z.ZodType<T>,v:unknown)=>s.parse(v);
const stamp=()=>new Date().toISOString();
const repo=z.string().max(300).refine(s=>s===''||/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(s),'Use a github.com repository URL');
export async function createApp(settings:Settings,options:{db?:string;logger?:boolean;clientDir?:string}={}) {
  const app=Fastify({logger:options.logger??false,bodyLimit:2_100_000,requestTimeout:150000,connectionTimeout:15000,trustProxy:false});
  const store=new Store(options.db??resolve(settings.dataDir,'studio.sqlite'));const auth=new Auth(store,settings);await auth.initialize();
  const collab=new Collaboration(store,auth),runner=new Runner(store,settings,collab),agent=new Agent(store,settings,collab);
  await app.register(cookie);
  await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'wasm-unsafe-eval'"],styleSrc:["'self'","'unsafe-inline'"],imgSrc:["'self'",'data:','blob:'],fontSrc:["'self'"],connectSrc:["'self'"],workerSrc:["'self'",'blob:'],frameSrc:['blob:',"'self'"],objectSrc:["'none'"],frameAncestors:["'none'"],baseUri:["'self'"],formAction:["'self'"]}},crossOriginEmbedderPolicy:false});
  await app.register(rateLimit,{max:240,timeWindow:'1 minute'});
  await app.register(websocket,{options:{maxPayload:1024*1024,perMessageDeflate:false}});
  await app.register(multipart,{limits:{fileSize:10*1024*1024,files:1,fields:1}});
  app.setErrorHandler((error,req,reply)=>{
    if(error instanceof ZodError)return reply.code(400).send({error:'Invalid request',issues:error.issues.map(i=>({path:i.path.join('.'),message:i.message}))});
    const status=(error as any).statusCode??500;
    if(status>=500)req.log.error({err:error},'Request failed');
    return reply.code(status).send({error:status<500?(error as Error).message:'The server could not complete this request'});
  });
  app.addHook('onRequest',async req=>{
    if(req.url.startsWith('/api/')&&!req.url.startsWith('/api/auth/')&&!['GET','HEAD','OPTIONS'].includes(req.method))auth.assertOrigin(req);
  });
  app.addHook('onSend',async(_req,reply,payload)=>{reply.header('Cache-Control','no-store');return payload;});
  await auth.routes(app);
  app.get('/api/health',async()=>{store.one('SELECT 1');return {ok:true};});
  app.get('/api/capabilities',async req=>{auth.user(req);return {agent:!!settings.model,runner:!!settings.runnerConfig,oidc:!!settings.oidcIssuer,github:!!settings.githubToken,openDesign:false,magnetar:false};});
  const previews=new Map<string,{userId:string;artifactId:string;html:string;expires:number}>();
  app.post<{Params:{id:string}}>('/api/artifacts/:id/previews',async(req,reply)=>{
    const user=auth.user(req),artifact=store.artifact(req.params.id,user.id);
    if(artifact.kind!=='code')throw new HttpError(400,'Code previews require a code artifact');
    const {html}=parse(z.object({html:z.string().max(2_000_000)}).strict(),req.body);
    for(const [key,value]of previews)if(value.expires<Date.now())previews.delete(key);
    // Replacing a user's old draft bounds memory independently of typing frequency.
    for(const [key,value]of previews)if(value.userId===user.id&&value.artifactId===artifact.id)previews.delete(key);
    if(previews.size>=40)throw new HttpError(429,'Too many live previews. Try again shortly.');
    const token=randomBytes(24).toString('base64url');previews.set(token,{userId:user.id,artifactId:artifact.id,html,expires:Date.now()+120000});
    return reply.code(201).send({url:'/api/previews/'+token});
  });
  app.get<{Params:{token:string}}>('/api/previews/:token',async(req,reply)=>{
    const user=auth.user(req),preview=previews.get(req.params.token);
    if(!preview||preview.expires<Date.now()||preview.userId!==user.id)throw new HttpError(404,'Preview expired. Refresh the preview to continue.');
    store.artifact(preview.artifactId,user.id);
    return reply.type('text/html; charset=utf-8').header('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts").header('Cross-Origin-Resource-Policy','same-origin').send(preview.html);
  });
  app.get('/api/projects',async req=>store.projects(auth.user(req).id));
  app.post('/api/projects',async(req,reply)=>{
    const b=parse(z.object({title,description:z.string().max(4000).default(''),repository:repo.default('')}).strict(),req.body);
    const project=store.createProject(auth.user(req),b.title,b.description,b.repository);return reply.code(201).send(project);
  });
  app.patch<{Params:{id:string}}>('/api/projects/:id',async req=>{
    const user=auth.user(req);store.role(req.params.id,user.id,'admin');const b=parse(z.object({title,description:z.string().max(4000),repository:repo}).strict(),req.body);
    store.exec('UPDATE projects SET title=?,description=?,repository=?,updated_at=? WHERE id=?',b.title,b.description,b.repository,stamp(),req.params.id);store.audit(req.params.id,null,user.name,'project.updated');collab.notify(req.params.id);return {ok:true};
  });
  app.get<{Params:{id:string}}>('/api/projects/:id/members',async req=>{const user=auth.user(req);store.role(req.params.id,user.id);return store.all('SELECT u.id,u.email,u.name,u.color,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.project_id=? ORDER BY u.name',req.params.id);});
  app.post<{Params:{id:string}}>('/api/projects/:id/members',async req=>{
    const owner=auth.user(req);store.role(req.params.id,owner.id,'admin');const b=parse(z.object({email:z.email().max(254),name:z.string().trim().min(1).max(100),role:roleSchema}).strict(),req.body);
    let user=store.userByEmail(b.email);let temporaryPassword:string|null=null;let encoded:string|null=null;
    if(!user&&!settings.oidcIssuer){temporaryPassword=randomBytes(18).toString('base64url');encoded=await passwordHash(temporaryPassword);}
    store.tx(()=>{
      if(!user)user=store.createUser(b.email,b.name,encoded);
      const owners=store.one("SELECT count(*) AS n FROM memberships WHERE project_id=? AND role='owner'",req.params.id).n;
      const old=store.one('SELECT role FROM memberships WHERE project_id=? AND user_id=?',req.params.id,user.id);
      if(old?.role==='owner'&&owners===1&&b.role!=='owner')throw new HttpError(409,'A project must keep at least one owner');
      store.exec('INSERT INTO memberships VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role',req.params.id,user.id,b.role);
      store.audit(req.params.id,null,owner.name,'member.updated',`${b.email}: ${b.role}`);
    });collab.notify(req.params.id);return {ok:true,temporaryPassword};
  });
  app.delete<{Params:{id:string;userId:string}}>('/api/projects/:id/members/:userId',async req=>{
    const user=auth.user(req);store.role(req.params.id,user.id,'admin');store.tx(()=>{
      const target=store.one('SELECT role FROM memberships WHERE project_id=? AND user_id=?',req.params.id,req.params.userId);
      if(target?.role==='owner'&&store.one("SELECT count(*) AS n FROM memberships WHERE project_id=? AND role='owner'",req.params.id).n<=1)throw new HttpError(409,'A project must keep at least one owner');
      store.exec('DELETE FROM memberships WHERE project_id=? AND user_id=?',req.params.id,req.params.userId);store.audit(req.params.id,null,user.name,'member.removed',req.params.userId);
    });collab.notify(req.params.id);return {ok:true};
  });
  app.post('/api/me/password',async req=>{const user=auth.user(req);const b=parse(z.object({current:z.string().max(256),password:z.string().min(16).max(256)}).strict(),req.body);const {passwordValid}=await import('./auth.ts');const old=store.userByEmail(user.email);if(!old.password||!await passwordValid(b.current,old.password))throw new HttpError(403,'Current password is incorrect');store.exec('UPDATE users SET password=? WHERE id=?',await passwordHash(b.password),user.id);store.exec('DELETE FROM sessions WHERE user_id=?',user.id);return {ok:true};});
  app.post('/api/tokens',async req=>{const user=auth.user(req),token=randomBytes(32).toString('base64url');store.exec("INSERT INTO sessions VALUES(?,?,?,'api')",hash(token),user.id,Date.now()+30*86400000);return {token,expiresAt:new Date(Date.now()+30*86400000).toISOString()};});
  app.delete('/api/tokens',async req=>{store.exec("DELETE FROM sessions WHERE user_id=? AND kind='api'",auth.user(req).id);return {ok:true};});
  app.get<{Params:{id:string}}>('/api/projects/:id/artifacts',async req=>store.artifacts(req.params.id,auth.user(req).id));
  app.post<{Params:{id:string}}>('/api/projects/:id/artifacts',async(req,reply)=>{const b=parse(z.object({kind:kindSchema,title,content:z.record(z.string(),z.json()).optional()}).strict(),req.body);const a=store.createArtifact(auth.user(req),req.params.id,b.kind,b.title,b.content);collab.notify(a.projectId,a.id);return reply.code(201).send(a);});
  app.get<{Params:{id:string}}>('/api/artifacts/:id',async req=>{
    const a=store.artifact(req.params.id,auth.user(req).id);return {artifact:a,threads:store.threads(a.id),messages:store.messages(a.id),decisions:store.decisions(a.id),runs:store.runs(a.id),links:store.all('SELECT id,label,url,kind,state,updated_at AS updatedAt FROM links WHERE artifact_id=?',a.id),agentActive:agent.active.has(a.id),runnerActive:runner.active.has(a.id)};
  });
  app.patch<{Params:{id:string}}>('/api/artifacts/:id',async req=>{
    const user=auth.user(req),a=store.artifact(req.params.id,user.id,'write');const b=parse(z.object({version:z.number().int().positive(),title:title.optional(),content:z.record(z.string(),z.json())}).strict(),req.body);
    let result;
    if(a.kind==='design'||a.kind==='document'){
      if(b.title&&b.title!==a.title)throw new HttpError(400,'Use the title endpoint to rename a document');
      result=collab.replace(a.id,user,b.content,b.version);
    }else result=store.updateArtifact(user,a.id,b.version,b.content,b.title);
    collab.notify(a.projectId,a.id);return result;
  });
  app.patch<{Params:{id:string}}>('/api/artifacts/:id/title',async req=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write'),b=parse(z.object({title}).strict(),req.body);store.exec('UPDATE artifacts SET title=?,updated_at=? WHERE id=?',b.title,stamp(),a.id);store.audit(a.projectId,a.id,u.name,'artifact.renamed',b.title);collab.notify(a.projectId,a.id);return {ok:true};});
  app.post<{Params:{id:string}}>('/api/artifacts/:id/archive',async req=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id,'admin');if(store.one('SELECT main_artifact_id FROM projects WHERE id=?',a.projectId).main_artifact_id===a.id)throw new HttpError(409,'The main design document cannot be archived');store.exec('UPDATE artifacts SET archived=1 WHERE id=?',a.id);store.audit(a.projectId,a.id,u.name,'artifact.archived');collab.notify(a.projectId,a.id);return {ok:true};});
  app.get<{Params:{id:string}}>('/api/artifacts/:id/history',async req=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id);return {revisions:store.all('SELECT version,actor,created_at AS createdAt FROM revisions WHERE artifact_id=? ORDER BY version DESC LIMIT 200',a.id),audit:store.all('SELECT id,artifact_id AS artifactId,actor,action,detail,created_at AS createdAt FROM audit WHERE artifact_id=? ORDER BY id DESC LIMIT 300',a.id)};});
  app.get<{Params:{id:string;version:string}}>('/api/artifacts/:id/history/:version',async req=>{store.artifact(req.params.id,auth.user(req).id);const r=store.one('SELECT version,content,actor,created_at AS createdAt FROM revisions WHERE artifact_id=? AND version=?',req.params.id,Number(req.params.version));if(!r)throw new HttpError(404,'Revision not found');return {...r,content:JSON.parse(r.content)};});
  app.post<{Params:{id:string}}>('/api/artifacts/:id/threads',async(req,reply)=>{
    const user=auth.user(req),a=store.artifact(req.params.id,user.id,'write'),b=parse(z.object({anchor:z.string().max(200).nullable(),quote:z.string().max(5000).default(''),body:z.string().trim().min(1).max(20000)}).strict(),req.body),tid=randomUUID();
    store.tx(()=>{store.exec('INSERT INTO threads(id,artifact_id,anchor,quote,created_at) VALUES(?,?,?,?,?)',tid,a.id,b.anchor,b.quote,stamp());store.message(user,a.id,tid,b.body);store.audit(a.projectId,a.id,user.name,'comment.created',b.quote.slice(0,200));});collab.notify(a.projectId,a.id);return reply.code(201).send({id:tid});
  });
  app.patch<{Params:{id:string;threadId:string}}>('/api/artifacts/:id/threads/:threadId',async req=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write'),b=parse(z.object({resolved:z.boolean()}).strict(),req.body);if(store.exec('UPDATE threads SET resolved=? WHERE id=? AND artifact_id=?',b.resolved?1:0,req.params.threadId,a.id).changes!==1)throw new HttpError(404,'Discussion not found');store.audit(a.projectId,a.id,u.name,b.resolved?'comment.resolved':'comment.reopened',req.params.threadId);collab.notify(a.projectId,a.id);return {ok:true};});
  app.post<{Params:{id:string}}>('/api/artifacts/:id/messages',async(req,reply)=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write'),b=parse(z.object({threadId:id,body:z.string().trim().min(1).max(20000)}).strict(),req.body);const m=store.message(u,a.id,b.threadId,b.body);collab.notify(a.projectId,a.id);return reply.code(201).send(m);});
  app.post<{Params:{id:string}}>('/api/artifacts/:id/agent',async req=>{const u=auth.user(req),b=parse(z.object({threadId:id,intent:z.enum(['chat','edit','research']),brief:z.string().max(2000).optional()}).strict(),req.body);await agent.respond(u,req.params.id,b.threadId,b.intent,b.brief);return {ok:true};});
  app.post<{Params:{id:string}}>('/api/artifacts/:id/agent/cancel',async req=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write');agent.active.get(a.id)?.abort();return {ok:true};});
  app.post<{Params:{id:string;messageId:string}}>('/api/artifacts/:id/proposals/:messageId/apply',async req=>{
    const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write'),m=store.messages(a.id).find(m=>m.id===req.params.messageId);if(!m?.proposal?.content)throw new HttpError(404,'Edit proposal not found');
    if(a.kind==='design'||a.kind==='document')throw new HttpError(400,'Document proposals use the dedicated document apply route');store.updateArtifact(u,a.id,m.proposal.version,m.proposal.content);store.exec('UPDATE messages SET proposal=NULL WHERE id=?',m.id);collab.notify(a.projectId,a.id);return {ok:true};
  });
  app.post<{Params:{id:string;messageId:string}}>('/api/artifacts/:id/proposals/:messageId/apply-document',async req=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write'),m=store.messages(a.id).find(m=>m.id===req.params.messageId);if(!m?.proposal?.content)throw new HttpError(404,'Edit proposal not found');collab.replace(a.id,u,m.proposal.content,m.proposal.version);store.exec('UPDATE messages SET proposal=NULL WHERE id=?',m.id);collab.notify(a.projectId,a.id);return {ok:true};});
  app.put<{Params:{id:string;decisionId:string}}>('/api/artifacts/:id/decisions/:decisionId',async req=>{
    const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write'),b=parse(z.object({title,context:z.string().max(20000),decision:z.string().max(20000),consequences:z.string().max(20000),status:z.enum(['proposed','accepted','superseded']),version:z.number().int().positive()}).strict(),req.body);
    store.tx(()=>{const previous=store.decisions(a.id).find(d=>d.id===req.params.decisionId);if(!previous)throw new HttpError(404,'ADR not found');if(store.exec('UPDATE decisions SET title=?,context=?,decision=?,consequences=?,status=?,version=version+1,author=?,updated_at=? WHERE id=? AND artifact_id=? AND version=?',b.title,b.context,b.decision,b.consequences,b.status,u.name,stamp(),req.params.decisionId,a.id,b.version).changes!==1)throw new HttpError(409,'The ADR changed. Reload before saving.');store.audit(a.projectId,a.id,u.name,'decision.updated',JSON.stringify({previous,next:b}));});collab.notify(a.projectId,a.id);return {ok:true};
  });
  app.post<{Params:{id:string}}>('/api/artifacts/:id/links',async req=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write'),b=parse(z.object({label:title,url:z.url().max(2000).refine(s=>s.startsWith('https://')),kind:z.enum(['pull-request','issue','test','reference'])}).strict(),req.body);store.exec('INSERT INTO links VALUES(?,?,?,?,?,?,?)',randomUUID(),a.id,b.label,b.url,b.kind,'unknown',stamp());store.audit(a.projectId,a.id,u.name,'link.added',b.url);collab.notify(a.projectId,a.id);return {ok:true};});
  app.post<{Params:{id:string;linkId:string}}>('/api/artifacts/:id/links/:linkId/refresh',async req=>{
    const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write'),link=store.one('SELECT * FROM links WHERE id=? AND artifact_id=?',req.params.linkId,a.id);const m=link?.url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/);if(!m)throw new HttpError(400,'Only GitHub pull requests support automatic state refresh');
    const response=await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls/${m[3]}`,{headers:{Accept:'application/vnd.github+json','User-Agent':'ai-bdd-studio'},signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)throw new HttpError(502,'GitHub could not return this pull request. Public repository access is required.');const pr=await response.json() as any;
    store.exec('UPDATE links SET state=?,updated_at=? WHERE id=?',pr.merged?'merged':pr.state,stamp(),link.id);store.audit(a.projectId,a.id,u.name,'link.refreshed',link.url);collab.notify(a.projectId,a.id);return {ok:true};
  });
  app.delete<{Params:{id:string;linkId:string}}>('/api/artifacts/:id/links/:linkId',async req=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write');store.exec('DELETE FROM links WHERE id=? AND artifact_id=?',req.params.linkId,a.id);collab.notify(a.projectId,a.id);return {ok:true};});
  app.post<{Params:{id:string}}>('/api/artifacts/:id/files',async(req,reply)=>{
    const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write'),part=await req.file();if(!part)throw new HttpError(400,'Choose a file');const bytes=await part.toBuffer();
    let mime='';if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';else if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')mime='image/webp';else if(bytes.toString('ascii',0,4)==='wOF2')mime='font/woff2';
    if(!mime)throw new HttpError(400,'Supported uploads: PNG, JPEG, WebP, and WOFF2');const fid=randomUUID();store.exec('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)',fid,a.projectId,a.id,part.filename.slice(0,200),mime,hash(bytes),bytes,stamp());store.audit(a.projectId,a.id,u.name,'file.uploaded',part.filename.slice(0,200));return reply.code(201).send({id:fid,url:`/api/files/${fid}`,mime,sha256:hash(bytes)});
  });
  app.get<{Params:{id:string}}>('/api/files/:id',async(req,reply)=>{const u=auth.user(req),file=store.one('SELECT * FROM files WHERE id=?',req.params.id);if(!file)throw new HttpError(404,'File not found');store.role(file.project_id,u.id);return reply.type(file.mime).header('Content-Disposition','inline; filename="asset"').header('X-Content-Type-Options','nosniff').send(Buffer.from(file.bytes));});
  app.get<{Params:{id:string}}>('/api/artifacts/:id/export',async(req,reply)=>{const a=store.artifact(req.params.id,auth.user(req).id);return reply.header('Content-Disposition',`attachment; filename="artifact-${a.id}.json"`).send({schemaVersion:1,artifact:a,decisions:store.decisions(a.id),threads:store.threads(a.id),messages:store.messages(a.id),links:store.all('SELECT label,url,kind,state FROM links WHERE artifact_id=?',a.id)});});
  app.post<{Params:{id:string}}>('/api/artifacts/:id/compile',async req=>runner.compile(auth.user(req),req.params.id));
  app.get<{Params:{id:string}}>('/api/artifacts/:id/plans',async req=>runner.plans(auth.user(req),req.params.id));
  app.post<{Params:{id:string}}>('/api/artifacts/:id/review',async req=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write'),b=parse(z.object({target:z.string().min(1).max(1000),action:z.enum(['accept','reject','pin','unpin'])}).strict(),req.body);await runner.review(u,a.id,b.target,b.action);store.audit(a.projectId,a.id,u.name,'tests.reviewed',b.target+': '+b.action);collab.notify(a.projectId,a.id);return {ok:true};});
  app.post<{Params:{id:string}}>('/api/artifacts/:id/runs',async(req,reply)=>reply.code(202).send(await runner.run(auth.user(req),req.params.id)));
  app.post<{Params:{id:string}}>('/api/artifacts/:id/runs/cancel',async req=>{const u=auth.user(req),a=store.artifact(req.params.id,u.id,'write');runner.active.get(a.id)?.abort();return {ok:true};});
  app.get<{Params:{id:string;runId:string;evidenceId:string}}>('/api/artifacts/:id/runs/:runId/evidence/:evidenceId',async(req,reply)=>{const result=await runner.evidence(auth.user(req),req.params.id,req.params.runId,decodeURIComponent(req.params.evidenceId));return reply.type(result.mime).header('Content-Disposition','attachment; filename="evidence"').send(result.bytes);});
  collab.routes(app);
  const clientDir=options.clientDir??resolve(import.meta.dirname,'../client');
  if(existsSync(resolve(clientDir,'index.html'))){await app.register(fastifyStatic,{root:clientDir});app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'Route not found'}):reply.sendFile('index.html'));}
  app.addHook('onClose',async()=>{agent.close();await runner.close();collab.close();store.close();});
  return {app,store,auth,collab,runner,agent};
}
