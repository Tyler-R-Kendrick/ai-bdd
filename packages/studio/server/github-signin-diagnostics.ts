export type GitHubSignInStage =
  | 'authorization' | 'challenge' | 'provider' | 'admission' | 'session' | 'callback'
  | 'connector-metadata' | 'connector-configuration' | 'discovery' | 'token-exchange'
  | 'token-response' | 'oauth-token' | 'id-claims' | 'userinfo' | 'userinfo-response' | 'github-token' | 'github-profile' | 'email-match';
type SafeFailure = {errorClass?:string;errorCode?:string;claim?:string;status?:number};
export type GitHubSignInDiagnostic = SafeFailure & {stage:GitHubSignInStage;state:'start'|'success'|'failure';elapsedMs:number;idTokenPresent?:boolean;accessTokenPresent?:boolean;tokenTypeBearer?:boolean;subjectPresent?:boolean;emailPresent?:boolean;emailVerified?:boolean};
export type GitHubSignInObserver = (event:GitHubSignInDiagnostic)=>void|Promise<void>;
const classes=new Set(['Error','HttpError','ClientError','ResponseBodyError','AuthorizationResponseError','TypeError','IdentityLeaseError','ConnectError','NoValidTokenError','UserAuthorizationRequiredError','ConnectorInstallationRequiredError']);
const codes=new Set([
  'OAUTH_INVALID_RESPONSE','OAUTH_RESPONSE_BODY_ERROR','OAUTH_AUTHORIZATION_RESPONSE_ERROR',
  'OAUTH_JWT_CLAIM_COMPARISON_FAILED','OAUTH_JWT_TIMESTAMP_CHECK_FAILED','OAUTH_INVALID_REQUEST',
  'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED',
  'OAUTH_UNSUPPORTED_OPERATION','OAUTH_KEY_SELECTION_FAILED','OAUTH_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_INVALID','ERR_JWT_CLAIM_VALIDATION_FAILED','ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_EXPIRED','ERR_JWKS_NO_MATCHING_KEY','ERR_JWKS_TIMEOUT',
  'invalid_client','invalid_grant','invalid_token','unauthorized_client','invalid_request','invalid_scope',
  'access_denied','unsupported_grant_type','user_authorization_required','no_token',
  'client_not_linked_to_project','client_not_enabled_for_environment','connector_installation_required',
  'configuration','scope','verification','expired','transport','unavailable',
]);
const claims=new Set(['nonce','iss','aud','sub','exp','nbf','iat','azp']);
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object';
/** Only fixed enum members survive. Messages, values, paths and identities are never inspected. */
export function githubSignInFailure(error:unknown):SafeFailure {
  const result:SafeFailure={};const seen=new Set<unknown>();let current=object(error)&&object(error.githubSignInFailure)?error.githubSignInFailure:error;
  for(let depth=0;depth<4&&object(current)&&!seen.has(current);depth++){
    seen.add(current);
    if(!result.errorClass&&typeof current.name==='string')result.errorClass=classes.has(current.name)?current.name:'Error';
    if(!result.errorCode&&typeof current.code==='string'&&codes.has(current.code))result.errorCode=current.code;
    if(!result.claim&&typeof current.claim==='string'&&claims.has(current.claim))result.claim=current.claim;
    const status=current.statusCode??current.status;
    if(result.status===undefined&&typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599)result.status=status;
    current=current.githubSignInFailure??current.cause;
  }
  return result;
}
/** Preserve only sanitized failure metadata when an SDK vendor error is replaced. */
export function retainGitHubSignInFailure<T extends Error>(safe:T,original:unknown):T {
  const failure=githubSignInFailure(original);
  Object.defineProperty(safe,'githubSignInFailure',{value:{name:failure.errorClass,code:failure.errorCode,claim:failure.claim,status:failure.status}});
  return safe;
}
export function emitGitHubSignIn(observer:GitHubSignInObserver|undefined,event:GitHubSignInDiagnostic){
  try{const result=observer?.(event);if(result)void Promise.resolve(result).catch(()=>{});}catch{}
}
export async function observeGitHubSignIn<T>(observer:GitHubSignInObserver|undefined,stage:GitHubSignInStage,operation:()=>Promise<T>):Promise<T>{
  const start=Date.now();const elapsed=()=>Math.min(2147483647,Math.max(0,Date.now()-start));
  emitGitHubSignIn(observer,{stage,state:'start',elapsedMs:0});
  try{const result=await operation();emitGitHubSignIn(observer,{stage,state:'success',elapsedMs:elapsed()});return result;}
  catch(error){emitGitHubSignIn(observer,{stage,state:'failure',elapsedMs:elapsed(),...githubSignInFailure(error)});throw error;}
}
