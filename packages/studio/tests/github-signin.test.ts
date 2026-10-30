import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.ts';
import { Auth, passwordHash, settingsFromEnv, type Settings } from '../server/auth.ts';
import { Store, hash } from '../server/store.ts';
import { GitHubOAuthSignInProvider, githubCodeChallenge } from '../server/github-signin.ts';
import { githubSignIn, injectedGitHub } from './identity/github-signin-inject-fixture.ts';
import { client, testSettings } from './helpers.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(override: Partial<Settings> = {}) {
  const store = await Store.open(':memory:'), app = Fastify();
  await app.register(cookie);
  const settings: Settings = { production: true, origin: 'https://studio.example.test', dataDir: '/tmp/studio-github-auth', demo: false, adminEmail: 'owner@example.test', githubSignInProvider: injectedGitHub, ...override };
  const auth = new Auth(store, settings);
  await auth.initialize();
  await auth.routes(app);
  app.setErrorHandler((error, _req, reply) => reply.code((error as any).statusCode ?? 500).send({ error: (error as Error).message }));
  cleanup.push(() => store.close(), () => app.close());
  return { app, store, auth, settings };
}
async function start(app: Awaited<ReturnType<typeof fixture>>['app'], email = 'owner@example.test', identity = {}) {
  const response = await app.inject('/api/auth/github');
  expect(response.statusCode).toBe(302);
  const binding = response.cookies.find(value => value.name === 'studio_github_signin')!.value;
  const grant = injectedGitHub.issue(String(response.headers.location), email, identity);
  const url = '/api/auth/github/callback?' + new URLSearchParams(grant);
  return { response, binding, grant, url, callback: () => app.inject({ url, headers: { cookie: 'studio_github_signin=' + binding } }) };
}
describe('GitHub-only browser authentication', () => {
  it('advertises only GitHub, ignores historical password/OIDC/demo settings and bootstraps only after GitHub verification', async () => {
    const { app, store } = await fixture({ adminPassword: 'unused-legacy-bootstrap-password', oidcIssuer: 'https://issuer.example.test', demo: true });
    expect((await app.inject('/api/auth/status')).json()).toEqual({ setup: false, demo: false, oidc: false, github: true, password: false });
    expect((await store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(0);
    for (const route of ['/api/auth/setup', '/api/auth/login', '/api/auth/demo']) {
      const response = await app.inject({ method: 'POST', url: route, payload: { email: 'owner@example.test', password: 'unused-legacy-bootstrap-password' } });
      expect(response.statusCode).toBe(403);
      expect(response.cookies.some(value => value.name === 'studio_session')).toBe(false);
    }
    expect((await app.inject('/api/auth/oidc')).statusCode).toBe(404);
    expect((await app.inject('/api/auth/callback?code=old')).statusCode).toBe(404);
    const session = await githubSignIn(app);
    expect((await store.userByEmail(session.user.email)).password).toBeNull();
    expect(String(session.response.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(session.response.headers['set-cookie'])).toContain('SameSite=Strict');
    expect(String(session.response.headers['set-cookie'])).toContain('Secure');
    expect(await store.one('SELECT token FROM sessions WHERE token=?', session.cookie)).toBeUndefined();
    expect(await store.one('SELECT token FROM github_signin_sessions WHERE token=?', hash(session.cookie))).toBeDefined();
  });
  it('rejects legacy password-created cookies while preserving explicitly scoped API bearer credentials', async () => {
    const { app, store } = await fixture();
    const user = await store.createUser('owner@example.test', 'Existing owner', await passwordHash('valid-legacy-password-only'));
    const legacy = randomBytes(32).toString('base64url'), api = randomBytes(32).toString('base64url');
    await store.exec("INSERT INTO sessions VALUES(?,?,?,'session')", hash(legacy), user.id, Date.now() + 60000);
    await store.exec("INSERT INTO sessions VALUES(?,?,?,'api')", hash(api), user.id, Date.now() + 60000);
    expect((await app.inject({url:'/api/me',headers:{cookie:'studio_session='+legacy}})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/me',headers:{authorization:'Bearer '+api}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:'/api/auth/login',payload:{email:user.email,password:'valid-legacy-password-only'}})).statusCode).toBe(403);
    const actual = await githubSignIn(app);
    expect(actual.user.id).not.toBe(user.id);
    expect((await app.inject({url:'/api/me',headers:{cookie:'studio_session='+legacy}})).statusCode).toBe(401);
    await store.exec('DELETE FROM sessions WHERE token=?', hash(actual.cookie));
    expect((await app.inject({url:'/api/me',headers:{cookie:'studio_session='+actual.cookie}})).statusCode).toBe(401);
    expect(await store.one('SELECT token FROM github_signin_sessions WHERE token=?', hash(actual.cookie))).toBeUndefined();
  });
  it('requires the bound browser and state, consumes the challenge once and rejects replay', async () => {
    const { app, store } = await fixture(), grant = await start(app);
    expect(grant.response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(grant.response.headers['set-cookie']).toContain('Path=/api/auth/github');
    for (const headers of [{}, {cookie:'studio_github_signin='+randomBytes(32).toString('base64url')}]) {
      const denied = await app.inject({url:grant.url,headers});
      expect(denied.headers.location).toBe('/?signin=failed');
      expect(denied.cookies.some(value=>value.name==='studio_session')).toBe(false);
    }
    const changed = await app.inject({url:grant.url.replace(grant.grant.state,'wrong-state'),headers:{cookie:'studio_github_signin='+grant.binding}});
    expect(changed.headers.location).toBe('/?signin=failed');
    const accepted = await grant.callback();
    expect(accepted.headers.location).toBe('/');
    expect((await grant.callback()).headers.location).toBe('/?signin=failed');
    expect((await store.one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(1);
    expect((await store.one('SELECT COUNT(*) AS n FROM identity_challenges')).n).toBe(0);
  });
  it('rejects expired challenges, denied grants and provider errors without leaking details', async () => {
    const { app, store } = await fixture(), expired = await start(app);
    await store.exec('UPDATE identity_challenges SET expires_at=?', Date.now() - 1);
    expect((await expired.callback()).headers.location).toBe('/?signin=failed');
    const denied = await start(app);
    const result = await app.inject({url:denied.url+'&error=access_denied&error_description=secret-provider-detail',headers:{cookie:'studio_github_signin='+denied.binding}});
    expect(result.headers.location).toBe('/?signin=failed');
    expect(JSON.stringify(result.headers)+result.body).not.toContain('secret-provider-detail');
    expect((await denied.callback()).headers.location).toBe('/?signin=failed');
    expect((await store.one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(0);
  });
  it('preserves an existing exact GitHub binding regardless of optional email metadata', async () => {
    const { app, store } = await fixture();
    const invited = await store.createUser('work@example.test','Invited teammate',null);
    await store.exec('INSERT INTO github_signin_identities(github_id,user_id,created_at) VALUES(?,?,?)','123456',invited.id,Date.now());
    const response = await githubSignIn(app,'private@example.test',{id:'123456',verifiedEmails:[]});
    expect(response.user.id).toBe(invited.id);
    expect((await store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(1);
    const link = await store.one('SELECT github_id,user_id FROM github_signin_identities');
    const changedEmail = await githubSignIn(app,'new@example.test',{id:link.github_id,verifiedEmails:['new@example.test']});
    expect(changedEmail.user.id).toBe(invited.id);
    expect((await store.userByEmail('work@example.test')).id).toBe(invited.id);
  });
  it('automatically provisions each genuine GitHub account without claiming an email-matched local account', async () => {
    const { app, store } = await fixture({adminEmail:undefined});
    const legacy=await store.createUser('first@example.test','Legacy account',null);
    const first=await githubSignIn(app,'first@example.test',{id:'1001',verifiedEmails:[]});
    const second=await githubSignIn(app,'first@example.test',{id:'2002',verifiedEmails:['first@example.test']});
    expect(first.user.id).not.toBe(legacy.id);expect(second.user.id).not.toBe(legacy.id);expect(second.user.id).not.toBe(first.user.id);
    expect(first.user.email).toMatch(/@identity\.invalid$/);expect(second.user.email).toMatch(/@identity\.invalid$/);
    expect((await store.one('SELECT COUNT(*) AS n FROM github_signin_identities')).n).toBe(2);
  });
  it('fails closed without a configured provider even when historical credentials exist', async () => {
    const { app } = await fixture({githubSignInProvider:undefined,adminPassword:'legacy-unused-password'});
    expect((await app.inject('/api/auth/status')).json().github).toBe(false);
    expect((await app.inject('/api/auth/github')).statusCode).toBe(503);
    expect((await app.inject({method:'POST',url:'/api/auth/login',payload:{password:'legacy-unused-password'}})).statusCode).toBe(403);
    expect(()=>settingsFromEnv({NODE_ENV:'production',STUDIO_ORIGIN:'https://studio.example.test',STUDIO_ADMIN_PASSWORD:'legacy-unused-password'})).toThrow('GitHub sign-in client bindings');
    expect(()=>settingsFromEnv({STUDIO_GITHUB_SIGNIN_CLIENT_ID:'client-only'})).toThrow('GitHub sign-in requires');
  });
  it('refuses password creation for an automatically provisioned signed-in account', async () => {
    const directory = await mkdtemp(join(tmpdir(),'studio-github-invites-'));
    const instance = await createApp(testSettings(directory),{db:':memory:'});
    cleanup.push(()=>rm(directory,{recursive:true,force:true}),()=>instance.app.close());
    const owner = await githubSignIn(instance.app), request = client(instance.app,owner.cookie);
    const disabled = await request('POST','/api/me/password',{current:'any-old-password',password:'new-password-long-enough'});
    expect(disabled.statusCode).toBe(403);
    expect((await instance.store.userByEmail(owner.user.email)).password).toBeNull();
  });
});
describe('fixed GitHub sign-in provider transport',()=>{
  const configuration = {clientId:'owned-app-id',clientSecret:'owned-app-secret'};
  it('uses S256 and a fixed callback to authenticate the numeric account without fetching private email',async()=>{
    const provider = new GitHubOAuthSignInProvider(configuration), verifier='x'.repeat(43), redirectUri='https://studio.example.test/api/auth/github/callback';
    const url=new URL(provider.authorizationUrl({state:'s'.repeat(43),codeChallenge:githubCodeChallenge(verifier),redirectUri}));
    expect(url.origin+url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('read:user');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const calls: {url:string; options:RequestInit}[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
      calls.push({url,options});
      if(url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'fixture-access-token',token_type:'bearer'});
      if(url==='https://api.github.com/user')return Response.json({id:123,login:'owned-github',name:'Actual name',email:'untrusted-profile@example.test'});
      throw new Error('Sign-in must not fetch email endpoints');
    }));
    expect(await provider.authenticate({code:'code',verifier,redirectUri})).toEqual({kind:'github',id:'123',login:'owned-github',name:'Actual name',verifiedEmails:[]});
    expect(calls).toHaveLength(2);
    for(const call of calls)expect(call.options.redirect).toBe('error');
    const payload=new URLSearchParams(String(calls[0]!.options.body));
    expect(payload.get('code_verifier')).toBe(verifier);
    expect(payload.get('redirect_uri')).toBe(redirectUri);
    expect(calls[1]!.options.headers).toMatchObject({Authorization:'Bearer fixture-access-token'});
    expect(calls.map(call=>call.url).join(' ')).not.toContain('fixture-access-token');
  });
  it.each(['provider-error','invalid-profile','oversized','redirect','transport'])('refuses %s without exposing tokens or provider text',async(mode)=>{
    let calls=0;
    vi.stubGlobal('fetch',vi.fn(async()=>{
      calls++;
      if(mode==='transport'||mode==='redirect')throw new Error('secret-provider-detail');
      if(mode==='provider-error')return Response.json({error:'secret-provider-detail',access_token:'fixture-secret-token'});
      if(mode==='oversized')return new Response('x'.repeat(16385));
      if(calls===1)return Response.json({access_token:'fixture-secret-token',token_type:'bearer'});
      if(calls===2)return Response.json({id:'untrusted-identifier',login:'owned-github'});
      return Response.json([{email:'owner@example.test',verified:false}]);
    }));
    await expect(new GitHubOAuthSignInProvider(configuration).authenticate({code:'code',verifier:'x'.repeat(43),redirectUri:'https://studio.example.test/api/auth/github/callback'})).rejects.not.toThrow('secret-provider-detail');
  });
});
