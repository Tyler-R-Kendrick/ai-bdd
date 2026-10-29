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
  if (env.STUDIO_MODEL && !env.AI_GATEWAY_API_KEY)
    throw new Error('STUDIO_MODEL requires AI_GATEWAY_API_KEY');
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
  constructor(
    readonly store: Store,
    readonly settings: Settings,
  ) {}
  async initialize() {
    this.store.exec('DELETE FROM sessions WHERE expires<?', Date.now());
    if (
      this.settings.adminPassword &&
      !this.store.userByEmail(this.settings.adminEmail!)
    )
      this.store.createUser(
        this.settings.adminEmail!,
        'Workspace owner',
        await passwordHash(this.settings.adminPassword),
      );
    if (this.settings.demo && !this.store.userByEmail('demo@localhost'))
      this.store.createUser('demo@localhost', 'Alex Morgan', null);
  }
  user(req: FastifyRequest): User {
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const token = bearer ?? req.cookies.studio_session;
    if (!token) throw new HttpError(401, 'Sign in to continue');
    const session = this.store.one(
      'SELECT user_id FROM sessions WHERE token=? AND expires>? AND kind=?',
      hash(token),
      Date.now(),
      bearer ? 'api' : 'session',
    );
    if (!session)
      throw new HttpError(401, 'Your session expired. Sign in again.');
    return this.store.publicUser(session.user_id);
  }
  assertOrigin(req: FastifyRequest) {
    if (req.headers.authorization?.match(/^Bearer (\S+)$/)) return;
    if (req.headers.origin !== this.settings.origin)
      throw new HttpError(403, 'Request origin is not allowed');
  }
  session(user: User, reply: FastifyReply) {
    const token = randomBytes(32).toString('base64url');
    this.store.exec(
      "INSERT INTO sessions VALUES(?,?,?,'session')",
      hash(token),
      user.id,
      Date.now() + 7 * 86400000,
    );
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
      setup: !this.store.one('SELECT id FROM users LIMIT 1'),
      demo: this.settings.demo,
      oidc: !!this.settings.oidcIssuer,
    }));
    app.post('/api/auth/setup', async (req, reply) => {
      this.assertOrigin(req);
      if (
        this.settings.production ||
        this.store.one('SELECT id FROM users LIMIT 1')
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
      const user = this.store.tx(() => {
        if (this.store.one('SELECT id FROM users LIMIT 1'))
          throw new HttpError(409, 'Setup was completed by another user');
        return this.store.createUser(b.email, b.name.trim(), encoded);
      });
      this.session(user, reply);
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
        const u = this.store.userByEmail(b.email);
        // Hash even for an unknown account, to avoid a fast username oracle.
        const valid = await passwordValid(
          b.password,
          u?.password ??
            '00000000000000000000000000000000:' + '00'.repeat(64),
        );
        if (!u || !u.password || !valid)
          throw new HttpError(401, 'Email or password is incorrect');
        const user = this.store.publicUser(u.id);
        this.session(user, reply);
        return user;
      },
    );
    app.post('/api/auth/demo', async (req, reply) => {
      this.assertOrigin(req);
      if (!this.settings.demo)
        throw new HttpError(404, 'Demo is unavailable');
      const u = this.store.publicUser(
        this.store.userByEmail('demo@localhost').id,
      );
      this.session(u, reply);
      return u;
    });
    app.get('/api/me', async (req) => this.user(req));
    app.post('/api/auth/logout', async (req, reply) => {
      this.assertOrigin(req);
      if (req.cookies.studio_session)
        this.store.exec(
          'DELETE FROM sessions WHERE token=?',
          hash(req.cookies.studio_session),
        );
      reply.clearCookie('studio_session', { path: '/' });
      return { ok: true };
    });
    if (this.settings.oidcIssuer) {
      const config = await oidc.discovery(
        new URL(this.settings.oidcIssuer),
        this.settings.oidcClientId!,
        this.settings.oidcClientSecret,
      );
      const pending = new Map<
        string,
        { verifier: string; nonce: string; expires: number }
      >();
      app.get('/api/auth/oidc', async (_req, reply) => {
        for (const [k, v] of pending)
          if (v.expires < Date.now()) pending.delete(k);
        if (pending.size >= 1000)
          throw new HttpError(429, 'Too many sign-in attempts');
        const state = oidc.randomState(),
          nonce = oidc.randomNonce(),
          verifier = oidc.randomPKCECodeVerifier();
        pending.set(state, { verifier, nonce, expires: Date.now() + 300000 });
        reply.setCookie('studio_oidc', state, {
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
          p = pending.get(state);
        pending.delete(state);
        if (!p || p.expires < Date.now() || req.cookies.studio_oidc !== state)
          throw new HttpError(401, 'Sign-in expired. Try again.');
        const tokens = await oidc.authorizationCodeGrant(config, url, {
          pkceCodeVerifier: p.verifier,
          expectedState: state,
          expectedNonce: p.nonce,
        });
        const claims = tokens.claims();
        if (
          !claims?.sub ||
          typeof claims.email !== 'string' ||
          claims.email_verified !== true
        )
          throw new HttpError(403, 'A verified email is required');
        const sub = this.settings.oidcIssuer + '|' + claims.sub;
        // Admission is explicit: an owner must create the account before its first OIDC sign-in.
        let existing = this.store.userByEmail(claims.email);
        if (
          !existing &&
          claims.email.toLowerCase() ===
            this.settings.adminEmail!.toLowerCase() &&
          !this.store.one('SELECT id FROM users LIMIT 1')
        )
          existing = this.store.createUser(
            claims.email,
            String(claims.name ?? 'Workspace owner').slice(0, 100),
            null,
            sub,
          );
        if (!existing || (existing.oidc_sub && existing.oidc_sub !== sub))
          throw new HttpError(
            403,
            'Ask a workspace owner to add your account',
          );
        this.store.exec(
          'UPDATE users SET oidc_sub=? WHERE id=?',
          sub,
          existing.id,
        );
        this.session(this.store.publicUser(existing.id), reply);
        reply.clearCookie('studio_oidc', { path: '/api/auth' });
        return reply.redirect('/');
      });
    }
  }
}
