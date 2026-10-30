import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
/** Anonymous first-party executable download. User uploads are never served from this path. */
export function registerConnectorDownload(
  app: FastifyInstance,
  options: { file: string },
) {
  const file = resolve(options.file);
  app.get('/connector.js', async (_request, reply) => {
    const info = await stat(file);
    if (!info.isFile() || info.size > 12 * 1024 * 1024)
      throw new Error('The deployed connector bundle is unavailable');
    const source = await readFile(file);
    return reply
      .header('Content-Type', 'text/javascript; charset=utf-8')
      .header(
        'Content-Disposition',
        'attachment; filename="studio-connector.mjs"',
      )
      .header('Cache-Control', 'public, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .send(source);
  });
}
