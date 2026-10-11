import { createRecordingStore } from '../../src/recording/index.ts';
import { runRecordingStoreContract } from '../kit/store-contract.ts';

// The filesystem recording store, on a fresh temp directory per case.
runRecordingStoreContract('createRecordingStore (filesystem)', (dir, { mode }) => createRecordingStore({ dir, mode }));
