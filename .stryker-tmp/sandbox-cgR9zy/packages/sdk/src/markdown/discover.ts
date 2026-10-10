// @ts-nocheck
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { glob } from 'tinyglobby';
import { AiBddError, type DiscoverDocs, type ResolvedConfig, type SourceDoc } from '../contracts/index.ts';
import { toPosix } from '../util/index.ts';
import { docSha256 } from './normalize.ts';

const READ_BATCH = 64;

function outside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel);
}

/** Spec 6.5: glob `config.docs` minus `config.exclude`, sorted by uri, confined to the project root. */
export const discoverDocs: DiscoverDocs = async (config: ResolvedConfig): Promise<SourceDoc[]> => {
  const root = resolve(config.projectRoot);
  if (config.docs.length === 0) return [];
  let matches: string[];
  try {
    matches = await glob(config.docs, {
      cwd: root,
      ignore: config.exclude,
      absolute: true,
      dot: true,
      onlyFiles: true,
      expandDirectories: false,
    });
  } catch (err) {
    throw new AiBddError('DOC_READ_FAILED', `could not search for documents: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (err) {
    throw new AiBddError('DOC_READ_FAILED', `project root is not readable: ${root}`, { cause: err });
  }

  const entries: { uri: string; abs: string }[] = [];
  for (const raw of matches) {
    const abs = resolve(raw);
    const rel = relative(root, abs);
    if (rel === '' || outside(rel)) {
      throw new AiBddError('POLICY_DENIED', `document is outside the project root: ${toPosix(rel === '' ? abs : rel)}`, { details: { path: toPosix(abs) } });
    }
    entries.push({ uri: toPosix(rel).normalize('NFC'), abs });
  }
  entries.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));

  const docs: SourceDoc[] = [];
  for (let i = 0; i < entries.length; i += READ_BATCH) {
    const batch = entries.slice(i, i + READ_BATCH);
    const read = await Promise.all(
      batch.map(async ({ uri, abs }): Promise<SourceDoc> => {
        let real: string;
        try {
          real = await realpath(abs);
        } catch (err) {
          throw new AiBddError('DOC_READ_FAILED', `cannot read ${uri}: ${err instanceof Error ? err.message : String(err)}`, { details: { uri }, cause: err });
        }
        if (outside(relative(realRoot, real))) {
          throw new AiBddError('POLICY_DENIED', `document resolves outside the project root: ${uri}`, { details: { uri } });
        }
        let text: string;
        try {
          text = await readFile(abs, 'utf8');
        } catch (err) {
          throw new AiBddError('DOC_READ_FAILED', `cannot read ${uri}: ${err instanceof Error ? err.message : String(err)}`, { details: { uri }, cause: err });
        }
        return { uri, absolutePath: abs, text, sha256: docSha256(text) };
      }),
    );
    docs.push(...read);
  }
  return docs;
};
