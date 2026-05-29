/**
 * @noy-db/attestation — pure document-attestation primitive.
 * @packageDocumentation
 */
export type { Normalizer, AttestationFieldSpec, AttestationFieldSchema } from './types.js'
export type { QrPayload } from './qr.js'
export type { RevocationList } from './revocation.js'
export type { VerifyInput, VerifyResult } from './verify.js'

export { canonicalJson, sha256Hex, sha256Bytes, bytesToHex, bytesToB64url, b64urlToBytes, utf8 } from './encoding.js'
export { normalizeField, validateFieldSchema, getPath } from './normalize.js'
export { computeFieldHashes } from './hashing.js'
export { generateDocSigningKeyPair, ed25519Sign, ed25519Verify, keyIdFor } from './ed25519.js'
export { encodeQr, decodeQr } from './qr.js'
export { signPayloadCore, verifyAttestation } from './verify.js'
export { isRevoked, verifyRevocationList, signRevocationList } from './revocation.js'
