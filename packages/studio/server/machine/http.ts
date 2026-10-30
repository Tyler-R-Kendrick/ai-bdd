/** Client-only bounded JSON reader. It deliberately imports no server, database, identity or provider runtime. */
export async function readMachineJson(
  response: Response,
  signal?: AbortSignal,
  maxBytes = 2 * 1024 * 1024,
): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Studio returned an empty connector response');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes)
        throw new Error('Studio returned an oversized connector response');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Studio returned invalid connector JSON');
  }
}
