import type { FakeRespond, FakeRule } from '@ai-bdd/testing';
import { createFakeModels } from '@ai-bdd/testing';
import type { ModelPurpose } from '@ai-bdd/sdk/contracts';
import { runModelContract, type ModelScript } from '../../../sdk/test/kit/model-contract.ts';

const PURPOSES: readonly ModelPurpose[] = ['extract', 'act', 'checkgen', 'judge'];

function respondFor(script: ModelScript): FakeRespond | undefined {
  switch (script.kind) {
    case 'text':
      return { text: script.text };
    case 'structured':
      return { object: script.object };
    case 'tool-call':
      return { script: [{ tool: script.toolName, args: script.args }] };
    case 'hang':
    case 'failure':
      return undefined;
  }
}

// The rule-driven fake models answer from a rule table keyed on `request.context`. The kit scripts one rule per purpose
// for the case it is about to run, so the fake answers exactly like a provider that was told what to say.
// Not scriptable on a fake, and therefore not claimed: hanging until aborted (it never waits), provider failures
// (the only failure it has is "no rule matches"), and rejecting tool calls for tools the request did not offer
// (rules say which tool to call; the fake does not look at the offered tools).
runModelContract(
  'createFakeModels (rule-driven fake)',
  (script, caseId) => {
    const respond = respondFor(script);
    const rules: FakeRule[] =
      respond === undefined ? [] : PURPOSES.map((purpose) => ({ id: `${caseId}-${purpose}`, purpose, when: { contractCase: caseId }, respond }));
    return createFakeModels({ rules: [{ rules }] });
  },
  {
    failures: ['unscripted'],
    deterministic: true,
    abortInFlight: false,
    validatesToolNames: false,
  },
);
