import { describe, expect, it } from 'vitest';
import { PactV3, SpecificationVersion } from '@pact-foundation/pact';
import pactCore from '@pact-foundation/pact-core';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { hash } from '../server/store.ts';
import {
  buildPreviewDocument,
  parsePreviewContracts,
  samplePreviewContract,
} from '../shared/preview.ts';
import { client, project, setup, testSettings } from './helpers.ts';

describe('Pact integration boundaries', () => {
  it('verifies the Studio consumer contract against the actual authenticated provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-pact-')),
      instance = await createApp(testSettings(dir), { db: ':memory:' });
    try {
      const { cookie, user } = await setup(instance.app),
        p = await project(
          client(instance.app, cookie),
          'Pact-backed workspace',
        );
      const token = 'test-studio-contract-token-not-a-real-credential';
      instance.store.exec(
        "INSERT INTO sessions VALUES(?,?,?,'api')",
        hash(token),
        user.id,
        Date.now() + 60000,
      );
      const contract = new PactV3({
        consumer: 'studio-web',
        provider: 'studio-api',
        dir: join(dir, 'pacts'),
        logLevel: 'error',
      });
      contract
        .uponReceiving('a member lists their projects')
        .withRequest({
          method: 'GET',
          path: '/api/projects',
          headers: { Authorization: `Bearer ${token}` },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: [p],
        });
      await contract.executeTest(async (mock) => {
        const response = await fetch(mock.url + '/api/projects', {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(200);
        const projects = await response.json();
        expect(projects).toEqual([p]);
        expect(projects[0]).toHaveProperty('mainArtifactId');
        expect(projects[0].role).toBe('owner');
      });
      const providerBaseUrl = await instance.app.listen({
        host: '127.0.0.1',
        port: 0,
      });
      const pactUrls = (await readdir(join(dir, 'pacts')))
        .filter((n) => n.endsWith('.json'))
        .map((n) => join(dir, 'pacts', n));
      expect(pactUrls).toHaveLength(1);
      // Use the native verifier directly: no provider-state hooks are needed.
      // The high-level JS wrapper forces even local providers through an
      // outbound proxy, whereas this verifier reaches the actual listening app.
      await pactCore.verifyPacts({
        providerBaseUrl,
        pactUrls,
        logLevel: 'error',
        providerVersion: 'local-contract-test',
      });
    } finally {
      await instance.app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('executes the same Pact boundary fixtures that power isolated code previews', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preview-pact-'));
    try {
      const fixture = parsePreviewContracts(
        JSON.stringify(samplePreviewContract),
      )!;
      const contract = new PactV3({
        consumer: fixture.consumer.name,
        provider: fixture.provider.name,
        spec: SpecificationVersion.SPECIFICATION_VERSION_V2,
        dir,
        logLevel: 'error',
      });
      for (const interaction of fixture.interactions)
        contract
          .uponReceiving(interaction.description)
          .withRequest(interaction.request)
          .willRespondWith(interaction.response);
      await contract.executeTest(async (mock) => {
        const response = await fetch(mock.url + '/api/project');
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          title: 'A new idea',
          status: 'draft',
          tasks: [],
        });
      });
      const preview = buildPreviewDocument(
        {
          'index.html': '<main id="project"></main>',
          'contracts.json': JSON.stringify(fixture),
          'main.js':
            "fetch('/api/project').then(r=>r.json()).then(p=>document.querySelector('#project').textContent=p.title)",
        },
        'index.html',
        'pact-boundary-test',
      );
      expect(preview).toContain("connect-src 'none'");
      expect(preview).toContain('Contract replay: ');
      expect(preview).toContain('No preview contract for ');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
