import { createEvidenceStore, verifyRun } from '../../src/evidence/index.ts';
import { runEvidenceStoreContract } from '../kit/store-contract.ts';

// The filesystem evidence store plus its verifier, on a fresh temp directory per case.
runEvidenceStoreContract('createEvidenceStore (filesystem)', (runsDir, runId, redactor) => createEvidenceStore({ runsDir, runId, redactor }), { verify: verifyRun });
