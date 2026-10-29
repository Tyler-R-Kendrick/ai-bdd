export type ExecutedScenario = {
  scenarioId: string;
  title: string;
  status: string;
};
type EvidenceRun = {
  artifactVersion: number;
  result?: { scenarios?: ExecutedScenario[] } | null;
};

/** A criterion is verified by its linked scenario, never by an aggregate run. */
export function inlineTestStatus(
  run: EvidenceRun | undefined,
  version: number,
  scenarioId: unknown,
) {
  const scenarios = run?.result?.scenarios ?? [];
  const linked = typeof scenarioId === 'string' && scenarioId.length > 0;
  const scenario = linked
    ? scenarios.find((result) => result.scenarioId === scenarioId)
    : undefined;
  const stale = !!scenario && run?.artifactVersion !== version;
  const status = !linked
    ? 'Not linked'
    : !scenario
      ? 'Not run'
      : stale
        ? 'Evidence out of date'
        : scenario.status;
  return {
    scenarios,
    scenario,
    linked,
    stale,
    status,
    passed: !!scenario && !stale && scenario.status === 'passed',
  };
}
