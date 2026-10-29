import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

type Account = { id: number; login: string };
type Grant = { user: Account; refresh: string };
export async function githubFixture() {
  const clientId = 'Iv1.studio-fixture',
    clientSecret = 'fixture-client-secret',
    codes = new Map<
      string,
      { user: Account; challenge: string; redirect: string }
    >(),
    tokens = new Map<string, Grant>(),
    refreshes = new Map<string, Account>(),
    permissions = new Map<string, { pull: boolean; push: boolean }>();
  const requests: { path: string; authorization: string }[] = [],
    selected: { user: Account } = { user: { id: 101, login: 'alice-fixture' } };
  let origin = '',
    lastAccess = '',
    refreshCount = 0,
    revocations = 0,
    repoGate: (() => Promise<void>) | undefined,
    tokenGate: (() => Promise<void>) | undefined,
    userGate: (() => Promise<void>) | undefined;
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
      if (chunks.reduce((s, c) => s + c.length, 0) > 65536)
        throw new Error('Fixture request too large');
    }
    return Buffer.concat(chunks).toString();
  };
  const issue = (user: Account) => {
    const access = 'test-ghu-' + randomBytes(12).toString('base64url'),
      refresh = 'test-ghr-' + randomBytes(12).toString('base64url');
    tokens.set(access, { user, refresh });
    refreshes.set(refresh, user);
    lastAccess = access;
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: 120,
      refresh_token_expires_in: 3600,
      scope: 'read:user repo',
    };
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      requests.push({
        path: url.pathname,
        authorization: String(req.headers.authorization ?? ''),
      });
      if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
        if (
          url.searchParams.get('client_id') !== clientId ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          !url.searchParams.get('code_challenge')
        )
          return json(res, 400, { error: 'invalid_authorization_request' });
        const code = randomBytes(20).toString('base64url'),
          redirect = url.searchParams.get('redirect_uri')!;
        codes.set(code, {
          user: selected.user,
          challenge: url.searchParams.get('code_challenge')!,
          redirect,
        });
        const callback = new URL(redirect);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { location: callback.href });
        return res.end();
      }
      if (
        req.method === 'POST' &&
        url.pathname === '/login/oauth/access_token'
      ) {
        const form = new URLSearchParams(await body(req));
        if (
          form.get('client_id') !== clientId ||
          form.get('client_secret') !== clientSecret
        )
          return json(res, 401, { error: 'invalid_client' });
        if (tokenGate) await tokenGate();
        if (form.get('grant_type') === 'refresh_token') {
          const refresh = form.get('refresh_token')!,
            account = refreshes.get(refresh);
          if (!account) return json(res, 200, { error: 'bad_refresh_token' });
          refreshes.delete(refresh);
          refreshCount++;
          return json(res, 200, issue(account));
        }
        const code = form.get('code')!,
          grant = codes.get(code);
        codes.delete(code);
        if (
          !grant ||
          grant.redirect !== form.get('redirect_uri') ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== grant.challenge
        )
          return json(res, 200, { error: 'bad_verification_code' });
        return json(res, 200, issue(grant.user));
      }
      if (
        req.method === 'DELETE' &&
        url.pathname === `/applications/${clientId}/token`
      ) {
        if (
          req.headers.authorization !==
          'Basic ' +
            Buffer.from(clientId + ':' + clientSecret).toString('base64')
        )
          return json(res, 401, { error: 'invalid_client' });
        const parsed = JSON.parse(await body(req)),
          grant = tokens.get(parsed.access_token);
        if (grant) {
          tokens.delete(parsed.access_token);
          refreshes.delete(grant.refresh);
        }
        revocations++;
        res.writeHead(204);
        return res.end();
      }
      const access = String(req.headers.authorization ?? '').match(
          /^Bearer (.+)$/,
        )?.[1],
        grant = access && tokens.get(access);
      if (!grant) return json(res, 401, { error: 'bad_credentials' });
      if (url.pathname === '/user') {
        if (userGate) await userGate();
        return json(res, 200, grant.user);
      }
      const match = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(url.pathname);
      if (match) {
        const key = match[1]!.toLowerCase(),
          permission = permissions.get(grant.user.id + ':' + key) ?? {
            pull: false,
            push: false,
          };
        if (!match[2]) {
          const captured = { ...permission };
          if (repoGate) await repoGate();
          return json(res, 200, {
            full_name: key,
            private: true,
            permissions: captured,
          });
        }
        if (!permission.pull) return json(res, 404, { error: 'not_found' });
        if (/^\/pulls\/\d+$/.test(match[2]!))
          return json(res, 200, {
            number: Number(match[2]!.split('/').pop()),
            title: 'Protected fixture change',
            state: 'open',
            html_url: `https://github.com/${key}/pull/7`,
          });
        if (/^\/issues\/\d+$/.test(match[2]!))
          return json(res, 200, {
            number: Number(match[2]!.split('/').pop()),
            title: 'Protected fixture issue',
            state: 'open',
          });
        if (match[2]!.startsWith('/contents/'))
          return json(res, 200, {
            name: 'README.md',
            size: 24,
            encoding: 'base64',
            content: Buffer.from('Protected fixture source').toString('base64'),
          });
        if (match[2] === '/commits')
          return json(res, 200, [
            {
              sha: 'a'.repeat(40),
              commit: { message: 'Protected fixture commit' },
            },
          ]);
      }
      return json(res, 404, { error: 'not_found' });
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'fixture_failure' });
      else res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    clientId,
    clientSecret,
    requests,
    selected,
    get lastAccess() {
      return lastAccess;
    },
    get refreshCount() {
      return refreshCount;
    },
    get revocations() {
      return revocations;
    },
    permissions,
    gateUser(gate?: () => Promise<void>) {
      userGate = gate;
    },
    gateRepository(gate?: () => Promise<void>) {
      repoGate = gate;
    },
    gateToken(gate?: () => Promise<void>) {
      tokenGate = gate;
    },
    revokeAccess(access: string) {
      tokens.delete(access);
    },
    revokeRefreshes() {
      refreshes.clear();
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
