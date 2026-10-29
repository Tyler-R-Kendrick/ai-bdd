import { createHash } from 'node:crypto';
import { z } from 'zod';
import { researchSourceSchema, type ResearchSource } from '../../shared/integrations.ts';
import type { IntegrationSettings } from './settings.ts';
import { boundedJson } from './http.ts';

/** The source service receives only the submitted brief, never private artifact context. */
export async function researchSources(brief: string, settings: IntegrationSettings, signal: AbortSignal, request: typeof fetch = fetch): Promise<ResearchSource[]> {
  let sources: z.infer<typeof researchSourceSchema>[];
  if (settings.searchUrl) {
    const response = await request(settings.searchUrl, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(settings.searchToken ? { Authorization: `Bearer ${settings.searchToken}` } : {}) },
      body: JSON.stringify({ query: brief, limit: 8 }),
    });
    const data = await boundedJson(response, signal);
    sources = z.object({ sources: z.array(researchSourceSchema).max(8) }).strict().parse(data).sources;
  } else {
    // Public, credential-free source corpus. Its narrower scope is identified in the resulting note.
    const url = new URL('https://en.wikipedia.org/w/api.php');
    url.search = new URLSearchParams({ action: 'query', format: 'json', generator: 'search', gsrsearch: brief, gsrlimit: '6', prop: 'extracts|info', exintro: '1', explaintext: '1', exchars: '8000', inprop: 'url', redirects: '1' }).toString();
    const data = await boundedJson(await request(url, { redirect: 'error', signal, headers: { 'User-Agent': 'ai-bdd-studio/0.1 research (source-linked artifact notes)' } }), signal);
    const pages = Object.values(data.query?.pages ?? {}) as any[];
    sources = pages.flatMap(page => {
      const source = researchSourceSchema.safeParse({ title: page.title, url: page.fullurl, excerpt: page.extract });
      return source.success ? [source.data] : [];
    });
  }
  const seen = new Set<string>();
  return sources.filter(source => !seen.has(source.url) && !!seen.add(source.url)).map(source => ({ ...source, sha256: createHash('sha256').update(source.excerpt).digest('hex'), retrievedAt: new Date().toISOString() }));
}
