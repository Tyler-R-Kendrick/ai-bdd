/**
 * @ai-bdd/evidence — the evidence store, settle detection and redaction.
 *
 * - `EvidenceStore` writes content-addressed artifacts and a hash-chained manifest
 * - `verifyEvidence` recomputes everything and reports tampering
 * - `settle` implements the driver-agnostic settle algorithm (section 8.6)
 * - `createRedactor` removes secrets in raw, URL-encoded and base64 form
 */
export {
  EvidenceStore,
  createSigner,
  generateSigningKey,
  readRecord,
  verifyEvidence,
  writeAtomic,
  type EvidenceStoreOptions,
  type EvidenceWriteInput,
  type Signer,
} from './store.js';
export { createRedactor, redactValue, resolveSecrets, secretVariants, type SecretDeclaration } from './redact.js';
export { diffRatio, settle, type Sleep } from './settle.js';
