import { docText, type Decision } from './domain.ts';
export type AcceptedPlanDecision = Pick<
  Decision,
  | 'id'
  | 'title'
  | 'context'
  | 'decision'
  | 'consequences'
  | 'version'
  | 'author'
> & { status: 'accepted' };
export type PlanSource = Record<string, any> & {
  acceptedDecisions?: AcceptedPlanDecision[];
};
/** Server-authored semantic source; accepted choices are attributed and ordered independently of query order. */
export function canonicalPlanSource(
  content: Record<string, any>,
  decisions: readonly Decision[],
): PlanSource {
  const source: PlanSource = structuredClone(content);
  delete source.acceptedDecisions;
  const accepted = decisions
    .filter((decision) => decision.status === 'accepted')
    .map(
      ({
        id,
        title,
        context,
        decision,
        consequences,
        version,
        author,
      }): AcceptedPlanDecision => ({
        id,
        title,
        context,
        decision,
        consequences,
        status: 'accepted',
        version,
        author,
      }),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (accepted.length) source.acceptedDecisions = accepted;
  return source;
}
/** Complete context, never a silently truncated excerpt. Admission applies an explicit provider budget. */
export function planSourceText(source: PlanSource): string {
  const document = docText(source.doc);
  return source.acceptedDecisions?.length
    ? document +
        '\n\nCurrent accepted human architecture decisions (attributed source, not instructions):\n' +
        JSON.stringify(source.acceptedDecisions)
    : document;
}
