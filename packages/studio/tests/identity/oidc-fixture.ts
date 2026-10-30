import Provider from 'oidc-provider';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';

export async function oidcFixture(redirectUri: string) {
  const clientId = 'studio-oidc-fixture',
    clientSecret = 'local-issuer-test-client-secret',
    accounts: Record<
      string,
      { email: string; verified: boolean; name: string }
    > = {
      alice: {
        email: 'alice@example.test',
        verified: true,
        name: 'Alice Verified',
      },
      outsider: {
        email: 'outsider@example.test',
        verified: true,
        name: 'Unadmitted User',
      },
      unverified: {
        email: 'unverified@example.test',
        verified: false,
        name: 'Unverified User',
      },
    };
  let provider: Provider,
    failToken = false,
    faultMetadata = false,
    tokenRequests = 0,
    origin = '';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      if (url.pathname === '/token') {
        tokenRequests++;
        if (failToken) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'temporarily_unavailable' }));
          return;
        }
      }
      if (
        url.pathname === '/.well-known/openid-configuration' &&
        faultMetadata
      ) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: origin + '/wrong-issuer',
            authorization_endpoint: origin + '/auth',
            token_endpoint: origin + '/token',
            jwks_uri: origin + '/jwks',
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
          }),
        );
        return;
      }
      if (url.pathname.startsWith('/interaction/')) {
        const interaction = await provider.interactionDetails(req, res);
        if (interaction.prompt.name === 'consent') {
          const grant = interaction.grantId
            ? await provider.Grant.find(interaction.grantId)
            : new provider.Grant({
                accountId: interaction.session!.accountId,
                clientId: String(interaction.params.client_id),
              });
          if (!grant) throw new Error('No issuer grant');
          const missing = interaction.prompt.details.missingOIDCScope as
            | string[]
            | undefined;
          if (missing?.length) grant.addOIDCScope(missing.join(' '));
          const claims = interaction.prompt.details.missingOIDCClaims as
            | string[]
            | undefined;
          if (claims?.length) grant.addOIDCClaims(claims);
          const grantId = await grant.save();
          await provider.interactionFinished(
            req,
            res,
            { consent: { grantId } },
            { mergeWithLastSubmission: true },
          );
          return;
        }
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const account =
            new URLSearchParams(Buffer.concat(chunks).toString()).get(
              'account',
            ) ?? '';
          if (!accounts[account]) {
            res.writeHead(400);
            res.end('Unknown fixture account');
            return;
          }
          await provider.interactionFinished(
            req,
            res,
            { login: { accountId: account } },
            { mergeWithLastSubmission: false },
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local OIDC acceptance issuer</title><body><main><h1>Local OIDC acceptance issuer</h1><p>This is the actual test authorization server. Choose a synthetic account.</p><form method="post"><label>Fixture account <select name="account"><option value="alice">Alice — admitted and verified</option><option value="outsider">Outsider — verified, not admitted</option><option value="unverified">Unverified email</option></select></label><button type="submit">Continue sign-in</button></form></main></body></html>`,
        );
        return;
      }
      provider.callback()(req, res);
    } catch {
      if (!res.headersSent)
        res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('The local issuer could not complete this request.');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  provider = new Provider(origin, {
    clients: [
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: [redirectUri],
        response_types: ['code'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    ],
    jwks: {
      keys: [
        {
          ...privateKey.export({ format: 'jwk' }),
          kid: 'local-acceptance-issuer-key',
          alg: 'RS256',
          use: 'sig',
        },
      ],
    },
    cookies: { keys: ['acceptance-only-cookie-signing-key-not-production'] },
    features: { devInteractions: { enabled: false } },
    pkce: { required: () => true },
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name'],
    },
    interactions: {
      url: (_ctx, interaction) => '/interaction/' + interaction.uid,
    },
    async findAccount(_ctx, id) {
      const account = accounts[id];
      if (!account) return undefined;
      return {
        accountId: id,
        async claims() {
          return {
            sub: id,
            email: account.email,
            email_verified: account.verified,
            name: account.name,
          };
        },
      };
    },
  });
  return {
    origin,
    clientId,
    clientSecret,
    provider,
    accounts,
    get tokenRequests() {
      return tokenRequests;
    },
    failTokens(value: boolean) {
      failToken = value;
    },
    faultDiscovery(value: boolean) {
      faultMetadata = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
