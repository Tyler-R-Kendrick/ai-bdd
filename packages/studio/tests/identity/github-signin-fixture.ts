/**
 * Owned OAuth provider boundary for tests. This module is never imported by a
 * shipping entrypoint. Studio still owns browser binding, durable single-use
 * state, PKCE, account admission and session issuance.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { GitHubSignInProvider } from '../../server/github-signin.ts';

type Account = {
  id: string;
  login: string;
  name: string;
  verifiedEmails: string[];
};
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);
const sha = (value: string) => createHash('sha256').update(value).digest('base64url');
export async function githubSignInFixture() {
  let origin = '', exchanges = 0, fail = false;
  const accounts = new Map<string, Account>();
  const codes = new Map<string, { challenge: string; redirectUri: string; account: Account }>();
  function account(email: string): Account {
    const normalized = email.toLowerCase();
    let value = accounts.get(normalized);
    if (!value) {
      value = {
        id: (BigInt('0x' + createHash('sha256').update(normalized).digest('hex').slice(0, 12)) + 1n).toString(),
        login: 'fixture-' + createHash('sha256').update(normalized).digest('hex').slice(0, 12),
        name: 'GitHub acceptance actor',
        verifiedEmails: [normalized],
      };
      accounts.set(normalized, value);
    }
    return value;
  }
  function callbackFor(email: string, authorizationUrl: string) {
    const input = new URL(authorizationUrl);
    if (input.origin !== origin || input.pathname !== '/authorize') throw new Error('Unknown fixture authorization request');
    const state = input.searchParams.get('state') ?? '',
      challenge = input.searchParams.get('code_challenge') ?? '',
      redirectUri = input.searchParams.get('redirect_uri') ?? '';
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error('Fixture requires OAuth state and S256 PKCE');
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(redirect.hostname) || redirect.pathname !== '/api/auth/github/callback') throw new Error('Fixture callback must be an owned loopback Studio');
    const code = randomBytes(24).toString('base64url');
    codes.set(code, { challenge, redirectUri, account: account(email) });
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', state);
    return redirect.href;
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname !== '/authorize') { res.writeHead(404); res.end(); return; }
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error('Fixture request bound'); }
        const email = new URLSearchParams(body).get('email') ?? '';
        if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Choose a synthetic fixture email');
        res.writeHead(302, { location: callbackFor(email, url.href) });
        res.end();
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owned GitHub OAuth test provider</title><body><main><h1>Owned GitHub OAuth test provider</h1><p>This loopback provider uses synthetic identities. Studio validates the real OAuth callback.</p><form method="post" action="${escape(url.pathname + url.search)}"><label>Fixture GitHub email <input name="email" type="email" required autofocus></label><button type="submit">Continue fixture GitHub sign-in</button></form></main></body></html>`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('The owned OAuth fixture rejected this request.');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const provider: GitHubSignInProvider = {
    authorizationUrl({ state, codeChallenge, redirectUri }) {
      const url = new URL('/authorize', origin);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('redirect_uri', redirectUri);
      return url.href;
    },
    async authenticate({ code, verifier, redirectUri }) {
      exchanges++;
      const grant = codes.get(code);
      codes.delete(code);
      if (fail || !grant || grant.challenge !== sha(verifier) || grant.redirectUri !== redirectUri) throw new Error('Owned OAuth fixture exchange rejected');
      return structuredClone(grant.account);
    },
  };
  return {
    origin, provider, accounts, account, callbackFor,
    get tokenRequests() { return exchanges; },
    failTokens(value: boolean) { fail = value; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
