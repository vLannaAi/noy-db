/**
 * Per-principal user envelope service — storage primitives. The contract
 * types (`UserEnvelope`, `VaultUserApi`, `UserApiDeps`, ...) and the
 * `USER_ENVELOPE_COLLECTION` / `USER_ENVELOPE_MAX_BYTES` constants and
 * `UserEnvelopeOversizedError` live in the kernel spine
 * (`kernel/types.ts` / `kernel/constants.ts` / `kernel/errors.ts`).
 *
 * @see design-history/2026-05-05-user-envelope-design.md
 *
 * @module
 */
export {
  loadUserEnvelope,
  saveUserEnvelope,
  deleteUserEnvelope,
  listUserEnvelopeIds,
} from './storage.js'
