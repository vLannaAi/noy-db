/**
 * @category capability
 * Document attestation — issue side. Mint a signed, per-field commitment
 * for a record and emit a QR credential verifiable offline via
 * `@noy-db/attestation`. See docs/superpowers/specs/2026-05-29-attestation-core-and-issue-design.md.
 */
export { issueAttestationCore } from './issue.js'
export type { IssueContext, IssueArgs, IssueResult } from './issue.js'
export { ATTESTATIONS_COLLECTION } from './signer.js'
export { AttestationError } from '../errors.js'
// Re-export the pure verifier surface so consumers can verify from one import:
export { verifyAttestation, decodeQr, verifyRevocationList, isRevoked, type QrPayload, type AttestationFieldSchema, type VerifyResult, type VerifyInput } from '@noy-db/attestation'
