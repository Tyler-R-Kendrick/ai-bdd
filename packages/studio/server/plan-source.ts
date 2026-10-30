import type { Store } from './store.ts';
import type { Artifact } from '../shared/domain.ts';
import { canonicalPlanSource, type PlanSource } from '../shared/plan-source.ts';
/** SQL-only. A caller capturing/fencing source must hold the artifact's project transaction lock. */
export async function readPlanSource(
  store: Store,
  artifact: Pick<Artifact, 'id' | 'content'>,
): Promise<PlanSource> {
  return canonicalPlanSource(
    artifact.content,
    await store.decisions(artifact.id),
  );
}
