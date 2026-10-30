import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { selectAgent } from '../server/machine/agent-launch.ts';
import {
  canonicalCloneRepository,
  managedClone,
} from '../server/machine/clone-registry.ts';
import {
  runConnectorCLI,
  ConnectorUsageError,
} from '../server/machine/connector-cli.ts';
import {
  connectorServiceAction,
  installConnectorService,
  readServiceConfiguration,
  serviceLocation,
  serviceTemplate,
} from '../server/machine/service-install.ts';
import { AcpClient } from '../server/machine-worker.ts';
import { privateJson } from '../server/machine/runtime.ts';
const execute = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
beforeAll(async () => {
  await execute(process.execPath, ['scripts/build-connector.mjs'], {
    timeout: 30000,
  });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'studio-connector-cli-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function serviceFixture() {
  const dir = await directory();
  const env = {
    PATH: process.env.PATH,
    STUDIO_API_URL: 'https://studio.example.test',
    STUDIO_MACHINE_CREDENTIALS: join(dir, 'credential.json'),
    STUDIO_MACHINE_STATE_DIR: join(dir, 'private state % $'),
    STUDIO_MACHINE_AGENT_COMMAND: process.execPath,
    STUDIO_MACHINE_AGENT_ARGS: '[]',
    STUDIO_MACHINE_SCOPE: 'account',
    STUDIO_MACHINE_CLONE_ATTACHED: 'true',
    STUDIO_MACHINE_PAIR_CODE: 'one-time-fixture-must-not-persist',
    OPENAI_API_KEY: 'provider-fixture-must-not-persist',
  };
  await privateJson(env.STUDIO_MACHINE_CREDENTIALS, {
    scope: 'account',
    id: crypto.randomUUID(),
    token: 'S'.repeat(43),
    origin: env.STUDIO_API_URL,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  const calls: { command: string; args: string[] }[] = [];
  const manager = async (command: string, args: string[]) => {
    calls.push({ command, args });
    return {
      stdout: args.includes('is-active') ? 'active\n' : 'state = running\n',
    };
  };
  return { dir, env, calls, manager, entryFile: resolve('dist/connector.mjs') };
}
describe('Explicit portable connector setup', () => {
  it('launches the installed Copilot and Atomic preset argv through actual ACP without credential transfer', async () => {
    const dir = await directory();
    const output = join(dir, 'observed.json');
    const script = `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),leaked:Object.keys(process.env).filter(k=>k.startsWith('STUDIO_'))}));
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});else if(m.method==='session/new')send({id:m.id,result:{sessionId:'fixture'}});else if(m.method==='session/prompt'){send({method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({summary:'Actual local ACP process fixture completed'})}}}});send({id:m.id,result:{stopReason:'end_turn'}});}});
`;
    for (const [preset, name, args] of [
      ['copilot', 'copilot', ['--acp', '--stdio']],
      ['atomic', 'atomic-acp', []],
    ] as const) {
      const file = join(dir, name);
      await writeFile(file, script, { mode: 0o700 });
      const selected = await selectAgent({ preset }, { PATH: dir });
      expect(selected).toEqual({ command: file, args: [...args] });
      const client = new AcpClient({
        ...selected,
        cwd: dir,
        signal: AbortSignal.timeout(10000),
      });
      try {
        expect(await client.run({ kind: 'explicit fixture' })).toMatchObject({
          summary: 'Actual local ACP process fixture completed',
        });
      } finally {
        await client.close();
      }
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
        args: [...args],
        leaked: [],
      });
    }
    await expect(selectAgent({ preset: 't3' }, { PATH: dir })).rejects.toThrow(
      'thread/MCP',
    );
    await expect(selectAgent({ preset: '__proto__' }, {})).rejects.toThrow();
    await expect(
      selectAgent({ preset: 'copilot', custom: ['other'] }, {}),
    ).rejects.toThrow('Choose');
  });
  it('parses explicit clone/agent choices, keeps legacy credential locations and never installs implicitly', async () => {
    const dir = await directory();
    const seen: { env: NodeJS.ProcessEnv; once?: boolean }[] = [];
    let paired = 0;
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      runConnectorCLI({
        args,
        env,
        entryFile: resolve('dist/connector.mjs'),
        runWorker: async (env, once) => {
          seen.push({ env, once });
        },
        prepareCredentials: async () => {
          paired++;
        },
      });
    const agentEntry = join(dir, 'agent.mjs');
    await writeFile(agentEntry, '// Explicit operator-selected entrypoint\n');
    expect(
      (
        await selectAgent(
          { custom: [process.execPath, 'agent.mjs'] },
          { STUDIO_MACHINE_CWD: dir },
        )
      ).args,
    ).toEqual([agentEntry]);
    await run([
      'connect',
      '--clone',
      'https://github.com/Example/One.git',
      '--clone-attached',
      '--checkout',
      dir,
      '--once',
      '--',
      process.execPath,
      agentEntry,
    ]);
    expect(seen[0]!.env.STUDIO_MACHINE_CLONE_REPOSITORIES).toBe(
      '["https://github.com/example/one"]',
    );
    expect(seen[0]!.env.STUDIO_MACHINE_SCOPE).toBe('account');
    expect(JSON.parse(seen[0]!.env.STUDIO_MACHINE_AGENT_ARGS!)).toEqual([
      agentEntry,
    ]);
    expect(JSON.parse(seen[0]!.env.STUDIO_MACHINE_CHECKOUTS!)[0].path).toBe(
      dir,
    );
    expect(seen[0]!.once).toBe(true);
    expect(paired).toBe(0);
    await run(['--once'], { STUDIO_MACHINE_AGENT_COMMAND: process.execPath });
    expect(seen[1]!.env.STUDIO_MACHINE_CREDENTIALS).toBe(
      resolve('.studio-machine.json'),
    );
    await expect(
      run(['connect', '--once', '--install-service']),
    ).rejects.toThrow('cannot be installed');
    await expect(run(['--wat'])).rejects.toThrow('Unknown');
  });
  it('rejects credential-bearing, outside-host and path-like clone targets before Git, and rejects symlink/private-root replacement', async () => {
    const dir = await directory();
    for (const value of [
      'https://token@github.com/o/r',
      'file:///tmp/repo',
      'https://example.com/o/r',
      'https://github.com/o/..',
      '-c core.hooksPath=bad',
      'https://github.com/o/r?q=secret',
    ])
      expect(() => canonicalCloneRepository(value)).toThrow();
    const shared = join(dir, 'shared');
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(shared, { mode: 0o755 }),
    );
    await chmod(shared, 0o755);
    await expect(
      managedClone('https://github.com/example/test', shared, {}),
    ).rejects.toThrow('private');
    const link = join(dir, 'link');
    await symlink(dir, link);
    await expect(
      managedClone('https://github.com/example/test', link, {}),
    ).rejects.toThrow('private');
  });
  it('installs, checks and uninstalls user-only Linux/macOS definitions without persisting pairing/provider credentials', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const f = await serviceFixture();
      const options = { ...f, platform, home: f.dir };
      expect(await installConnectorService(options)).toMatchObject({
        installed: true,
        platform,
      });
      const location = serviceLocation(f.env, options);
      const config = await readServiceConfiguration(location.configPath);
      const text = await readFile(location.configPath, 'utf8');
      expect(text).not.toContain('one-time-fixture');
      expect(text).not.toContain('provider-fixture');
      expect((await stat(location.configPath)).mode & 0o077).toBe(0);
      expect(
        await connectorServiceAction('status', f.env, options),
      ).toMatchObject({
        installed: true,
        active: true,
        managerAvailable: true,
      });
      if (platform === 'linux') {
        await execute('systemd-analyze', ['verify', location.unitPath], {
          timeout: 10000,
        });
        expect(await readFile(location.unitPath, 'utf8')).toContain('%% $$');
      } else {
        const plist = await readFile(location.unitPath, 'utf8');
        await execute('python3', [
          '-c',
          'import plistlib,sys; x=plistlib.load(open(sys.argv[1],"rb")); assert x["RunAtLoad"] and x["ProgramArguments"][2]=="--service-run"',
          location.unitPath,
        ]);
        expect(plist).not.toContain('one-time-fixture');
      }
      await expect(installConnectorService(options)).rejects.toThrow(
        'already exists',
      );
      expect(await connectorServiceAction('uninstall', f.env, options)).toEqual(
        { installed: false, active: false },
      );
      expect(await connectorServiceAction('status', f.env, options)).toEqual({
        installed: false,
        active: false,
      });
      expect(
        JSON.parse(await readFile(f.env.STUDIO_MACHINE_CREDENTIALS, 'utf8'))
          .scope,
      ).toBe('account');
      expect(config.entrySha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it('retains uncertain activation and changed definitions for explicit review rather than deleting a possibly live service', async () => {
    const f = await serviceFixture();
    const options = {
      ...f,
      platform: 'linux' as const,
      home: f.dir,
      manager: async (_command: string, args: string[]) => {
        if (args.includes('enable') || args.includes('disable'))
          throw new Error('Fixture unavailable');
        return {};
      },
    };
    await expect(installConnectorService(options)).rejects.toThrow('uncertain');
    const location = serviceLocation(f.env, options);
    expect(await stat(location.configPath)).toBeDefined();
    await expect(
      runConnectorCLI({
        args: ['service', 'status'],
        env: f.env,
        entryFile: f.entryFile,
        runWorker: async () => {},
        prepareCredentials: async () => {},
      }),
    ).rejects.toBeInstanceOf(ConnectorUsageError);
    await writeFile(location.unitPath, 'operator changed definition');
    await expect(
      connectorServiceAction('uninstall', f.env, {
        ...options,
        manager: f.manager,
      }),
    ).rejects.toThrow('changed');
    await expect(
      installConnectorService({ ...f, platform: 'win32' }),
    ).rejects.toThrow('foreground');
    expect(
      serviceTemplate(
        {
          id: 'a'.repeat(16),
          node: '/node',
          entry: '/entry',
          platform: 'darwin',
        },
        '/a&b',
      ),
    ).toContain('/a&amp;b');
  });
  it('boots the actual portable service bundle, contacts Studio with the private credential and stops cleanly', async () => {
    const f = await serviceFixture();
    const app = Fastify();
    let connected!: () => void;
    const contact = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const credential = JSON.parse(
      await readFile(f.env.STUDIO_MACHINE_CREDENTIALS, 'utf8'),
    );
    app.get('/api/account-machines/:id/repositories', async (request) => {
      expect(request.headers.authorization).toBe('Bearer ' + credential.token);
      return { repositories: [] };
    });
    app.post('/api/account-machines/:id/assignments', async () => {
      connected();
      return { assignments: [], blocked: [] };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    f.env.STUDIO_API_URL = app.listeningOrigin;
    credential.origin = app.listeningOrigin;
    await privateJson(f.env.STUDIO_MACHINE_CREDENTIALS, credential);
    const options = { ...f, platform: 'linux' as const, home: f.dir };
    await installConnectorService(options);
    const location = serviceLocation(f.env, options);
    const config = await readServiceConfiguration(location.configPath);
    const child = spawn(
      process.execPath,
      [config.entry, '--service-run', location.configPath],
      {
        env: {
          ...process.env,
          STUDIO_MACHINE_PAIR_CODE: 'must-be-ignored-by-service-bootstrap',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stopped = once(child, 'close');
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    try {
      await Promise.race([
        contact,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  'Service bootstrap did not contact the local HTTP fixture',
                ),
              ),
            10000,
          ),
        ),
      ]);
      child.kill('SIGTERM');
      expect((await stopped)[0], stderr).toBe(0);
      await expect(
        stat(join(f.env.STUDIO_MACHINE_STATE_DIR, '.lock')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 20000);
});
