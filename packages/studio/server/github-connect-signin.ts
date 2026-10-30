import { customFetch as authJsCustomFetch } from '@auth/core';
import { connect } from '@vercel/connect/authjs';
import { deleteTokenCacheEntry, getConnectorMetadata, getTokenResponse, type ConnectorMetadata } from '@vercel/connect';
import * as oidc from 'openid-client';
import { HttpError } from './store.ts';
import { githubSignInIdentityFromToken, type GitHubSignInAuthorization, type GitHubSignInProvider } from './github-signin.ts';
import { runWithIdentity, type IdentityExecutionContext } from './hosting/identity-context.ts';
import { emitGitHubSignIn, githubSignInFailure, observeGitHubSignIn, retainGitHubSignInFailure, type GitHubSignInObserver } from './github-signin-diagnostics.ts';

const issuer = 'https://connect.vercel.com';
const endpoints = {
  authorization_endpoint: issuer + '/oauth/authorize',
  token_endpoint: issuer + '/oauth/token',
  userinfo_endpoint: issuer + '/oauth/userinfo',
  jwks_uri: issuer + '/.well-known/jwks',
};
const transportUrls = new Set([
  issuer + '/.well-known/openid-configuration',
  endpoints.token_endpoint, endpoints.userinfo_endpoint, endpoints.jwks_uri,
]);
export function githubSignInConnectorFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const connector = env.STUDIO_GITHUB_SIGNIN_CONNECTOR;
  if (!connector) return undefined;
  if (!/^(?:github\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}|scl_[A-Za-z0-9]{1,100})$/.test(connector))
    throw new Error('STUDIO_GITHUB_SIGNIN_CONNECTOR must identify the owned GitHub Vercel Connect connector');
  return connector;
}
async function boundedResponse(response: Response, maximum = 65536) {
  const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader) while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('response limit');
      chunks.push(value);
    }
    return new Response(Buffer.concat(chunks), {status:response.status,headers:response.headers});
  } catch {
    await reader?.cancel().catch(()=>{});
    throw new Error('invalid sign-in response');
  } finally { reader?.releaseLock(); }
}
/**
 * The official Connect Auth.js adapter supplies OAuth endpoints and fresh project
 * authentication. Existing Studio SQL challenges/sessions remain the authority.
 */
