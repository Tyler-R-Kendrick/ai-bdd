import { z } from 'zod';
import type { ArtifactKind } from './domain.ts';
export type LifecycleBlocker = {
  kind:
    | 'main-design'
    | 'active-work'
    | 'published-evidence'
    | 'published-child'
    | 'source-reference'
    | 'asset-reference'
    | 'pending-upload'
    | 'retained-records';
  message: string;
  id?: string;
  artifactId?: string;
  count?: number;
  retryAt?: number;
};
export type ArchivedArtifact = {
  id: string;
  projectId: string;
  title: string;
  kind: ArtifactKind;
  version: number;
  archived: boolean;
  updatedAt: string;
  archiveRevision: number;
  archivedAt: string | null;
};
export type LifecycleInspection = {
  artifact: ArchivedArtifact;
  canManage: boolean;
  blockers: LifecycleBlocker[];
  restoreBlockers: LifecycleBlocker[];
  counts: {
    messages: number;
    threads: number;
    decisions: number;
    revisions: number;
    files: number;
  };
};
export const restoreArtifactSchema = z
  .object({
    version: z.number().int().positive(),
    archiveRevision: z.number().int().nonnegative(),
  })
  .strict();
export const purgeArtifactSchema = restoreArtifactSchema
  .extend({ confirmTitle: z.string().min(1).max(250) })
  .strict();
