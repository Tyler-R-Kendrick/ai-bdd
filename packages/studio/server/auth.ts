import { DurableChallenges } from './identity/challenges.ts';
import { repositoryIdentitySettingsFromEnv } from './identity/settings.ts';
import type { RepositoryIdentitySettings } from './identity/ports.ts';
import { integrationSettingsFromEnv, type IntegrationSettings } from './integrations/settings.ts';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { hash, HttpError, type Store } from './store.ts';
import type { User } from '../shared/domain.ts';
import {
  GitHubOAuthSignInProvider, githubCodeChallenge, githubSignInSettingsFromEnv,
  type GitHubSignInProvider, type GitHubSignInSettings, type GitHubSignInIdentity,
} from './github-signin.ts';
import { VercelConnectGitHubSignInProvider, githubSignInConnectorFromEnv } from './github-connect-signin.ts';
import type { IdentityExecutionContext } from './hosting/identity-context.ts';
import { emitGitHubSignIn, githubSignInFailure, observeGitHubSignIn, type GitHubSignInObserver } from './github-signin-diagnostics.ts';

// Retained for reading historical test/migration fixtures. No HTTP endpoint uses passwords.
const derive = promisify(scrypt);
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function passwordValid(password: string, encoded: string): Promise<boolean> {
  const [salt, value] = encoded.split(':');
  if (!salt || !value) return false;
  const key = (await derive(password, salt, 64)) as Buffer;
  const expected = Buffer.from(value, 'hex');
  return expected.length === key.length && timingSafeEqual(key, expected);
}
export type Settings = {
  production: boolean;
  origin: string;
  dataDir: string;
  adminEmail?: string;
  /** Historical configuration fields do not enable a sign-in method. */
  adminPassword?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcAllowHttpLoopback?: boolean;
  githubSignIn?: GitHubSignInSettings;
  githubSignInConnector?: string;
  /** Code-only injection for an independently implemented, trusted server adapter. */
  githubSignInProvider?: GitHubSignInProvider;
  repositoryIdentity?: RepositoryIdentitySettings;
  demo: boolean;
  model?: string;
  githubToken?: string;
  githubRepositories?: string[];
  trustedProxies?: string[];
  runnerConfig?: string;
  integrations?: IntegrationSettings;
};
export function settingsFromEnv(env: NodeJS.ProcessEnv): Settings {
  const production = env.NODE_ENV === 'production',
    origin = env.STUDIO_ORIGIN ?? 'http://127.0.0.1:8787';
  const url = new URL(origin);
  if (url.origin !== origin)
    throw new Error('STUDIO_ORIGIN must be an origin without a trailing slash or path');
  if (production && url.protocol !== 'https:')
    throw new Error('Production requires an HTTPS STUDIO_ORIGIN');
  if (production && env.STUDIO_DEMO === '1')
    throw new Error('Demo access is forbidden in production');
  const githubSignInConnector = githubSignInConnectorFromEnv(env);
  const githubSignIn = githubSignInConnector ? undefined : githubSignInSettingsFromEnv(env);
  if (production && !githubSignIn && !githubSignInConnector)
    throw new Error('Production requires GitHub sign-in client bindings or STUDIO_GITHUB_SIGNIN_CONNECTOR');
  if (env.STUDIO_MODEL && !env.AI_GATEWAY_API_KEY && !env.VERCEL_OIDC_TOKEN && env.VERCEL !== '1')
    throw new Error('STUDIO_MODEL requires AI_GATEWAY_API_KEY or Vercel OIDC authentication');
  const trustedProxies = env.STUDIO_TRUSTED_PROXIES?.split(',').map(s => s.trim()).filter(Boolean);
  if (trustedProxies?.some(s => !/^(loopback|linklocal|uniquelocal|[0-9a-f:.]+(?:\/[0-9]{1,3})?)$/i.test(s)))
    throw new Error('STUDIO_TRUSTED_PROXIES must contain explicit IP addresses, CIDRs, or Fastify loopback/linklocal/uniquelocal ranges');
  const githubRepositories = env.STUDIO_GITHUB_REPOSITORIES?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (githubRepositories?.some(s => !/^[-\w.]+\/[-\w.]+$/.test(s)))
    throw new Error('STUDIO_GITHUB_REPOSITORIES must contain owner/repository names');
  return {
    repositoryIdentity: repositoryIdentitySettingsFromEnv(env),
    integrations: integrationSettingsFromEnv(env), production, origin,
    dataDir: env.STUDIO_DATA_DIR ?? '.studio',
    adminEmail: env.STUDIO_ADMIN_EMAIL ?? 'owner@localhost',
    githubSignIn, githubSignInConnector, demo: false, model: env.STUDIO_MODEL,
    githubToken: env.STUDIO_GITHUB_TOKEN, githubRepositories, trustedProxies,
    runnerConfig: env.STUDIO_RUNNER_CONFIG,
  };
}
export class Auth {
  readonly challenges: DurableChallenges;
  readonly github: GitHubSignInProvider | undefined;
  constructor(readonly store: Store, readonly settings: Settings, identityExecutionContext?: IdentityExecutionContext) {
    this.challenges = new DurableChallenges(store);
    this.github = settings.githubSignInProvider ?? (settings.githubSignInConnector
      ? new VercelConnectGitHubSignInProvider(settings.githubSignInConnector, identityExecutionContext)
      : settings.githubSignIn ? new GitHubOAuthSignInProvider(settings.githubSignIn) : undefined);
  }
  async initialize() {
    await this.store.tx(async () => {
      await this.store.db.lock('schema:studio.identity');
      await this.challenges.initialize();
      await this.store.exec('CREATE TABLE IF NOT EXISTS github_signin_identities(github_id TEXT PRIMARY KEY,user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at BIGINT NOT NULL)');
      // Additive provenance avoids changing legacy sessions or trusting password-created cookies.
      await this.store.exec('CREATE TABLE IF NOT EXISTS github_signin_sessions(token TEXT PRIMARY KEY REFERENCES sessions(token) ON DELETE CASCADE)');
      await this.store.exec('DELETE FROM sessions WHERE expires<?', Date.now());
    });
  }
  async user(req: FastifyRequest): Promise<User> {
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const token = bearer ?? req.cookies.studio_session;
    if (!token) throw new HttpError(401, 'Sign in to continue');
    const session = await this.store.one(
      'SELECT user_id FROM sessions WHERE token=? AND expires>? AND kind=?' +
        (bearer ? '' : ' AND EXISTS(SELECT 1 FROM github_signin_sessions g WHERE g.token=sessions.token)'),
      hash(token), Date.now(), bearer ? 'api' : 'session',
    );
    if (!session) throw new HttpError(401, 'Your session expired. Sign in again.');
    return this.store.publicUser(session.user_id);
  }
  assertOrigin(req: FastifyRequest) {
    if (req.headers.authorization?.match(/^Bearer (\S+)$/)) return;
    if (req.headers.origin !== this.settings.origin)
      throw new HttpError(403, 'Request origin is not allowed');
  }
  async session(user: User, reply: FastifyReply) {
    const token = randomBytes(32).toString('base64url');
    await this.store.tx(async () => {
      await this.store.db.lock('user:' + user.id);
      if (!(await this.store.one('SELECT user_id FROM github_signin_identities WHERE user_id=?', user.id)))
        throw new HttpError(401, 'A verified GitHub sign-in is required');
      await this.store.exec("INSERT INTO sessions(token,user_id,expires,kind) VALUES(?,?,?,'session')", hash(token), user.id, Date.now() + 7 * 86400000);
      await this.store.exec('INSERT INTO github_signin_sessions(token) VALUES(?)', hash(token));
    });
    reply.setCookie('studio_session', token, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: this.settings.production,
      maxAge: 7 * 86400,
    });
  }
  private async admit(identity: GitHubSignInIdentity) {
    if (!/^[1-9][0-9]{0,19}$/.test(identity.id) || !Array.isArray(identity.verifiedEmails) || identity.verifiedEmails.length > 100)
      throw new HttpError(403, 'GitHub returned an invalid account identity');
    const emails = [...new Set(identity.verifiedEmails.filter(email => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)).map(email => email.toLowerCase()))];
    if (!emails.length) throw new HttpError(403, 'A verified GitHub email is required');
    return this.store.tx(async () => {
      await this.store.db.lock('identity:admission');
      const linked = await this.store.one('SELECT user_id FROM github_signin_identities WHERE github_id=?', identity.id);
      if (linked) return this.store.publicUser(linked.user_id);
      const matches = [];
      for (const email of emails) {
        const user = await this.store.userByEmail(email);
        if (user) matches.push(user);
      }
      if (matches.length > 1) throw new HttpError(403, 'This GitHub account matches multiple workspace accounts. Ask a workspace owner for help.');
      let user = matches[0];
      const ownerEmail = this.settings.adminEmail?.toLowerCase();
      if (!user && ownerEmail && emails.includes(ownerEmail) && !(await this.store.one('SELECT id FROM users LIMIT 1')))
        user = await this.store.createUser(ownerEmail, String(identity.name || identity.login).slice(0, 100), null);
      if (!user) throw new HttpError(403, 'Ask a workspace owner to invite your verified GitHub email');
      const previous = await this.store.one('SELECT github_id FROM github_signin_identities WHERE user_id=?', user.id);
      if (previous) throw new HttpError(403, 'This workspace account is already connected to another GitHub account');
      await this.store.exec('INSERT INTO github_signin_identities(github_id,user_id,created_at) VALUES(?,?,?)', identity.id, user.id, Date.now());
      return this.store.publicUser(user.id);
    });
  }
  async routes(app: FastifyInstance) {
    app.get('/api/auth/status', async () => ({ setup: false, demo: false, oidc: false, github: !!this.github, password: false }));
    const passwordDisabled = async () => { throw new HttpError(403, 'Password sign-in is disabled. Continue with GitHub.'); };
    app.post('/api/auth/setup', passwordDisabled);
    app.post('/api/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, passwordDisabled);
    app.post('/api/auth/demo', passwordDisabled);
    app.get('/api/me', async req => this.user(req));
    app.post('/api/auth/logout', async (req, reply) => {
      this.assertOrigin(req);
      if (req.cookies.studio_session)
        await this.store.exec('DELETE FROM sessions WHERE token=?', hash(req.cookies.studio_session));
      reply.clearCookie('studio_session', { path: '/' });
      return { ok: true };
    });
    app.get('/api/auth/github', {config:{rateLimit:{max:8,timeWindow:'1 minute'}}}, async (req, reply) => {
      const observer:GitHubSignInObserver=event=>{req.log[event.state==='failure'?'warn':'info']({githubSignIn:event},'GitHub sign-in');};
      if (!this.github) throw new HttpError(503, 'GitHub sign-in is not configured');
      const state = randomBytes(32).toString('base64url'), binding = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
      const authorizationUrl = await observeGitHubSignIn(observer,'authorization',async()=>this.github!.authorizationUrl({ state, nonce, codeChallenge: githubCodeChallenge(verifier), redirectUri: this.settings.origin + '/api/auth/github/callback',onDiagnostic:observer }));
      await this.store.tx(async () => {
        await this.store.db.lock('identity:github-signin-challenges');
        await this.challenges.put('github-signin', state, binding, { verifier, nonce }, Date.now() + 300000);
      });
      reply.setCookie('studio_github_signin', binding, { path: '/api/auth/github', httpOnly: true, sameSite: 'lax', secure: this.settings.production, maxAge: 300 });
      return reply.redirect(authorizationUrl);
    });
    app.get('/api/auth/github/callback', async (req, reply) => {
      const observer:GitHubSignInObserver=event=>{req.log[event.state==='failure'?'warn':'info']({githubSignIn:event},'GitHub sign-in');};
      reply.clearCookie('studio_github_signin', { path: '/api/auth/github' });
      try {
        const url = new URL(req.url, this.settings.origin), state = url.searchParams.get('state') ?? '';
        const code = url.searchParams.get('code') ?? '';
        const challenge=await observeGitHubSignIn(observer,'challenge',async()=>{
        const challenge=await this.challenges.consume<{verifier:string;nonce?:string}>('github-signin',state,req.cookies.studio_github_signin??'');
        if (!this.github || !challenge || url.searchParams.has('error') || code.length<1 || code.length>4096 || [...code].some(character=>character.charCodeAt(0)<=32 || character.charCodeAt(0)>126))
          throw new HttpError(401, 'GitHub sign-in expired. Start again.');
        return challenge;
        });
        const identity = await observeGitHubSignIn(observer,'provider',()=>this.github!.authenticate({ code, state, nonce: challenge.payload.nonce, verifier: challenge.payload.verifier, redirectUri: this.settings.origin + '/api/auth/github/callback',onDiagnostic:observer }));
        const user = await observeGitHubSignIn(observer,'admission',()=>this.admit(identity));
        await observeGitHubSignIn(observer,'session',()=>this.session(user, reply));
        return reply.redirect('/');
      } catch (error) {
        emitGitHubSignIn(observer,{stage:'callback',state:'failure',elapsedMs:0,...githubSignInFailure(error)});
        // Never put OAuth codes, state, tokens, provider messages or return URLs in a redirect.
        return reply.redirect('/?signin=failed');
      }
    });
  }
}
