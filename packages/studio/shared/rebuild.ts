import { z } from 'zod';
export const rebuildSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const rebuildLeaseSchema = z
  .object({
    leaseToken: rebuildSecret,
    generation: z.number().int().positive(),
  })
  .strict();
export const rebuildReportSchema = z
  .object({
    idempotencyKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string().trim().min(1).max(5000),
    pullRequests: z
      .array(
        z
          .object({
            url: z.string().url().max(500),
            branch: z.string().min(1).max(200),
            commit: z.string().regex(/^[a-f0-9]{40}$/),
            evidence: z.string().trim().min(1).max(5000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    criteria: z
      .array(
        z
          .object({
            taskId: z.string().min(1).max(100),
            index: z.number().int().min(0).max(29),
            passed: z.boolean(),
            evidence: z.string().trim().min(1).max(5000),
          })
          .strict(),
      )
      .min(1)
      .max(3000),
  })
  .strict();
export type RebuildReport = z.infer<typeof rebuildReportSchema>;
export type RebuildPullRequest = {
  url: string;
  branch: string;
  commit: string;
};
/** Compare stable top-level node identities, counting each added/removed/changed block once. */
export function changedDocumentBlocks(
  before: Record<string, any>,
  after: Record<string, any>,
) {
  const blocks = (content: Record<string, any>) =>
    (content.doc?.content ?? []) as any[];
  const map = (content: Record<string, any>) =>
    new Map(
      blocks(content).map((node, index) => [
        typeof node.attrs?.id === 'string' ? node.attrs.id : '#' + index,
        JSON.stringify([index,node]),
      ]),
    );
  const a = map(before),
    b = map(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter(
    (key) => a.get(key) !== b.get(key),
  ).length;
}

export const rebuildRuntimeSchema = z
  .object({
    adapter: z.literal('acp'),
    executableName: z.string().min(1).max(120),
    executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
    argumentsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    argumentFileSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    model: z.null(),
    provenance: z.literal('connector-reported'),
  })
  .strict();
