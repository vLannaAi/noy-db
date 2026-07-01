/**
 * Type surface for the per-principal user envelope subsystem.
 *
 * @see docs/superpowers/specs/2026-05-05-user-envelope-design.md
 *
 * @module
 */
import { NoydbError } from '../../errors.js'

/**
 * Thin reader view of a user envelope. The on-disk shape is the standard
 * {@link import('../../kernel/types.js').EncryptedEnvelope}; this is what callers
 * see after the storage layer has decrypted the payload.
 *
 * Hub commits to the `keyringId` ⇔ `userId` identity and the `_v` / `_ts`
 * envelope metadata. The `data` payload is fully app-defined — hub does
 * not introspect, validate, or reserve any keys inside it.
 */
export interface UserEnvelope<T> {
  /** The principal id this envelope belongs to. Equals the keyring `user_id`. */
  readonly keyringId: string
  /** App-owned payload. Opaque to hub. */
  readonly data: T
  /** Optimistic-concurrency version. Increments on every write. */
  readonly _v: number
  /** ISO timestamp of the last write. */
  readonly _ts: string
}

/**
 * Soft cap on the JSON-serialized payload size. Generous (a typical
 * profile + preferences + small app annex is ~1 KiB); rejects accidental
 * "stuff app state in here" anti-patterns.
 */
export const USER_ENVELOPE_MAX_BYTES = 64 * 1024

/**
 * Reserved store collection name for user envelopes. Starts with `_` so the
 * keyring grant machinery propagates the DEK to every granted user via the
 * existing system-collection DEK propagation path in `team/keyring.ts`.
 */
export const USER_ENVELOPE_COLLECTION = '_users'

/**
 * Thrown when a user-envelope payload exceeds {@link USER_ENVELOPE_MAX_BYTES}
 * after JSON-serialization. The error carries the actual size so callers
 * can decide whether to trim or split.
 */
export class UserEnvelopeOversizedError extends NoydbError {
  readonly bytes: number
  readonly limit: number
  constructor(bytes: number, limit: number = USER_ENVELOPE_MAX_BYTES) {
    super(
      'USER_ENVELOPE_OVERSIZED',
      `User envelope payload is ${bytes} bytes; soft cap is ${limit} bytes. ` +
        `Move large data into the vault's regular collections.`,
    )
    this.name = 'UserEnvelopeOversizedError'
    this.bytes = bytes
    this.limit = limit
  }
}
