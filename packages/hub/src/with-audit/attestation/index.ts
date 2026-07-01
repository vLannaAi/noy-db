/**
 * @category capability
 * Document attestation — issue side. Mint a signed, per-field commitment
 * for a record and emit a QR credential verifiable offline via
 * `@noy-db/attestation`. See docs/superpowers/specs/2026-05-29-attestation-core-and-issue-design.md.
 */
export { withAttestation } from './active.js'
export { NO_ATTESTATION, type AttestationStrategy } from './strategy.js'
export { AttestationNotEnabledError } from '../../kernel/errors.js'
export { issueAttestationCore } from './issue.js'
export type { IssueContext, IssueArgs, IssueResult } from './issue.js'
export { ATTESTATIONS_COLLECTION } from './signer.js'
export { revokeDocCore, unrevokeDocCore, getRevokedDocIdsCore, publishRevocationListCore } from './revoke.js'
export type { RevokeContext } from './revoke.js'
export { AttestationError } from '../../kernel/errors.js'
// Re-export the pure verifier surface so consumers can verify from one import:
export { verifyAttestation, decodeQr, verifyRevocationList, isRevoked, signRevocationList, type QrPayload, type AttestationFieldSchema, type VerifyResult, type VerifyInput, type RevocationList } from '@noy-db/attestation'
