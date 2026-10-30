import {afterEach,describe,expect,it} from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import {randomUUID} from 'node:crypto';
import {Auth} from '../server/auth.ts';
import type {ConnectGitHubSignInIdentity} from '../server/github-signin.ts';
import {Store} from '../server/store.ts';
import {openDatabase} from '../server/persistence/index.ts';
import {githubSignInResponse,injectedGitHub} from './identity/github-signin-inject-fixture.ts';

const cleanup:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const principal=(subject:string,email='owner@example.test',connectorId='scl_AdmissionFixture'):ConnectGitHubSignInIdentity=>({
  kind:'vercel-connect',issuer:'https://connect.vercel.com',connectorId,subject,name:'Managed GitHub actor',verifiedEmails:[email],
});
async function application(store:Store){
  const app=Fastify();await app.register(cookie);
  const auth=new Auth(store,{production:false,origin:'http://127.0.0.1:8897',dataDir:'/tmp/connect-admission',demo:false,githubSignInProvider:injectedGitHub});
  await auth.initialize();await auth.routes(app);
  app.setErrorHandler((error,_request,reply)=>reply.code((error as {statusCode?:number}).statusCode??500).send({error:'Unavailable'}));
  cleanup.push(()=>store.close(),()=>app.close());
  return {app,store};
}
async function me(app:Awaited<ReturnType<typeof application>>['app'],response:Awaited<ReturnType<typeof githubSignInResponse>>){
  const session=response.cookies.find(value=>value.name==='studio_session')?.value;
  expect(session).toBeTruthy();
  const result=await app.inject({url:'/api/me',headers:{cookie:'studio_session='+session}});
  expect(result.statusCode).toBe(200);return result.json();
}
describe('qualified managed GitHub identity admission',()=>{
  it('provisions without email or owner configuration, retains the exact principal and never claims a matching local account',async()=>{
    const {app,store}=await application(await Store.open(':memory:'));
    const invited=await store.createUser('owner@example.test','Existing invited user',null);
    const first=await githubSignInResponse(app,'owner@example.test',{...principal('opaque:unchanged'),verifiedEmails:undefined});
    const user=await me(app,first);expect(user.id).not.toBe(invited.id);expect(user.email).toMatch(/^[a-f0-9-]{36}@identity\.invalid$/);
    expect((await store.one('SELECT password FROM users WHERE id=?',user.id)).password).toBeNull();
    await store.createUser('changed@example.test','Another invited user',null);
    const changed=await githubSignInResponse(app,'changed@example.test',principal('opaque:unchanged','changed@example.test'));
    expect(changed.headers.location).toBe('/');expect((await me(app,changed)).id).toBe(user.id);
    expect((await store.one('SELECT COUNT(*) AS n FROM github_signin_identities')).n).toBe(0);
    expect(await store.one('SELECT issuer,connector_id,subject,user_id FROM github_connect_signin_identities')).toMatchObject({issuer:'https://connect.vercel.com',connector_id:'scl_AdmissionFixture',subject:'opaque:unchanged',user_id:user.id});
    for(const identity of [principal('another-principal'),principal('opaque:unchanged','owner@example.test','scl_AnotherConnector')]){
      const other=await githubSignInResponse(app,'owner@example.test',identity);
      expect((await me(app,other)).id).not.toBe(user.id);expect((await me(app,other)).id).not.toBe(invited.id);
    }
  });
  it('keeps equal opaque subjects in different connector namespaces distinct without moving either account',async()=>{
    const {app,store}=await application(await Store.open(':memory:'));
    const owner=await githubSignInResponse(app,'owner@example.test',principal('same-subject'));
    const secondUser=await store.createUser('teammate@example.test','Invited teammate',null);
    const second=await githubSignInResponse(app,'teammate@example.test',principal('same-subject','teammate@example.test','scl_SecondConnector'));
    expect((await me(app,second)).id).not.toBe(secondUser.id);
    expect((await me(app,owner)).id).not.toBe((await me(app,second)).id);
    expect((await store.one('SELECT COUNT(*) AS n FROM github_connect_signin_identities')).n).toBe(2);
  });
  it.each(['direct-first','managed-first'] as const)('refuses email-based cross-provider takeover (%s)',async order=>{
    const {app,store}=await application(await Store.open(':memory:'));
    const direct={id:'901'},managed=principal('managed-subject');
    const first=await githubSignInResponse(app,'owner@example.test',order==='direct-first'?direct:managed);
    expect(first.headers.location).toBe('/');
    const second=await githubSignInResponse(app,'owner@example.test',order==='direct-first'?managed:direct);
    expect(second.headers.location).toBe('/');expect((await me(app,first)).id).not.toBe((await me(app,second)).id);
    expect((await store.one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(2);
    expect((await store.one('SELECT COUNT(*) AS n FROM github_signin_identities')).n+(await store.one('SELECT COUNT(*) AS n FROM github_connect_signin_identities')).n).toBe(2);
  });
  it('rejects malformed principals before creating an account or publishing a cookie',async()=>{
    const {app,store}=await application(await Store.open(':memory:'));
    for(const identity of [
      {...principal('subject'),issuer:'https://attacker.invalid'} as unknown as ConnectGitHubSignInIdentity,
      principal('subject','owner@example.test','scl_unsafe/path'),principal('😀'.repeat(300)),principal('with\ncontrol'),principal('   '),
    ])expect((await githubSignInResponse(app,'owner@example.test',identity)).headers.location).toBe('/?signin=failed');
    expect((await store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(0);
    expect((await store.one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(0);
  });
  it('preserves existing exact bindings without granting new accounts any existing project role',async()=>{
    const {app,store}=await application(await Store.open(':memory:'));
    const existing=await store.createUser('owner@example.test','Existing owner',null),project=await store.createProject(existing,'Private project','');
    await store.exec('INSERT INTO github_connect_signin_identities(issuer,connector_id,subject,user_id,created_at) VALUES(?,?,?,?,?)','https://connect.vercel.com','scl_AdmissionFixture','existing-subject',existing.id,Date.now());
    const bound=await me(app,await githubSignInResponse(app,'irrelevant@example.test',{...principal('existing-subject'),verifiedEmails:[]}));expect(bound.id).toBe(existing.id);
    const fresh=await me(app,await githubSignInResponse(app,'owner@example.test',principal('new-subject')));expect(fresh.id).not.toBe(existing.id);
    expect(await store.projects(fresh.id)).toEqual([]);await expect(store.role(project.id,fresh.id,'read')).rejects.toThrow();await expect(store.role(project.id,fresh.id,'admin')).rejects.toThrow();
    const own=await store.createProject(fresh,'My project','');expect(await store.role(own.id,fresh.id,'admin')).toBe('owner');
    expect(await store.role(project.id,existing.id,'admin')).toBe('owner');
  });
});

describe.skipIf(!process.env.STUDIO_TEST_POSTGRES_URL)('real PostgreSQL cross-provider and managed binding races',()=>{
  async function pair(){
    const url=process.env.STUDIO_TEST_POSTGRES_URL!,schema='connect_admission_'+randomUUID().replaceAll('-','');
    return [await application(await Store.open(await openDatabase({adapter:'postgres',url,schema}))),await application(await Store.open(await openDatabase({adapter:'postgres',url,schema})))] as const;
  }
  it.each(['two-managed','mixed-providers'] as const)('provisions separate principals across instances without email-based merging (%s)',async scenario=>{
    const [first,second]=await pair();
    const responses=await Promise.all([
      githubSignInResponse(first.app,'owner@example.test',principal('first-subject')),
      githubSignInResponse(second.app,'owner@example.test',scenario==='two-managed'?principal('second-subject'):{id:'910'}),
    ]);
    expect(responses.filter(value=>value.headers.location==='/')).toHaveLength(2);
    expect((await first.store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(2);
    expect((await first.store.one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(2);
    expect((await first.store.one('SELECT COUNT(*) AS n FROM github_signin_identities')).n+(await first.store.one('SELECT COUNT(*) AS n FROM github_connect_signin_identities')).n).toBe(2);
    expect((await me(second.app,responses[0]!)).id).not.toBe((await me(second.app,responses[1]!)).id);
    await me(second.app,responses.find(value=>value.headers.location==='/')!);
  });
  it('creates one account for concurrent callbacks of the same qualified principal across instances',async()=>{
    const [first,second]=await pair();
    const responses=await Promise.all([
      githubSignInResponse(first.app,'owner@example.test',{...principal('stable-subject'),verifiedEmails:undefined}),
      githubSignInResponse(second.app,'owner@example.test',{...principal('stable-subject'),verifiedEmails:[]}),
    ]);
    expect(responses.every(value=>value.headers.location==='/')).toBe(true);
    const user=await me(second.app,responses[0]!);
    for(const response of responses)expect((await me(second.app,response)).id).toBe(user.id);
    expect((await first.store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(1);
    expect((await first.store.one('SELECT COUNT(*) AS n FROM github_connect_signin_identities')).n).toBe(1);
    expect((await first.store.one('SELECT COUNT(*) AS n FROM github_signin_sessions')).n).toBe(2);
    const changed=await githubSignInResponse(second.app,'changed@example.test',principal('stable-subject','changed@example.test'));
    expect((await me(first.app,changed)).id).toBe(user.id);
  });
});
