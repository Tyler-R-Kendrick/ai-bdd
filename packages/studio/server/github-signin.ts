import { createHash } from 'node:crypto';
import { HttpError } from './store.ts';
import type { GitHubSignInObserver } from './github-signin-diagnostics.ts';

export type DirectGitHubSignInIdentity = {
  kind: 'github';
  id: string;
  login: string;
  name: string;
  verifiedEmails?: string[];
};
export type ConnectGitHubSignInIdentity = {
  kind: 'vercel-connect';
  issuer: 'https://connect.vercel.com';
  connectorId: string;
  subject: string;
  name: string;
  verifiedEmails?: string[];
};
export type GitHubSignInIdentity = DirectGitHubSignInIdentity | ConnectGitHubSignInIdentity;
export const validConnectGitHubSubject=(subject:unknown):subject is string=>
  typeof subject==='string'&&!!subject.trim()&&Buffer.byteLength(subject,'utf8')<=1024&&
  ![...subject].some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127);
export type GitHubSignInAuthorization = {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  nonce?: string;
  onDiagnostic?: GitHubSignInObserver;
};
/** Trusted server dependency. A browser cannot select or construct a provider. */
export interface GitHubSignInProvider {
  authorizationUrl(input: GitHubSignInAuthorization): string | Promise<string>;
  authenticate(input: {
    code: string;
    verifier: string;
    redirectUri: string;
    state?: string;
    nonce?: string;
    onDiagnostic?: GitHubSignInObserver;
  }): Promise<GitHubSignInIdentity>;
}
export type GitHubSignInSettings = { clientId: string; clientSecret: string };
export function githubSignInSettingsFromEnv(
  env: NodeJS.ProcessEnv,
): GitHubSignInSettings | undefined {
  const clientId = env.STUDIO_GITHUB_SIGNIN_CLIENT_ID,
    clientSecret = env.STUDIO_GITHUB_SIGNIN_CLIENT_SECRET;
  if (!clientId && !clientSecret) return undefined;
  if (
    !clientId || !clientSecret || clientId.length > 200 ||
    clientSecret.length > 1000 || !/^[A-Za-z0-9_.-]+$/.test(clientId) ||
    [...clientSecret].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) > 126)
  ) throw new Error('GitHub sign-in requires a valid STUDIO_GITHUB_SIGNIN_CLIENT_ID and STUDIO_GITHUB_SIGNIN_CLIENT_SECRET');
  return { clientId, clientSecret };
}
export const githubCodeChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

async function boundedJson(response: Response, maximum: number) {
  let size = 0;
  const parts: Buffer[] = [];
  const reader = response.body?.getReader();
  try {
    if (!reader) throw new Error('response missing');
    while (true) {
      const { done, value: part } = await reader.read();
      if (done) break;
      size += part.byteLength;
      if (size > maximum) throw new Error('response limit');
      parts.push(Buffer.from(part));
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    await reader?.cancel().catch(() => {});
    throw new HttpError(502, 'GitHub returned an invalid sign-in response');
  } finally {
    reader?.releaseLock();
  }
}
/** Sign-in authenticates GitHub identity; repository authorization is separate. */
export class GitHubOAuthSignInProvider implements GitHubSignInProvider {
  constructor(readonly settings: GitHubSignInSettings) {}
  authorizationUrl(input: GitHubSignInAuthorization) {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: this.settings.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      scope: 'read:user',
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      allow_signup: 'false',
    }).toString();
    return url.href;
  }
  async authenticate(input: { code: string; verifier: string; redirectUri: string }) {
    const token = await githubSignInRequest('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
      }),
    }, 16384);
    if (
      !token || typeof token !== 'object' || token.error || typeof token.access_token !== 'string' ||
      token.access_token.length < 10 || token.access_token.length > 4096 ||
      typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
    ) throw new HttpError(401, 'GitHub could not complete sign-in. Start again.');
    return githubSignInIdentityFromToken(token.access_token);
  }
}

async function githubSignInRequest(url: string, options: RequestInit, maximum: number) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ai-bdd-studio',
          'X-GitHub-Api-Version': '2022-11-28',
          ...options.headers,
        },
      });
    } catch {
      throw new HttpError(503, 'GitHub sign-in is temporarily unavailable. Try again.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(
        response.status === 401 || response.status === 403 ? 401 : 503,
        'GitHub could not complete sign-in. Start again.',
      );
    }
    return boundedJson(response, maximum);
  }

/** Resolve the actual numeric GitHub account from a server-obtained user token. */
export async function githubSignInIdentityFromToken(accessToken: string): Promise<DirectGitHubSignInIdentity> {
  if (typeof accessToken !== 'string' || accessToken.length < 10 || accessToken.length > 4096 || /[\r\n]/.test(accessToken)) throw new HttpError(401, 'GitHub could not complete sign-in. Start again.');
    const headers = { Authorization: 'Bearer ' + accessToken };
    const profile = await githubSignInRequest('https://api.github.com/user', { headers }, 65536);
    if (
      !profile || typeof profile !== 'object' || !Number.isSafeInteger(profile.id) || profile.id <= 0 ||
      typeof profile.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(profile.login)
    ) throw new HttpError(502, 'GitHub returned an invalid account identity');
    return {
      kind: 'github',
      id: String(profile.id), login: profile.login,
      name: typeof profile.name === 'string' && profile.name.trim()
        ? profile.name.trim().slice(0, 100) : profile.login,
      verifiedEmails:[],
    };
}
