import { HttpError } from '../store.ts';
export async function boundedJson(response: Response, signal?: AbortSignal, maximum = 1024 * 1024): Promise<any> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(502, 'The configured integration could not complete this request');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(502, 'The integration returned an empty response');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) throw new HttpError(502, 'The integration response exceeded its size limit');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(502, 'The integration returned invalid JSON'); }
}
