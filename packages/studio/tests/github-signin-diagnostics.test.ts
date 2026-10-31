import {describe,expect,it} from 'vitest';
import {emitGitHubSignIn,githubSignInFailure,observeGitHubSignIn,retainGitHubSignInFailure,type GitHubSignInDiagnostic} from '../server/github-signin-diagnostics.ts';

describe('finite GitHub sign-in diagnostics',()=>{
  it('retains only literal error class, code, claim and valid HTTP status through bounded causes',()=>{
    const secret={name:'UntrustedIdentity@example.test',code:'secret-token',claim:'secret-nonce',status:999,message:'secret-code',email:'owner@example.test',stack:'secret-path',cause:{name:'ClientError',code:'OAUTH_JWT_CLAIM_COMPARISON_FAILED',claim:'nonce',statusCode:401,cause:null as unknown}};
    secret.cause.cause=secret;
    const failure=githubSignInFailure(secret);
    expect(failure).toEqual({errorClass:'Error',errorCode:'OAUTH_JWT_CLAIM_COMPARISON_FAILED',claim:'nonce',status:401});
    expect(JSON.stringify(failure)).not.toMatch(/secret|owner|example|path/);
    expect(githubSignInFailure({cause:{cause:{cause:{cause:{code:'invalid_client'}}}}})).toEqual({});
    for(const status of [Infinity,NaN,99,600,200.1,'401'])expect(githubSignInFailure({status})).toEqual({});
  });
  it('preserves sanitized provider metadata without retaining a vendor exception or exposing it through JSON',()=>{
    const original=Object.assign(new Error('secret token and code'),{name:'ClientError',code:'OAUTH_INVALID_RESPONSE',cause:{claim:'sub',status:403,message:'secret identity'}});
    const safe=retainGitHubSignInFailure(Object.assign(new Error('Unavailable'),{name:'HttpError',statusCode:503}),original);
    expect(githubSignInFailure(safe)).toEqual({errorClass:'ClientError',errorCode:'OAUTH_INVALID_RESPONSE',claim:'sub',status:403});
    expect(JSON.stringify(safe)).not.toMatch(/secret|ClientError|OAUTH_INVALID_RESPONSE/);
    expect((safe as Error&{cause?:unknown}).cause).toBeUndefined();
  });
  it('records finite stages and rethrows the original error while isolating diagnostic transport failures',async()=>{
    const events:GitHubSignInDiagnostic[]=[],error=Object.assign(new Error('secret provider text'),{code:'invalid_grant'});
    await expect(observeGitHubSignIn(event=>{events.push(event);},'token-exchange',async()=>{throw error;})).rejects.toBe(error);
    expect(events).toEqual([{stage:'token-exchange',state:'start',elapsedMs:0},{stage:'token-exchange',state:'failure',elapsedMs:expect.any(Number),errorClass:'Error',errorCode:'invalid_grant'}]);
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(await observeGitHubSignIn(()=>{throw new Error('observer');},'session',async()=>42)).toBe(42);
    expect(await observeGitHubSignIn(async()=>{throw new Error('observer');},'session',async()=>42)).toBe(42);
    emitGitHubSignIn(undefined,{stage:'callback',state:'failure',elapsedMs:0});
  });
});
