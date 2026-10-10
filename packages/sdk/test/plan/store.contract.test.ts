import { createPlanStore } from '../../src/plan/index.ts';
import { runPlanStoreContract } from '../kit/store-contract.ts';

// The filesystem plan store, on a fresh temp directory per case.
runPlanStoreContract('createPlanStore (filesystem)', (dir, { readOnly }) => createPlanStore({ dir, readOnly }));
