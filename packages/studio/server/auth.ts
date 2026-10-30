import { DurableChallenges } from './identity/challenges.ts';
import { repositoryIdentitySettingsFromEnv } from './identity/settings.ts';
import type { RepositoryIdentitySettings } from './identity/ports.ts';
import {
  integrationSettingsFromEnv,
  type IntegrationSettings,
} from './integrations/settings.ts';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as oidc from 'openid-client';
import { hash, HttpError, type Store } from './store.ts';
import type { User } from '../shared/domain.ts';
const derive = promisify(scrypt);
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function passwordValid(
  password: string,
  encoded: string,
): Promise<boolean> {
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
  adminPassword?: string;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcAllowHttpLoopback?: boolean;
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
    throw new Error(
      'STUDIO_ORIGIN must be an origin without a trailing slash or path',
    );
  if (production && url.protocol !== 'https:')
    throw new Error('Production requires an HTTPS STUDIO_ORIGIN');
  if (production && env.STUDIO_DEMO === '1')
    throw new Error('Demo access is forbidden in production');
  if (env.STUDIO_ADMIN_PASSWORD && env.STUDIO_ADMIN_PASSWORD.length < 16)
    throw new Error('STUDIO_ADMIN_PASSWORD must have at least 16 characters');
  if (production && !env.STUDIO_ADMIN_PASSWORD && !env.STUDIO_OIDC_ISSUER)
    throw new Error('Production requires a bootstrap password or OIDC');
  if (
    env.STUDIO_OIDC_ISSUER &&
    (!env.STUDIO_OIDC_CLIENT_ID || !env.STUDIO_OIDC_CLIENT_SECRET)
  )
    throw new Error(
      'OIDC requires STUDIO_OIDC_CLIENT_ID and STUDIO_OIDC_CLIENT_SECRET',
    );
  if (
    env.STUDIO_MODEL &&
    !env.AI_GATEWAY_API_KEY &&
    !env.VERCEL_OIDC_TOKEN &&
    env.VERCEL !== '1'
  )
    throw new Error(
      'STUDIO_MODEL requires AI_GATEWAY_API_KEY or Vercel OIDC authentication',
    );
  if (production && env.STUDIO_OIDC_ALLOW_HTTP_LOOPBACK === '1')
    throw new Error('HTTP OIDC test issuers are restricted to development');
  const trustedProxies = env.STUDIO_TRUSTED_PROXIES?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    trustedProxies?.some(
      (s) =>
        !/^(loopback|linklocal|uniquelocal|[0-9a-f:.]+(?:\/[0-9]{1,3})?)$/i.test(
          s,
        ),
    )
  )
    throw new Error(
      'STUDIO_TRUSTED_PROXIES must contain explicit IP addresses, CIDRs, or Fastify loopback/linklocal/uniquelocal ranges',
    );
  const githubRepositories = env.STUDIO_GITHUB_REPOSITORIES?.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (githubRepositories?.some((s) => !/^[-\w.]+\/[-\w.]+$/.test(s)))
    throw new Error(
      'STUDIO_GITHUB_REPOSITORIES must contain owner/repository names',
    );
  return {
    repositoryIdentity: repositoryIdentitySettingsFromEnv(env),
    oidcAllowHttpLoopback: env.STUDIO_OIDC_ALLOW_HTTP_LOOPBACK === '1',
    integrations: integrationSettingsFromEnv(env),
    production,
    origin,
    dataDir: env.STUDIO_DATA_DIR ?? '.studio',
    adminEmail: env.STUDIO_ADMIN_EMAIL ?? 'owner@localhost',
    adminPassword: env.STUDIO_ADMIN_PASSWORD,
    oidcIssuer: env.STUDIO_OIDC_ISSUER,
    oidcClientId: env.STUDIO_OIDC_CLIENT_ID,
    oidcClientSecret: env.STUDIO_OIDC_CLIENT_SECRET,
    demo: env.STUDIO_DEMO === '1',
    model: env.STUDIO_MODEL,
    githubToken: env.STUDIO_GITHUB_TOKEN,
    githubRepositories,
    trustedProxies,
    runnerConfig: env.STUDIO_RUNNER_CONFIG,
  };
}
export class Auth {
  readonly challenges: DurableChallenges;
  constructor(
    readonly store: Store,
    readonly settings: Settings,
  ) {
    this.challenges = new DurableChallenges(store);
  }
  async initialize() {
    await this.store.tx(async () => {
      await this.store.db.lock('schema:studio.identity');
      await this.challenges.initialize();
    });
    const encoded =
      this.settings.adminPassword &&
      !(await this.store.userByEmail(this.settings.adminEmail!))
        ? await passwordHash(this.settings.adminPassword)
        : undefined;
    await this.store.tx(async () => {
      await this.store.db.lock('identity:bootstrap');
      await this.store.exec('DELETE FROM sessions WHERE expires<?', Date.now());
      if (encoded && !(await this.store.userByEmail(this.settings.adminEmail!)))
        await this.store.createUser(
          this.settings.adminEmail!,
          'Workspace owner',
          encoded,
        );
      if (
        this.settings.demo &&
        !(await this.store.userByEmail('demo@localhost'))
      )
        await this.store.createUser('demo@localhost', 'Alex Morgan', null);
    });
  }
  async user(req: FastifyRequest): Promise<User> {
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const token = bearer ?? req.cookies.studio_session;
    if (!token) throw new HttpError(401, 'Sign in to continue');
    const session = await this.store.one(
      'SELECT user_id FROM sessions WHERE token=? AND expires>? AND kind=?',
      hash(token),
      Date.now(),
      bearer ? 'api' : 'session',
    );
    if (!session)
      throw new HttpError(401, 'Your session expired. Sign in again.');
    return await this.store.publicUser(session.user_id);
  }
  assertOrigin(req: FastifyRequest) {
    if (req.headers.authorization?.match(/^Bearer (\S+)$/)) return;
    if (req.headers.origin !== this.settings.origin)
      throw new HttpError(403, 'Request origin is not allowed');
  }
  async session(user: User, reply: FastifyReply, expectedPassword?: string) {
    const token = randomBytes(32).toString('base64url');
    await this.store.tx(async () => {
      await this.store.db.lock('user:' + user.id);
      const current = await this.store.one(
        'SELECT id,password FROM users WHERE id=?',
        user.id,
      );
      if (
        !current ||
        (expectedPassword !== undefined &&
          current.password !== expectedPassword)
      )
        throw new HttpError(401, 'Your account changed. Sign in again.');
      await this.store.exec(
        "INSERT INTO sessions(token,user_id,expires,kind) VALUES(?,?,?,'session')",
        hash(token),
        user.id,
        Date.now() + 7 * 86400000,
      );
    });
    reply.setCookie('studio_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: this.settings.production,
      maxAge: 7 * 86400,
    });
  }
  async routes(app: FastifyInstance) {
    app.get('/api/auth/status', async () => ({
      setup: !(await this.store.one('SELECT id FROM users LIMIT 1')),
      demo: this.settings.demo,
      oidc: !!this.settings.oidcIssuer,
    }));
    app.post('/api/auth/setup', async (req, reply) => {
      this.assertOrigin(req);
      if (
        this.settings.production ||
        (await this.store.one('SELECT id FROM users LIMIT 1'))
      )
        throw new HttpError(403, 'Setup is unavailable');
      const b = req.body as any;
      if (
        !b ||
        typeof b.email !== 'string' ||
        !/^\S+@\S+\.\S+$/.test(b.email) ||
        b.email.length > 254 ||
        typeof b.password !== 'string' ||
        b.password.length < 16 ||
        b.password.length > 256 ||
        typeof b.name !== 'string' ||
        !b.name.trim() ||
        b.name.length > 100
      )
        throw new HttpError(
          400,
          'Use a valid email, name, and password of 16–256 characters',
        );
      const encoded = await passwordHash(b.password);
      const user = await this.store.tx(async () => {
        await this.store.db.lock('identity:bootstrap');
        if (await this.store.one('SELECT id FROM users LIMIT 1'))
          throw new HttpError(409, 'Setup was completed by another user');
        return await this.store.createUser(b.email, b.name.trim(), encoded);
      });
      await this.session(user, reply);
      return user;
    });
    app.post(
      '/api/auth/login',
      { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
      async (req, reply) => {
        this.assertOrigin(req);
        const b = req.body as any;
        if (
          typeof b?.email !== 'string' ||
          typeof b?.password !== 'string' ||
          b.password.length > 256
        )
          throw new HttpError(400, 'Enter your email and password');
        const u = await this.store.userByEmail(b.email);
        // Hash even for an unknown account, to avoid a fast username oracle.
        const valid = await passwordValid(
          b.password,
          u?.password ?? '00000000000000000000000000000000:' + '00'.repeat(64),
        );
        if (!u || !u.password || !valid)
          throw new HttpError(401, 'Email or password is incorrect');
        const user = await this.store.publicUser(u.id);
        await this.session(user, reply, u.password);
        return user;
      },
    );
    app.post('/api/auth/demo', async (req, reply) => {
      this.assertOrigin(req);
      if (!this.settings.demo) throw new HttpError(404, 'Demo is unavailable');
      const u = await this.store.publicUser(
        (await this.store.userByEmail('demo@localhost')).id,
      );
      await this.session(u, reply);
      return u;
    });
    app.get('/api/me', async (req) => await this.user(req));
    app.post('/api/auth/logout', async (req, reply) => {
      this.assertOrigin(req);
      if (req.cookies.studio_session)
        await this.store.exec(
          'DELETE FROM sessions WHERE token=?',
          hash(req.cookies.studio_session),
        );
      reply.clearCookie('studio_session', { path: '/' });
      return { ok: true };
    });
    if (this.settings.oidcIssuer) {
      const issuer = new URL(this.settings.oidcIssuer),
        allowHttp =
          !this.settings.production &&
          this.settings.oidcAllowHttpLoopback &&
          issuer.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(issuer.hostname);
      if (issuer.protocol !== 'https:' && !allowHttp)
        throw new Error(
          'OIDC requires HTTPS; explicit development loopback opt-in is needed for an HTTP test issuer',
        );
      let discovery: Promise<oidc.Configuration> | undefined;
      const configuration = async () => {
        discovery ??= oidc.discovery(
          issuer,
          this.settings.oidcClientId!,
          this.settings.oidcClientSecret,
          undefined,
          allowHttp ? { execute: [oidc.allowInsecureRequests] } : undefined,
        );
        try {
          return await discovery;
        } catch {
          discovery = undefined;
          throw new HttpError(
            503,
            'The organization sign-in provider is temporarily unavailable',
          );
        }
      };
      app.get('/api/auth/oidc', async (_req, reply) => {
        const config = await configuration();
        const state = oidc.randomState(),
          nonce = oidc.randomNonce(),
          verifier = oidc.randomPKCECodeVerifier(),
          binding = randomBytes(32).toString('base64url');
        await this.store.tx(async () => {
          await this.store.db.lock('identity:oidc-challenges');
          await this.challenges.put(
            'oidc',
            state,
            binding,
            { verifier, nonce },
            Date.now() + 300000,
          );
        });
        reply.setCookie('studio_oidc', binding, {
          path: '/api/auth',
          httpOnly: true,
          sameSite: 'lax',
          secure: this.settings.production,
          maxAge: 300,
        });
        return reply.redirect(
          oidc.buildAuthorizationUrl(config, {
            redirect_uri: this.settings.origin + '/api/auth/callback',
            scope: 'openid email profile',
            state,
            nonce,
            code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
            code_challenge_method: 'S256',
          }).href,
        );
      });
      app.get('/api/auth/callback', async (req, reply) => {
        const url = new URL(req.url, this.settings.origin),
          state = url.searchParams.get('state') ?? '',
          challenge = await this.challenges.consume<{
            verifier: string;
            nonce: string;
          }>('oidc', state, req.cookies.studio_oidc ?? '');
        reply.clearCookie('studio_oidc', { path: '/api/auth' });
        if (!challenge) throw new HttpError(401, 'Sign-in expired. Try again.');
        const config = await configuration();
        const tokens = await oidc.authorizationCodeGrant(config, url, {
          pkceCodeVerifier: challenge.payload.verifier,
          expectedState: state,
          expectedNonce: challenge.payload.nonce,
        });
        const claims = tokens.claims();
        if (!claims?.sub || claims.email_verified === false)
          throw new HttpError(403, 'A verified email is required');
        let profile = claims;
        if (
          typeof claims.email !== 'string' ||
          claims.email_verified !== true
        ) {
          if (!tokens.access_token)
            throw new HttpError(403, 'A verified email is required');
          const info = await oidc.fetchUserInfo(
            config,
            tokens.access_token,
            claims.sub,
          );
          if (
            info.sub !== claims.sub ||
            (typeof claims.email === 'string' &&
              typeof info.email === 'string' &&
              claims.email.toLowerCase() !== info.email.toLowerCase())
          )
            throw new HttpError(403, 'Identity claims do not match');
          profile = { ...claims, ...info, sub: claims.sub };
        }
        if (
          typeof profile.email !== 'string' ||
          profile.email_verified !== true
        )
          throw new HttpError(403, 'A verified email is required');
        const email = profile.email,
          sub = this.settings.oidcIssuer + '|' + claims.sub;
        const existing = await this.store.tx(async () => {
          await this.store.db.lock('identity:admission');
          let current = await this.store.userByEmail(email);
          if (
            !current &&
            email.toLowerCase() === this.settings.adminEmail!.toLowerCase() &&
            !(await this.store.one('SELECT id FROM users LIMIT 1'))
          )
            current = await this.store.createUser(
              email,
              String(profile.name ?? 'Workspace owner').slice(0, 100),
              null,
              sub,
            );
          if (!current || (current.oidc_sub && current.oidc_sub !== sub))
            throw new HttpError(
              403,
              'Ask a workspace owner to add your account',
            );
          await this.store.exec(
            'UPDATE users SET oidc_sub=? WHERE id=?',
            sub,
            current.id,
          );
          return this.store.publicUser(current.id);
        });
        await this.session(existing, reply);
        return reply.redirect('/');
      });
    }
  }
}
