import type { GatewayFetch } from '@ai-bdd/models-ai-sdk';
/** Public price metadata for owned protocol servers only. Shipping env has no such switch. */
export function ownedFreeGatewayMetadata(models = [
  'fixture/model', 'fixture/graph', 'fixture/author', 'fixture/title-goal',
  'fixture/second', 'fixture/other', 'fixture/after-admission', 'fixture/decision', 'fixture/decision-two',
]): GatewayFetch {
  return async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== 'https://ai-gateway.vercel.sh') throw new Error('Unexpected owned price fixture target');
    const headers = { date: new Date().toUTCString(), age: '0' };
    if (url.pathname === '/v1/models')
      return Response.json({ data: models.map(id => ({ id, type: 'language', pricing: { input: '0', output: '0' } })) }, { headers });
    const id = url.pathname.replace(/^\/v1\/models\//, '').replace(/\/endpoints$/, '');
    if (!url.pathname.endsWith('/endpoints') || !models.includes(id)) throw new Error('Unexpected owned fixture model');
    return Response.json({ data: { id, endpoints: [{ provider_name: 'owned-fixture', status: 0, pricing: { prompt: '0', completion: '0', request: '0', image: '0', image_output: '0', web_search: '0', internal_reasoning: '0', discount: 0 } }] } }, { headers });
  };
}
