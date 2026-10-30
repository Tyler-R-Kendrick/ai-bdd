import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { getVercelOidcTokenSync } from '@vercel/oidc';
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
type Fault='id-token'|'signature'|'issuer'|'audience'|'expired'|'nonce'|'missing-access-token'|'short-access-token'|'dpop-token'|'unverified'|'missing-email'|'malformed-email'|'missing-sub'|'oversized-sub'|'userinfo-sub'|'different-email'|'foreign-discovery'|'oversized-token'|'oversized-userinfo'|'wrong-service'|'provider-error'|'userinfo-error';
async function fixture(fault?:Fault){
  let leaseCalls=0, expectedChallenge=githubCodeChallenge('v'.repeat(43)), tokenRequests=0, providerTokenRequests=0, githubRequests=0, userinfoRequests=0;
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
      let jwt=await new SignJWT(fault==='nonce'?{nonce:'unsolicited-nonce'}:{})
        .setProtectedHeader({alg:'RS256',kid:'connect-fixture'}).setIssuer(fault==='issuer'?'https://attacker.invalid':issuer)
        .setAudience(fault==='audience'?'another-connector':connector).setSubject('opaque-connect-subject')
        .setIssuedAt().setExpirationTime(fault==='expired'?Math.floor(Date.now()/1000)-300:'2m').sign(connectKeys.privateKey);
      if(fault==='signature'){
        const parts=jwt.split('.');parts[2]=(parts[2]![0]==='A'?'B':'A')+parts[2]!.slice(1);jwt=parts.join('.');
      }
      return Response.json({...(fault==='missing-access-token'?{}:{access_token:fault==='short-access-token'?'short':'connect-oauth-session-token'}),token_type:fault==='dpop-token'?'DPoP':'Bearer',expires_in:120,...(['id-token','signature','issuer','audience','expired','nonce','userinfo-sub'].includes(fault??'')?{id_token:jwt}:{})});
    }
    if(url===issuer+'/oauth/userinfo'){
      userinfoRequests++;
      expect(headers.get('authorization')).toBe('Bearer connect-oauth-session-token');
      expect(options.redirect).toBe('error');
      if(fault==='oversized-userinfo')return new Response('x'.repeat(65537));
      if(fault==='userinfo-error')return Response.json({error:'secret-provider-description'},{status:401});
      return Response.json({...(fault==='missing-sub'?{}:{sub:fault==='oversized-sub'?'😀'.repeat(300):fault==='userinfo-sub'?'another-opaque-subject':'opaque-connect-subject'}),
        ...(fault==='missing-email'?{}:{email:fault==='malformed-email'?'owner\n@example.test':fault==='different-email'?'different@example.test':'owner@example.test'}),
        email_verified:fault!=='unverified',name:'Connect account'});
    }
    if(url==='https://api.vercel.com/v1/connect/token/'+encodeURIComponent(connector)){
      providerTokenRequests++;
      throw new Error('Provider token API must not be used for Connect sign-in');
    }
    if(url==='https://api.github.com/user'){
      githubRequests++;throw new Error('Native GitHub API must not be used for managed Connect sign-in');
    }
    if(url==='https://api.github.com/user/emails?per_page=100'){
      githubRequests++;throw new Error('Native GitHub email API must not be used for managed Connect sign-in');
    }
    throw new Error('Unexpected owned fixture URL');
  }));
  const provider=new VercelConnectGitHubSignInProvider(connector,context);
  const input={state:'s'.repeat(43),nonce:'n'.repeat(43),codeChallenge:githubCodeChallenge('v'.repeat(43)),redirectUri:'https://studio.fixture.test/api/auth/github/callback'};
  return {provider,input,context,requests,nativeTokenIds,protectedTokenIds,
    setAuthorization:(url:URL)=>{expect(url.searchParams.has('nonce')).toBe(false);expectedChallenge=url.searchParams.get('code_challenge')!;},
    counts:()=>({leaseCalls,tokenRequests,providerTokenRequests,githubRequests,userinfoRequests}),
    authenticate:(onDiagnostic?:GitHubSignInObserver)=>provider.authenticate({code:'owned-code',state:input.state,nonce:input.nonce,verifier:'v'.repeat(43),redirectUri:input.redirectUri,onDiagnostic})};
}
describe('official Vercel Connect GitHub sign-in adapter',()=>{
  it.each(['nonce','signature','oversized-sub','short-access-token','userinfo-error','provider-error'] as Fault[])('diagnoses %s using finite stages and token shape without identity, token or provider text',async fault=>{
    const f=await fixture(fault),events:GitHubSignInDiagnostic[]=[];
    await expect(f.authenticate(event=>{events.push(event);})).rejects.toThrow();
    const token=events.find(event=>event.stage==='token-response');
    expect(token).toMatchObject({stage:'token-response',idTokenPresent:['nonce','signature'].includes(fault),accessTokenPresent:true,tokenTypeBearer:fault!=='provider-error'});
    const stage=['unverified','missing-email','oversized-sub','userinfo-error'].includes(fault)?'userinfo':fault==='short-access-token'?'oauth-token':'token-exchange';
    expect(events.some(event=>event.stage===stage&&event.state==='failure')).toBe(true);
    if(fault==='nonce')expect(events.find(event=>event.stage==='token-exchange'&&event.state==='failure')).toMatchObject({errorCode:'OAUTH_JWT_CLAIM_COMPARISON_FAILED',claim:'nonce'});
    if(['unverified','missing-email','oversized-sub'].includes(fault))expect(events.find(event=>event.stage==='userinfo-response')).toMatchObject({subjectPresent:true,emailPresent:fault!=='missing-email',emailVerified:fault!=='unverified'});
    const json=JSON.stringify(events);
    for(const value of ['connect-oauth-session-token','secret-provider-description','secret-provider-credential','owned-code','opaque-connect-subject','owner@example.test','github-user-token-fixture',f.input.state,f.input.nonce,'eyJ'])expect(json).not.toContain(value);
    expect(events.every(event=>event.elapsedMs>=0&&event.elapsedMs<=2147483647)).toBe(true);
    expect(f.counts().providerTokenRequests).toBe(0);expect(f.counts().githubRequests).toBe(0);
  });
  it.each(['unverified','missing-email','malformed-email'] as Fault[])('authenticates a valid principal without requiring optional email metadata (%s)',async fault=>{
    const f=await fixture(fault);
    expect(await f.authenticate()).toMatchObject({kind:'vercel-connect',issuer,connectorId,subject:'opaque-connect-subject',verifiedEmails:[]});
    expect(f.counts()).toMatchObject({providerTokenRequests:0,githubRequests:0,userinfoRequests:1});
  });
  it('uses the documented project-scoped OAuth userinfo contract and returns an opaque namespaced identity without a provider token',async()=>{
    const f=await fixture(),url=new URL(await f.provider.authorizationUrl(f.input));
    expect(url.origin+url.pathname).toBe(issuer+'/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(connector);
    expect(url.searchParams.get('state')).toBe(f.input.state);expect(url.searchParams.has('nonce')).toBe(false);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('teamId')).toBe(scope.ownerId);expect(url.searchParams.get('projectId')).toBe(scope.projectId);
    expect(url.searchParams.get('environment')).toBe('preview');
    expect(url.href).not.toContain('eyJ');
    expect(await f.authenticate()).toEqual({kind:'vercel-connect',issuer,connectorId,subject:'opaque-connect-subject',name:'Connect account',verifiedEmails:['owner@example.test']});
    expect(f.counts()).toMatchObject({tokenRequests:1,providerTokenRequests:0,githubRequests:0,userinfoRequests:1});
    expect(new Set(f.protectedTokenIds).size).toBe(f.protectedTokenIds.length);
    expect(f.counts().leaseCalls).toBeGreaterThan(f.protectedTokenIds.length);
    expect(()=>getVercelOidcTokenSync()).toThrow();
  });
  it('verifies an optional signed ID token and compares its subject with authenticated userinfo',async()=>{
    const f=await fixture('id-token');
    expect(await f.authenticate()).toMatchObject({kind:'vercel-connect',connectorId,subject:'opaque-connect-subject',verifiedEmails:['owner@example.test']});
    expect(f.counts()).toMatchObject({providerTokenRequests:0,githubRequests:0,userinfoRequests:1});
    expect(f.requests.some(request=>String(request.options.body).includes('opaque-connect-subject'))).toBe(false);
  });
  it.each(['signature','issuer','audience','expired','nonce','missing-access-token','short-access-token','dpop-token','missing-sub','oversized-sub','userinfo-sub','oversized-token','oversized-userinfo','userinfo-error','provider-error'] as Fault[])('rejects %s without publishing a Studio session or provider error',async fault=>{
    const f=await fixture(fault);
    await f.provider.authorizationUrl(f.input);
    await expect(f.authenticate()).rejects.not.toThrow('secret-provider-description');
    expect(f.counts().providerTokenRequests).toBe(0);expect(f.counts().githubRequests).toBe(0);
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
  it('refuses a late metadata result after its deadline without continuing the OAuth flow',async()=>{
    const f=await fixture(), original=globalThis.fetch;
    let release!:()=>void, entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}), ready=new Promise<void>(resolve=>{entered=resolve;});
    vi.stubGlobal('fetch',async(input:string|URL|Request,options?:RequestInit)=>{
      const response=await original(input,options);
      if(String(input)==='https://api.vercel.com/v1/connect/connectors/'+encodeURIComponent(connector)){
        entered();await gate;
      }
      return response;
    });
    vi.useFakeTimers();
    const pending=f.provider.authorizationUrl(f.input), refused=expect(pending).rejects.toMatchObject({statusCode:503});
    await ready;
    await vi.advanceTimersByTimeAsync(15001);
    await refused;
    expect(()=>getVercelOidcTokenSync()).toThrow();
    release();await vi.runAllTimersAsync();
    expect(f.counts()).toMatchObject({tokenRequests:0,providerTokenRequests:0,githubRequests:0,userinfoRequests:0});
  });
  it.each([undefined,'different-email','unverified','missing-email','malformed-email'] as const)('provisions from authenticated userinfo with SQL state, PKCE and session provenance (%s)',async fault=>{
    const logs:string[]=[],f=await fixture(fault),store=await Store.open(':memory:'),app=Fastify({logger:{redact:['req.url'],stream:{write:(line:string)=>{logs.push(line);}}}});
    await app.register(cookie);
    const auth=new Auth(store,{production:true,origin:'https://studio.fixture.test',dataDir:'/tmp/studio-connect-auth',demo:false,adminEmail:'owner@example.test',githubSignInConnector:connector},f.context);
    await auth.initialize();await auth.routes(app);cleanup.push(()=>store.close(),()=>app.close());
    const start=await app.inject('/api/auth/github'),url=new URL(String(start.headers.location));
    expect(start.statusCode).toBe(302);f.setAuthorization(url);
    const binding=start.cookies.find(value=>value.name==='studio_github_signin')!.value;
    const callback={url:'/api/auth/github/callback?'+new URLSearchParams({state:url.searchParams.get('state')!,code:'opaque.code~with+symbols'}),headers:{cookie:'studio_github_signin='+binding}};
    const response=await app.inject(callback);
    expect(response.headers.location).toBe('/');
    const session=response.cookies.find(value=>value.name==='studio_session')!.value;
    expect((await app.inject({url:'/api/me',headers:{cookie:'studio_session='+session}})).statusCode).toBe(200);
    expect((await app.inject(callback)).headers.location).toBe('/?signin=failed');
    expect((await store.one('SELECT COUNT(*) AS n FROM github_signin_sessions')).n).toBe(1);
    expect((await store.one('SELECT subject FROM github_connect_signin_identities')).subject).toBe('opaque-connect-subject');
    expect((await store.one('SELECT COUNT(*) AS n FROM github_signin_identities')).n).toBe(0);
    expect((await store.one('SELECT email,password FROM users')).email).toMatch(/@identity\.invalid$/);
    expect((await store.one('SELECT email,password FROM users')).password).toBeNull();
    for(const value of [binding,url.searchParams.get('state')!,'opaque.code','owner@example.test','different@example.test','connect-oauth-session-token'])expect(logs.join('')).not.toContain(value);
  });
});
