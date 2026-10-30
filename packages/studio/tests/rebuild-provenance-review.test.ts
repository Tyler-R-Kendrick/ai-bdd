import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runRebuildOnce } from '../server/machine/rebuild-worker.ts';
const execute = promisify(execFile),
  hash = (source: string | Buffer) =>
    createHash('sha256').update(source).digest('hex');
it('records the actual ACP argument file executed after changing from operator checkout to sealed PR worktree', async () => {
  const dir = await mkdtemp('/tmp/studio-rebuild-provenance-review-'),
    cwd = join(dir, 'repo'),
    marker = join(dir, 'actual-agent-files.jsonl'),
    machineId = randomUUID(),
    queueId = randomUUID(),
    token = randomBytes(32).toString('base64url'),
    leaseToken = randomBytes(32).toString('base64url'),
    repository = 'https://github.com/example/rebuild-runtime-review';
  let origin = '',
    reported: any;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) raw += part;
    const body = raw ? JSON.parse(raw) : undefined;
    response.setHeader('content-type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end('{}');
      return;
    }
    const path = new URL(request.url!, origin).pathname;
    if (path.endsWith('/claim'))
      response.end(
        JSON.stringify({
          work: {
            id: queueId,
            generation: 1,
            artifactId: randomUUID(),
            repository,
            pullRequests: [
              {
                url: repository + '/pull/7',
                branch: 'review/existing-pr',
                commit: sealedCommit,
              },
            ],
            sourceSha256: 'a'.repeat(64),
          },
          leaseToken,
        }),
      );
    else if (path.endsWith('/start')) {
      reported = body.runtime;
      response.end('{"ok":true}');
    } else if (path.endsWith('/verifier'))
      response.end(
        JSON.stringify({
          verifierToken: randomBytes(32).toString('base64url'),
        }),
      );
    else if (path.endsWith('/read')) response.end('{"status":"completed"}');
    else response.end('{"ok":true}');
  });
  let sealedCommit = '';
  try {
    await mkdir(cwd);
    await execute('git', ['init', cwd]);
    for (const [key, value] of [
      ['user.email', 'provenance-fixture@example.test'],
      ['user.name', 'Independent runtime review'],
      ['remote.origin.url', repository],
    ])
      await execute('git', ['-C', cwd, 'config', key, value]);
    const script = (version: string) =>
      `import readline from'node:readline';import{readFile,appendFile}from'node:fs/promises';import{createHash}from'node:crypto';import{fileURLToPath}from'node:url';const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});else if(m.method==='session/new')send({id:m.id,result:{sessionId:'${version}'}});else if(m.method==='session/prompt'){await appendFile(${JSON.stringify(marker)},JSON.stringify({version:'${version}',sha256:createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')})+'\\n');send({id:m.id,result:{stopReason:'end_turn'}});}}`;
    await writeFile(join(cwd, 'agent.mjs'), script('sealed-pr-version'));
    await execute('git', ['-C', cwd, 'add', 'agent.mjs']);
    await execute('git', ['-C', cwd, 'commit', '-m', 'Sealed PR agent file']);
    sealedCommit = (
      await execute('git', ['-C', cwd, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    const operatorScript = script('operator-selected-version');
    await writeFile(join(cwd, 'agent.mjs'), operatorScript);
    await execute('git', ['-C', cwd, 'add', 'agent.mjs']);
    await execute('git', [
      '-C',
      cwd,
      'commit',
      '-m',
      'Operator selected agent file',
    ]);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // Actual Git worktrees + actual Node ACP processes + actual HTTP transport.
    // The protocol fixture isolates launch provenance; it does not claim server-side build verification.
    await runRebuildOnce(
      {
        id: machineId,
        origin,
        token,
        expires: new Date(Date.now() + 3600000).toISOString(),
      } as any,
      {
        cwd,
        stateDirectory: join(dir, 'private-state'),
        command: process.execPath,
        args: ['agent.mjs'],
      },
    );
    const actual = (await readFile(marker, 'utf8'))
      .trim()
      .split('\n')
      .map((value) => JSON.parse(value));
    expect(actual).toHaveLength(2);
    expect(reported.argumentFileSha256).toBe(hash(operatorScript));
    expect(
      actual.every((row) => row.sha256 === reported.argumentFileSha256),
    ).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);
