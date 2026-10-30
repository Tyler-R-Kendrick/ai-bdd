/** Owned in-memory SDK protocol transport; it never performs a provider call. */
export function freeSdkFixture(model: string, text = 'via free provider') {
  let requests = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = { date: new Date().toUTCString(), age: '0' };
    if (url.pathname === '/v1/models')
      return Response.json({ data: model ? [{ id: model, type: 'language', pricing: { input: '0', output: '0' } }] : [] }, { headers });
    if (url.pathname.endsWith('/endpoints'))
      return Response.json({ data: { id: model, endpoints: [{ provider_name: 'owned-fixture', status: 0, pricing: { prompt: '0', completion: '0', request: '0', image: '0', image_output: '0', web_search: '0', internal_reasoning: '0', discount: 0 } }] } }, { headers });
    requests++;
    if (url.pathname !== '/v4/ai/language-model') throw new Error('Unexpected owned SDK protocol path');
    const body = JSON.parse(String(init?.body));
    if (JSON.stringify(body.providerOptions.gateway) !== JSON.stringify({ only: ['owned-fixture'], models: [], byok: {} })) throw new Error('Free routing guard was bypassed');
    return Response.json({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] });
  };
  return { fetcher, count: () => requests };
}
