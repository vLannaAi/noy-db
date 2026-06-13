/**
 * Wire + binding types for record-scoped CEK sealing (#306 slices 2-3).
 *
 * A vault owner who holds the collection DEK can **seal a single record's
 * content-encryption key (CEK)** to an `at-*` host (e.g. a KMS-backed
 * {@link RecipientSealer}) so that host — and only that host — can decrypt
 * exactly that one record, with no access to the vault DEK and no ability to
 * read any other record. This is the record-granular counterpart to the
 * bundle-granular sealed-credential delivery (`SealedEnvelope`).
 *
 * Two shapes live here:
 *
 *  - {@link SealedCekDeliveryEnvelope} — the **thin delivery envelope** the
 *    grantor writes to `_sealed_cek/<collection>/<id>/<pid>`. It carries only
 *    routing metadata (`pid`, `expiresAt`) in the clear plus the opaque sealed
 *    `payload`. The `expiresAt` here is a *fast-path* hint; the authoritative
 *    expiry lives INSIDE the sealed payload (see below).
 *
 *  - {@link SealedCekBinding} — the plaintext struct that is sealed for the
 *    host. It binds the CEK to its `{collection, id}` and an authoritative
 *    `expiresAt`, so a host cannot take a CEK sealed for record A and apply it
 *    to record B's envelope (mismatch is rejected), nor read past expiry. The
 *    binding is the security boundary; the delivery envelope is just transport.
 *
 * @module
 */

/**
 * Thin delivery envelope persisted at
 * `_sealed_cek/<collection>/<id>/<pid>`. The grantor writes one per
 * (record, recipient host) pair. `payload` is the base64 of the bytes returned
 * by {@link RecipientSealer.sealForRecipient} over a UTF-8
 * `JSON.stringify({@link SealedCekBinding})`.
 *
 * `expiresAt` is duplicated here for a cheap pre-unseal reject, but is NOT
 * authoritative — the binding inside `payload` carries the expiry the host
 * verifies after unsealing, so a tampered delivery envelope cannot extend a
 * grant.
 */
export interface SealedCekDeliveryEnvelope {
  /** Envelope schema version. */
  readonly v: 1
  /** Magic marker for forensics + format detection. */
  readonly _noydb_sealed_cek: 1
  /** Recipient host provider id; matches the sealer's `.id` / hint `pid`. */
  readonly pid: string
  /** base64 of the sealed {@link SealedCekBinding} bytes. */
  readonly payload: string
  /** Fast-path expiry hint (ISO 8601). Authoritative copy is inside `payload`. */
  readonly expiresAt: string
}

/**
 * The plaintext struct sealed for the recipient host. After the host unseals
 * `SealedCekDeliveryEnvelope.payload` it parses this and MUST verify:
 *  - `collection` + `id` match the record envelope it is decrypting, and
 *  - `expiresAt` has not passed (authoritative expiry check).
 *
 * `cek` is the base64 of the raw 32-byte AES-256-GCM record CEK.
 */
export interface SealedCekBinding {
  /** Collection the CEK belongs to. */
  readonly collection: string
  /** Record id the CEK belongs to. */
  readonly id: string
  /** base64 of the raw AES-256-GCM CEK bytes. */
  readonly cek: string
  /** Authoritative expiry (ISO 8601). */
  readonly expiresAt: string
}
