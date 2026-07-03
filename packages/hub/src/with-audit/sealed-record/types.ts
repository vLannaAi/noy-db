/**
 * Wire + binding types for record-scoped CEK sealing.
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

// Hoisted to kernel/types.ts (C3 — enclave self-containment: sealing.ts
// consumes these as spine-owned contract types). Re-exported here so
// existing importers of this module are unaffected.
export type { SealedCekDeliveryEnvelope, SealedCekBinding } from '../../kernel/types.js'