export class VercelConnectGitHubSignInProvider implements GitHubSignInProvider {
  constructor(readonly connector: string, readonly identityContext?: IdentityExecutionContext) {}
  private async scoped<T>(operation:()=>Promise<T>): Promise<T> {
    try {
      return await runWithIdentity(this.identityContext, async()=>{
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            operation(),
            new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Connect operation expired')),15000);timer.unref();}),
          ]);
        } finally {if(timer)clearTimeout(timer);}
      });
    } catch (error) {
      // SDK vendor errors can contain provider data. Never publish or log them.
      throw retainGitHubSignInFailure(new HttpError(503,'GitHub sign-in through Vercel Connect is temporarily unavailable. Start again.'),error);
    }
  }
  private async metadata(observer?:GitHubSignInObserver): Promise<ConnectorMetadata> {
    return observeGitHubSignIn(observer,'connector-metadata',async()=>{
    const metadata = await this.scoped(()=>getConnectorMetadata(this.connector));
    if (!metadata || metadata.service !== 'github' ||
      (metadata.uid !== this.connector && metadata.id !== this.connector) ||
      typeof metadata.uid !== 'string' || !metadata.uid.startsWith('github/') ||
      typeof metadata.id !== 'string' || !metadata.id.startsWith('scl_'))
      throw new HttpError(503,'The configured sign-in connector is not the owned GitHub connector');
    return metadata;
    });
  }
  private async configuration(observer?:GitHubSignInObserver) {
    // This helper reads the current validated native OIDC context. It keeps no JWT.
    const provider = await observeGitHubSignIn(observer,'connector-configuration',()=>this.scoped(async()=>connect({
      id:'github',name:'GitHub',connector:this.connector,
      // This is the SDK's OAuth + PKCE contract. GitHub's own authenticated
      // profile and verified email API, rather than optional Connect OIDC
      // profile claims, determine the Studio identity.
      scopes:['user:email'],
    })));
    const sdkFetch = provider[authJsCustomFetch];
    if (!sdkFetch || provider.clientId !== this.connector)
      throw new HttpError(503,'Vercel Connect sign-in is unavailable');
    const transport: oidc.CustomFetch = (input,init)=>this.scoped(async()=>{
      const url = input;
      if (!transportUrls.has(url)) throw new Error('Foreign sign-in endpoint refused');
      const response = await sdkFetch(input,{
        ...init,redirect:'error',
        signal:AbortSignal.any([AbortSignal.timeout(12000),...(init?.signal?[init.signal]:[])]),
      } as RequestInit);
      const bounded=await boundedResponse(response);
      if(url===endpoints.token_endpoint){
        let shape:Record<string,unknown>={};
        try{const value:unknown=await bounded.clone().json();if(value&&typeof value==='object'&&!Array.isArray(value))shape=value as Record<string,unknown>;}catch{}
        emitGitHubSignIn(observer,{stage:'token-response',state:bounded.ok?'success':'failure',elapsedMs:0,status:bounded.status,
          idTokenPresent:typeof shape.id_token==='string',accessTokenPresent:typeof shape.access_token==='string',
          tokenTypeBearer:typeof shape.token_type==='string'&&shape.token_type.toLowerCase()==='bearer',
          ...githubSignInFailure({code:shape.error}),
        });
      }
      return bounded;
    });
    const configuration = await observeGitHubSignIn(observer,'discovery',async()=>{
    const configuration=await oidc.discovery(new URL(issuer),this.connector,
      {token_endpoint_auth_method:'none',id_token_signed_response_alg:'RS256'},oidc.None(),
      {[oidc.customFetch]:transport,execute:[oidc.enableNonRepudiationChecks]});
    const metadata = configuration.serverMetadata();
    if (metadata.issuer !== issuer || Object.entries(endpoints).some(([key,value])=>metadata[key]!==value))
      throw new HttpError(503,'Vercel Connect returned unexpected sign-in endpoints');
    return configuration;
    });
    return {provider,configuration};
  }
  async authorizationUrl(input: GitHubSignInAuthorization) {
    await this.metadata(input.onDiagnostic);
    const {provider,configuration} = await this.configuration(input.onDiagnostic);
    const authorization = provider.authorization;
    if (!authorization || typeof authorization==='string' || authorization.url?.split('?')[0]!==endpoints.authorization_endpoint)
      throw new HttpError(503,'Vercel Connect returned an invalid sign-in configuration');
    const url = oidc.buildAuthorizationUrl(configuration,{
      ...Object.fromEntries(new URL(authorization.url).searchParams),
      ...authorization.params,
      redirect_uri:input.redirectUri,state:input.state,
      code_challenge:input.codeChallenge,code_challenge_method:'S256',
    });
    return url.href;
  }
  async authenticate(input:{code:string;verifier:string;redirectUri:string;state?:string;nonce?:string;onDiagnostic?:GitHubSignInObserver}) {
    if (!input.state) throw new HttpError(401,'A fresh GitHub sign-in challenge is required');
    const observer=input.onDiagnostic;
    const metadata = await this.metadata(observer), {configuration} = await this.configuration(observer);
    const callback = new URL(input.redirectUri);
    callback.searchParams.set('code',input.code);callback.searchParams.set('state',input.state);
    const tokens = await observeGitHubSignIn(observer,'token-exchange',()=>oidc.authorizationCodeGrant(configuration,callback,{
      expectedState:input.state,pkceCodeVerifier:input.verifier,
    }));
    await observeGitHubSignIn(observer,'oauth-token',async()=>{
      if (typeof tokens.access_token!=='string' || tokens.access_token.length<10 || tokens.access_token.length>16384 ||
        typeof tokens.token_type!=='string' || tokens.token_type.toLowerCase()!=='bearer')
        throw new HttpError(401,'Vercel Connect did not return a usable GitHub sign-in token');
    });
    // The SDK's OAuth provider does not require an ID token or verified Connect
    // email claims. openid-client still verifies issuer/audience/time, nonce
    // absence and the RS256 signature of any optional ID token it receives.
    // Do not consume its subject or userinfo as a Studio identity authority.
    // Exchange the server-obtained OAuth session token. No app grant, caller
    // subject ID, inferred subject format or project-wide user impersonation.
    const parameters = {subject:{type:'token' as const,token:tokens.access_token},scopes:['user:email']};
    try {
      const result = await observeGitHubSignIn(observer,'github-token',async()=>{
        const result=await this.scoped(()=>getTokenResponse(this.connector,parameters,{forceRefresh:true})
          .finally(()=>deleteTokenCacheEntry(this.connector,parameters)));
        if (!result?.connector || result.connector.id!==metadata.id || result.connector.uid!==metadata.uid || typeof result.token!=='string')
          throw new HttpError(401,'Vercel Connect returned an unexpected GitHub credential');
        return result;
      });
      const identity = await observeGitHubSignIn(observer,'github-profile',()=>githubSignInIdentityFromToken(result.token));
      return identity;
    } finally {
      deleteTokenCacheEntry(this.connector,parameters);
    }
  }
}
