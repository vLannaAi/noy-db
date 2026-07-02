/**
 * Per-principal user envelope service — storage + types.
 *
 * @see docs/superpowers/specs/2026-05-05-user-envelope-design.md
 *
 * @module
 */
export {
  USER_ENVELOPE_COLLECTION,
  USER_ENVELOPE_MAX_BYTES,
  UserEnvelopeOversizedError,
  type UserEnvelope,
} from './types.js'

export {
  loadUserEnvelope,
  saveUserEnvelope,
  deleteUserEnvelope,
  listUserEnvelopeIds,
} from './storage.js'
