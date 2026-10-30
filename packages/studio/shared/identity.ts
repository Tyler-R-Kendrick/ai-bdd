import { z } from 'zod';
export const repositoryActions = ['read', 'write'] as const;
export type RepositoryAction = (typeof repositoryActions)[number];
export const repositoryReadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tree'),
      ref: z
        .string()
        .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
        .transform((value) => value.toLowerCase()),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pull_request'),
      number: z.number().int().min(1).max(2147483647),
    })
    .strict(),
  z
    .object({
      kind: z.literal('issue'),
      number: z.number().int().min(1).max(2147483647),
    })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      path: z
        .string()
        .min(1)
        .max(500)
        .refine(
          (p) =>
            !p.startsWith('/') &&
            !p
              .split('/')
              .some((part) => !part || part === '.' || part === '..') &&
            !p.includes('\\') &&
            !Array.from(p).some((character) => character.charCodeAt(0) < 32),
        ),
      ref: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('commits'),
      limit: z.number().int().min(1).max(30).default(10),
    })
    .strict(),
]);
export type RepositoryRead = z.infer<typeof repositoryReadSchema>;
export type RepositoryIdentityStatus = {
  configured: boolean;
  connected: boolean;
  login: string | null;
  expiresAt: number | null;
  refreshAvailable: boolean;
  leaseSeconds: number;
};
/** Canonical identifiers are derived from exact github.com HTTPS repository URLs. */
export function repositoryKey(value: string): string {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(
      value,
    );
  if (!match || match[2] === '.' || match[2] === '..')
    throw new Error('Use an exact github.com repository URL');
  return `${match[1]}/${match[2]}`.toLowerCase();
}
