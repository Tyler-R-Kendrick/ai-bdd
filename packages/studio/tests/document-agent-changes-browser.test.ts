import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { hash } from '../server/store.ts';
import { documentNodeSource } from '../shared/document-digest.ts';

let browser: Browser, server: Server, origin: string;
const source = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'stable-paragraph' },
      content: [{ type: 'text', text: 'New agent paragraph' }],
    },
  ],
};
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {Editor,Extension} from '@tiptap/core';
        import StarterKit from '@tiptap/starter-kit';
        import {AgentChangeDecorations,AgentChangeMarkers} from './client/editors/document/AgentChanges.tsx';
        import {DocumentWorkspaceProvider} from './client/editors/document/Workspace.tsx';
        const source=${JSON.stringify(source)};
        const initial=structuredClone(source);
        if(new URL(location.href).searchParams.has('delayed'))initial.content[0].content[0].text='Old human paragraph';
        const anchors=Extension.create({name:'testParagraphIds',addGlobalAttributes(){return [{types:['paragraph'],attributes:{id:{default:null}}}];}});
        const editor=new Editor({element:document.getElementById('editor'),extensions:[StarterKit,anchors,AgentChangeDecorations],content:initial});
        const artifact={id:'artifact',projectId:'project',kind:'design',title:'Delayed document fixture',version:2,content:{doc:source}};
        window.publishContent=()=>editor.commands.setContent(source);
        createRoot(document.getElementById('react')).render(
          <DocumentWorkspaceProvider artifact={artifact} user={{id:'user',name:'Viewer'}} readOnly runs={[]} editor={editor} onError={()=>{}} onTests={()=>{}} onComment={()=>{}}>
            <AgentChangeMarkers/>
          </DocumentWorkspaceProvider>
        );
      `,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  const script = bundle.outputFiles[0]!.text;
  server = createServer((request, response) => {
    if (request.url === '/fixture.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(script);
      return;
    }
    if (request.url?.startsWith('/api/')) {
      response.setHeader('content-type', 'application/json');
      if (request.url.endsWith('/document/agent-changes')) {
        response.end(
          JSON.stringify([
            {
              anchor: 'stable-paragraph',
              digest: hash(documentNodeSource(source.content[0])),
              version: 2,
              actor: 'Agent owner',
              source: 'Accepted agent proposal',
              createdAt: new Date().toISOString(),
              expiresAt: Date.now() + 30000,
            },
          ]),
        );
      } else if (request.url.endsWith('/document/review')) {
        response.end(
          JSON.stringify({
            suggestions: [],
            answers: [],
            anchors: [],
            pagination: {
              suggestions: { hasMore: false, nextCursor: null },
              answers: { hasMore: false, nextCursor: null },
            },
          }),
        );
      } else if (request.url.endsWith('/integrations/jobs')) {
        response.end('{"jobs":[]}');
      } else response.end('[]');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(
      '<!doctype html><div id="editor"></div><div id="react"></div><script type="module" src="/fixture.js"></script>',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.STUDIO_CHROMIUM_PATH
      ? { executablePath: process.env.STUDIO_CHROMIUM_PATH }
      : existsSync('/usr/bin/chromium')
        ? { executablePath: '/usr/bin/chromium' }
        : {}),
  });
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

it.each(['already-synced', 'metadata-first'] as const)(
  'renders exact current-node provenance when %s',
  async (ordering) => {
    const page = await browser.newPage();
    try {
      const markerResponse = page.waitForResponse((response) =>
        response.url().endsWith('/document/agent-changes'),
      );
      await page.goto(
        origin + (ordering === 'metadata-first' ? '/?delayed=1' : '/'),
      );
      await markerResponse;
      if (ordering === 'metadata-first') {
        // Metadata has arrived; the unchanged artifact.version already describes the new source.
        // Let its React effect inspect the old editor state before the source transaction arrives.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        expect(await page.locator('#editor p').textContent()).toBe(
          'Old human paragraph',
        );
        await page.evaluate(() => (window as any).publishContent());
      }
      await expect
        .poll(
          () => page.locator('#editor [data-agent-change="true"]').count(),
          { timeout: 1500 },
        )
        .toBe(1);
      expect(await page.locator('#editor p').textContent()).toBe(
        'New agent paragraph',
      );
    } finally {
      await page.close();
    }
  },
);
