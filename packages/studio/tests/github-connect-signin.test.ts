import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { getVercelOidcTokenSync } from '@vercel/oidc';
import { getTokenResponse } from '@vercel/connect';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Auth, settingsFromEnv } from '../server/auth.ts';
import { Store } from '../server/store.ts';
import { VercelConnectGitHubSignInProvider, githubSignInConnectorFromEnv } from '../server/github-connect-signin.ts';
import { githubCodeChallenge } from '../server/github-signin.ts';
import { NativeIdentityExecutionContext } from '../server/hosting/native-identity-context.ts';
import { createIdentityLeaseHandler, PrivateIdentityLeaseClient, type IdentityScope } from '../server/hosting/identity-lease.ts';
import type { GitHubSignInDiagnostic, GitHubSignInObserver } from '../server/github-signin-diagnostics.ts';

const connector='github/owned-signin-fixture', connectorId='scl_SigninFixture', issuer='https://connect.vercel.com';
const nativeSymbol=Symbol.for('@vercel/request-context');
const platform=globalThis as typeof globalThis & {[key:symbol]:any};
let previous: PropertyDescriptor|undefined;
let nativeKeys:Awaited<ReturnType<typeof generateKeyPair>>, connectKeys:Awaited<ReturnType<typeof generateKeyPair>>;
let nativeJwk:Awaited<ReturnType<typeof exportJWK>>, connectJwk:Awaited<ReturnType<typeof exportJWK>>;
const cleanup:(()=>Promise<unknown>)[]=[];
beforeAll(async()=>{
  nativeKeys=await generateKeyPair('RS256');connectKeys=await generateKeyPair('RS256');
  nativeJwk={...await exportJWK(nativeKeys.publicKey),kid:'native-fixture',alg:'RS256',use:'sig'};
  connectJwk={...await exportJWK(connectKeys.publicKey),kid:'connect-fixture',alg:'RS256',use:'sig'};
});
beforeEach(()=>{
  for(const name of ['VERCEL_OIDC_TOKEN','VERCEL_OIDC_TOKEN_FILE','VERCEL_REGION'])vi.stubEnv(name,undefined);
  vi.stubEnv('NODE_ENV','production');
  previous=Object.getOwnPropertyDescriptor(platform,nativeSymbol);
  Object.defineProperty(platform,nativeSymbol,{configurable:true,value:{get:()=>({headers:{}})}});
});
afterEach(async()=>{
  for(const close of cleanup.splice(0).reverse())await close();
  if(previous)Object.defineProperty(platform,nativeSymbol,previous);else delete platform[nativeSymbol];
  vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();
  vi.useRealTimers();
});
const scope:IdentityScope={ownerId:'team_Fixture',ownerSlug:'fixture-team',projectId:'prj_Fixture',projectName:'fixture-project',environment:'preview',deploymentId:'dpl_Fixture',issuer:'https://oidc.vercel.com/fixture-team',audience:'https://vercel.com/fixture-team'};
type Fault='signature'|'issuer'|'audience'|'nonce'|'missing-id-token'|'userinfo-sub'|'unverified'|'different-github-email'|'different-connector'|'foreign-discovery'|'oversized-token'|'wrong-service'|'provider-error';
async function fixture(fault?:Fault){
  let leaseCalls=0, expectedNonce='', expectedChallenge=githubCodeChallenge('v'.repeat(43)), tokenRequests=0, providerTokenRequests=0, githubRequests=0;
  const nativeTokenIds:string[]=[], protectedTokenIds:string[]=[], requests:{url:string;options:RequestInit}[]=[];
  const nativeFetch:typeof fetch=async(input,init)=>{
    if(String(input)==='https://oidc.vercel.com/.well-known/jwks')return Response.json({keys:[nativeJwk]});
    if(String(input)==='http://identity.fixture/internal/identity/lease')return handler(new Request(input,init));
    throw new Error('Unexpected owned identity URL');
  };
  const handler=createIdentityLeaseHandler({scope,secret:'owned-fixture-sidecar-secret-32-characters',fetch:nativeFetch,getToken:async()=>{
    const jti='identity-'+(++leaseCalls);nativeTokenIds.push(jti);
    return new SignJWT({owner:scope.ownerSlug,owner_id:scope.ownerId,project:scope.projectName,project_id:scope.projectId,environment:scope.environment,deployment_id:scope.deploymentId,jti})
      .setProtectedHeader({alg:'RS256',kid:'native-fixture',typ:'JWT'}).setIssuer(scope.issuer).setAudience(scope.audience)
      .setSubject(`owner:${scope.ownerSlug}:project:${scope.projectName}:environment:${scope.environment}`)
      .setIssuedAt().setNotBefore('0s').setExpirationTime('2h').sign(nativeKeys.privateKey);
  }});
  const client=new PrivateIdentityLeaseClient({scope,bindingUrl:'http://identity.fixture',secret:'owned-fixture-sidecar-secret-32-characters',fetch:nativeFetch});
  const context=new NativeIdentityExecutionContext({acquire:()=>client.acquire()});
  async function assertProjectCredential(header:string,basic=false){
    let token=header.slice(7);
    if(basic){
      expect(header.startsWith('Basic ')).toBe(true);
      const values=Buffer.from(header.slice(6),'base64').toString().split(':');
      expect(decodeURIComponent(values[0]!)).toBe(connector);token=decodeURIComponent(values[1]!);
    }else expect(header.startsWith('Bearer ')).toBe(true);
    expect(getVercelOidcTokenSync()).toBe(token);
    const {payload}=await jwtVerify(token,nativeKeys.publicKey,{issuer:scope.issuer,audience:scope.audience});
    expect(payload.project_id).toBe(scope.projectId);expect(payload.environment).toBe('preview');
    protectedTokenIds.push(String(payload.jti));
  }
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,options:RequestInit={})=>{
    const url=String(input);requests.push({url,options});
    const headers=new Headers(options.headers);
    if(url==='https://api.vercel.com/v1/connect/connectors/'+encodeURIComponent(connector)){
      await assertProjectCredential(headers.get('authorization')!);
      return Response.json({id:connectorId,uid:connector,name:'Owned sign-in fixture',type:'github',service:fault==='wrong-service'?'slack':'github',createdAt:1,updatedAt:1,data:{}});
    }
    if(url===issuer+'/.well-known/openid-configuration')return Response.json({issuer,authorization_endpoint:issuer+'/oauth/authorize',token_endpoint:fault==='foreign-discovery'?'https://attacker.invalid/oauth/token':issuer+'/oauth/token',userinfo_endpoint:issuer+'/oauth/userinfo',jwks_uri:issuer+'/.well-known/jwks',response_types_supported:['code'],subject_types_supported:['pairwise'],id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['client_secret_post']});
    if(url===issuer+'/.well-known/jwks')return Response.json({keys:[connectJwk]});
    if(url===issuer+'/oauth/token'){
      tokenRequests++;await assertProjectCredential(headers.get('authorization')!,true);
      expect(options.redirect).toBe('error');
      const body=new URLSearchParams(String(options.body));
      expect(body.get('grant_type')).toBe('authorization_code');expect(githubCodeChallenge(body.get('code_verifier')!)).toBe(expectedChallenge);
      expect(body.get('redirect_uri')).toBe('https://studio.fixture.test/api/auth/github/callback');
      if(fault==='provider-error')return Response.json({error:'secret-provider-description',access_token:'secret-token'}, {status:401});
      if(fault==='oversized-token')return new Response('x'.repeat(65537));
      let jwt=await new SignJWT({nonce:fault==='nonce'?'another-nonce':expectedNonce})
        .setProtectedHeader({alg:'RS256',kid:'connect-fixture'}).setIssuer(fault==='issuer'?'https://attacker.invalid':issuer)
        .setAudience(fault==='audience'?'another-connector':connector).setSubject('opaque-connect-subject')
        .setIssuedAt().setExpirationTime('2m').sign(connectKeys.privateKey);
      if(fault==='signature'){
        const parts=jwt.split('.');parts[2]=(parts[2]![0]==='A'?'B':'A')+parts[2]!.slice(1);jwt=parts.join('.');
      }
      return Response.json({access_token:'connect-oauth-session-token',token_type:'Bearer',expires_in:120,...(fault==='missing-id-token'?{}:{id_token:jwt})});
    }
    if(url===issuer+'/oauth/userinfo'){
      expect(headers.get('authorization')).toBe('Bearer connect-oauth-session-token');
      return Response.json({sub:fault==='userinfo-sub'?'another-subject':'opaque-connect-subject',email:'owner@example.test',email_verified:fault!=='unverified',name:'Connect account'});
    }
    if(url==='https://api.vercel.com/v1/connect/token/'+encodeURIComponent(connector)){
      providerTokenRequests++;await assertProjectCredential(headers.get('authorization')!);
      expect(JSON.parse(String(options.body))).toEqual({subject:{type:'token',token:'connect-oauth-session-token'},scopes:['user:email']});
      return Response.json({token:'github-user-token-fixture',expiresAt:Date.now()+120000,connector:{id:fault==='different-connector'?'scl_Another':connectorId,uid:connector,type:'github'}});
    }
    if(url==='https://api.github.com/user'){
      githubRequests++;expect(headers.get('authorization')).toBe('Bearer github-user-token-fixture');
      return Response.json({id:12345,login:'owned-github',name:'Actual GitHub name'});
    }
    if(url==='https://api.github.com/user/emails?per_page=100'){
      githubRequests++;return Response.json([{email:fault==='different-github-email'?'different@example.test':'owner@example.test',verified:true,primary:false},{email:'not-verified@example.test',verified:false,primary:true}]);
    }
    throw new Error('Unexpected owned fixture URL');
  }));
  const provider=new VercelConnectGitHubSignInProvider(connector,context);
  const input={state:'s'.repeat(43),nonce:'n'.repeat(43),codeChallenge:githubCodeChallenge('v'.repeat(43)),redirectUri:'https://studio.fixture.test/api/auth/github/callback'};
  expectedNonce=input.nonce;
  return {provider,input,context,requests,nativeTokenIds,protectedTokenIds,
    setAuthorization:(url:URL)=>{expectedNonce=url.searchParams.get('nonce')!;expectedChallenge=url.searchParams.get('code_challenge')!;},
    counts:()=>({leaseCalls,tokenRequests,providerTokenRequests,githubRequests}),
    authenticate:(onDiagnostic?:GitHubSignInObserver)=>provider.authenticate({code:'owned-code',state:input.state,nonce:input.nonce,verifier:'v'.repeat(43),redirectUri:input.redirectUri,onDiagnostic})};
}
describe('official Vercel Connect GitHub sign-in adapter',()=>{
  it.each(['missing-id-token','nonce','signature','userinfo-sub','unverified','different-github-email','provider-error'] as Fault[])('diagnoses %s using finite stages and token shape without identity, token or provider text',async fault=>{
    const f=await fixture(fault),events:GitHubSignInDiagnostic[]=[];
    await expect(f.authenticate(event=>{events.push(event);})).rejects.toThrow();
    const token=events.find(event=>event.stage==='token-response');
    expect(token).toMatchObject({stage:'token-response',idTokenPresent:!['missing-id-token','provider-error'].includes(fault),accessTokenPresent:true,tokenTypeBearer:fault!=='provider-error'});
    const stage=['userinfo-sub','unverified'].includes(fault)?'userinfo':fault==='different-github-email'?'email-match':'token-exchange';
    expect(events.some(event=>event.stage===stage&&event.state==='failure')).toBe(true);
    if(fault==='nonce')expect(events.find(event=>event.stage==='token-exchange'&&event.state==='failure')).toMatchObject({errorCode:'OAUTH_JWT_CLAIM_COMPARISON_FAILED',claim:'nonce'});
    const json=JSON.stringify(events);
    for(const value of ['connect-oauth-session-token','secret-provider-description','owned-code','opaque-connect-subject','owner@example.test','github-user-token-fixture',f.input.state,f.input.nonce,'eyJ'])expect(json).not.toContain(value);
    expect(events.every(event=>event.elapsedMs>=0&&event.elapsedMs<=2147483647)).toBe(true);
    if(fault!=='different-github-email')expect(f.counts().providerTokenRequests).toBe(0);
  });
  it('uses project-scoped SDK OAuth, verifies signed identity and returns actual numeric GitHub identity without a static app secret',async()=>{
    const f=await fixture(),url=new URL(await f.provider.authorizationUrl(f.input));
    expect(url.origin+url.pathname).toBe(issuer+'/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(connector);
    expect(url.searchParams.get('state')).toBe(f.input.state);expect(url.searchParams.get('nonce')).toBe(f.input.nonce);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile email user:email offline_access');
    expect(url.searchParams.get('teamId')).toBe(scope.ownerId);expect(url.searchParams.get('projectId')).toBe(scope.projectId);
    expect(url.searchParams.get('environment')).toBe('preview');
    expect(url.href).not.toContain('eyJ');
    expect(await f.authenticate()).toEqual({id:'12345',login:'owned-github',name:'Actual GitHub name',verifiedEmails:['owner@example.test']});
    expect(f.counts()).toMatchObject({tokenRequests:1,providerTokenRequests:1,githubRequests:2});
    expect(new Set(f.protectedTokenIds).size).toBe(f.protectedTokenIds.length);
    expect(f.counts().leaseCalls).toBeGreaterThan(f.protectedTokenIds.length);
    expect(()=>getVercelOidcTokenSync()).toThrow();
    await expect(getTokenResponse(connector,{subject:{type:'token',token:'connect-oauth-session-token'},scopes:['user:email']})).rejects.toThrow();
  });
  it.each(['signature','issuer','audience','nonce','userinfo-sub','unverified','different-github-email','different-connector','oversized-token','provider-error'] as Fault[])('rejects %s without publishing a Studio session or provider error',async fault=>{
    const f=await fixture(fault);
    await f.provider.authorizationUrl(f.input);
    await expect(f.authenticate()).rejects.not.toThrow('secret-provider-description');
    if(['signature','issuer','audience','nonce','userinfo-sub','unverified','oversized-token','provider-error'].includes(fault))expect(f.counts().providerTokenRequests).toBe(0);
    expect(()=>getVercelOidcTokenSync()).toThrow();
  });
  it.each(['wrong-service','foreign-discovery'] as Fault[])('refuses %s before returning a browser authorization URL',async fault=>{
    const f=await fixture(fault);
    await expect(f.provider.authorizationUrl(f.input)).rejects.toThrow();
    expect(f.counts().tokenRequests).toBe(0);
    expect(f.requests.some(request=>request.url.startsWith('https://attacker.invalid'))).toBe(false);
  });
  it('validates connector configuration and permits Connect-only production configuration',()=>{
    expect(githubSignInConnectorFromEnv({STUDIO_GITHUB_SIGNIN_CONNECTOR:connector})).toBe(connector);
    expect(()=>githubSignInConnectorFromEnv({STUDIO_GITHUB_SIGNIN_CONNECTOR:'slack/unrelated'})).toThrow();
    expect(()=>settingsFromEnv({NODE_ENV:'production',STUDIO_ORIGIN:'https://studio.fixture.test',STUDIO_GITHUB_SIGNIN_CONNECTOR:connector})).not.toThrow();
    expect(settingsFromEnv({NODE_ENV:'production',STUDIO_ORIGIN:'https://studio.fixture.test',STUDIO_GITHUB_SIGNIN_CONNECTOR:connector,STUDIO_GITHUB_SIGNIN_CLIENT_ID:'unused-direct-id'}).githubSignIn).toBeUndefined();
  });
  it('fails closed when the validated identity broker refuses the operation',async()=>{
    const f=await fixture(),provider=new VercelConnectGitHubSignInProvider(connector,{run:async()=>{throw new Error('private-identity-denied');}});
    await expect(provider.authorizationUrl(f.input)).rejects.toMatchObject({statusCode:503});
    expect(f.requests).toHaveLength(0);
  });
  it('discards a late SDK result after its deadline and evicts the resulting temporary credential cache',async()=>{
    const f=await fixture(), original=globalThis.fetch;
    let release!:()=>void, entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}), ready=new Promise<void>(resolve=>{entered=resolve;});
    vi.stubGlobal('fetch',async(input:string|URL|Request,options?:RequestInit)=>{
      const response=await original(input,options);
      if(String(input)==='https://api.vercel.com/v1/connect/token/'+encodeURIComponent(connector)){
        entered();await gate;
      }
      return response;
    });
    vi.useFakeTimers();
    const pending=f.authenticate(), refused=expect(pending).rejects.toMatchObject({statusCode:503});
    await ready;
    await vi.advanceTimersByTimeAsync(15001);
    await refused;
    expect(()=>getVercelOidcTokenSync()).toThrow();
    release();await vi.runAllTimersAsync();
    expect(f.counts().githubRequests).toBe(0);
    await expect(getTokenResponse(connector,{subject:{type:'token',token:'connect-oauth-session-token'},scopes:['user:email']})).rejects.toThrow();
  });
  it('preserves SQL state/PKCE/nonce and GitHub provenance in the existing Auth callback workflow',async()=>{
    const f=await fixture(),store=await Store.open(':memory:'),app=Fastify();
    await app.register(cookie);
    const auth=new Auth(store,{production:true,origin:'https://studio.fixture.test',dataDir:'/tmp/studio-connect-auth',demo:false,adminEmail:'owner@example.test',githubSignInConnector:connector},f.context);
    await auth.initialize();await auth.routes(app);cleanup.push(()=>store.close(),()=>app.close());
    const start=await app.inject('/api/auth/github'),url=new URL(String(start.headers.location));
    expect(start.statusCode).toBe(302);f.setAuthorization(url);
    const binding=start.cookies.find(value=>value.name==='studio_github_signin')!.value;
    const callback={url:'/api/auth/github/callback?'+new URLSearchParams({state:url.searchParams.get('state')!,code:'opaque.code~with+symbols'}),headers:{cookie:'studio_github_signin='+binding}};
    const response=await app.inject(callback);expect(response.headers.location).toBe('/');
    const session=response.cookies.find(value=>value.name==='studio_session')!.value;
    expect((await app.inject({url:'/api/me',headers:{cookie:'studio_session='+session}})).statusCode).toBe(200);
    expect((await app.inject(callback)).headers.location).toBe('/?signin=failed');
    expect((await store.one('SELECT COUNT(*) AS n FROM github_signin_sessions')).n).toBe(1);
    expect((await store.one('SELECT github_id FROM github_signin_identities')).github_id).toBe('12345');
  });
});
