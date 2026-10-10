import { it } from 'vitest';
import { flowBugAfterRecording } from '../../../../tests/acceptance/helpers/flows.ts';
import { fakeTarget } from '../../../../tests/acceptance/helpers/targets.ts';
import { createProject } from '../../../../tests/acceptance/helpers/project.ts';
import { openEngine } from '../../../../tests/acceptance/helpers/engine.ts';
import { recordingOf } from '../../../../tests/acceptance/helpers/flows.ts';

it('debug', async () => {
  void flowBugAfterRecording; void fakeTarget; void createProject; void openEngine; void recordingOf;
}, 60000);
