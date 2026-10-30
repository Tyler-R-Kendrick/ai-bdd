import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ConnectGitHubSignInIdentity, DirectGitHubSignInIdentity, GitHubSignInIdentity, GitHubSignInProvider, GitHubSignInAuthorization } from '../../server/github-signin.ts';
type FixtureIdentity=Partial<DirectGitHubSignInIdentity>|ConnectGitHubSignInIdentity;

/** Owned test issuer. Production entrypoints never import or select this adapter. */
class InjectGitHubSignInFixture implements GitHubSignInProvider {
  readonly starts = new Map<string, GitHubSignInAuthorization>();
  readonly codes = new Map<string, GitHubSignInAuthorization & { identity: GitHubSignInIdentity }>();
  authorizationUrl(input: GitHubSignInAuthorization) {
    this.starts.set(input.state, input);
    const url = new URL('https://github.fixture.invalid/authorize');
    url.search = new URLSearchParams({ state: input.state, code_challenge: input.codeChallenge, redirect_uri: input.redirectUri }).toString();
    return url.href;
  }
  issue(location: string, email: string, override: FixtureIdentity = {}) {
    const url = new URL(location), state = url.searchParams.get('state')!;
    const start = this.starts.get(state);
    if (!start || url.origin !== 'https://github.fixture.invalid') throw new Error('Unknown owned authorization request');
    this.starts.delete(state);
    const digest = createHash('sha256').update(email.toLowerCase()).digest('hex');
    const identity: GitHubSignInIdentity = override.kind==='vercel-connect'?override:{
      kind:'github',
      id: (BigInt('0x' + digest.slice(0, 12)) + 1n).toString(),
      login: 'fixture-' + digest.slice(0, 12),
      name: email === 'owner@example.test' ? 'Test owner' : 'Test ' + email.split('@')[0],
      verifiedEmails: [email.toLowerCase()], ...override,
    };
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, { ...start, identity });
    return { state, code };
  }
  async authenticate(input: { code: string; verifier: string; redirectUri: string }) {
    const issued = this.codes.get(input.code);
    this.codes.delete(input.code);
    if (!issued || issued.redirectUri !== input.redirectUri || createHash('sha256').update(input.verifier).digest('base64url') !== issued.codeChallenge)
      throw new Error('Owned issuer rejected code/PKCE/callback');
    return issued.identity;
  }
}
export const injectedGitHub = new InjectGitHubSignInFixture();
export async function githubSignInResponse(
  app: FastifyInstance,
  email = 'owner@example.test',
  identity: FixtureIdentity = {},
) {
  const start = await app.inject('/api/auth/github');
  if (start.statusCode !== 302) throw new Error(start.body);
  const binding = start.cookies.find(cookie => cookie.name === 'studio_github_signin')?.value;
  if (!binding) throw new Error('Owned authorization challenge missing');
  const { state, code } = injectedGitHub.issue(String(start.headers.location), email, identity);
  return app.inject({
    url: '/api/auth/github/callback?' + new URLSearchParams({ state, code }),
    headers: { cookie: 'studio_github_signin=' + binding },
  });
}
export async function githubSignIn(app: FastifyInstance, email = 'owner@example.test', identity: FixtureIdentity = {}) {
  const response = await githubSignInResponse(app, email, identity);
  if (response.statusCode !== 302 || response.headers.location !== '/') throw new Error('Owned GitHub sign-in was refused');
  const cookie = response.cookies.find(cookie => cookie.name === 'studio_session')?.value;
  if (!cookie) throw new Error('Owned GitHub session was not committed');
  const me = await app.inject({ url: '/api/me', headers: { cookie: 'studio_session=' + cookie } });
  if (me.statusCode !== 200) throw new Error(me.body);
  return { user: me.json(), cookie, response };
}
