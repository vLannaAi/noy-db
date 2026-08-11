/**
 * Record-identity AAD (#1041).
 *
 * AES-GCM authenticates its *additional authenticated data* alongside the
 * ciphertext without encrypting it. Binding a record's identity here is what
 * stops an untrusted store from silently **relocating** an envelope — moving
 * it to another collection or id, re-tiering it, or rewriting who
 * wrote it — while keeping a body whose auth tag still verifies.
 *
 * Scope, stated plainly: this closes cross-COLLECTION relocation, the `_tier`
 * silent-hide and provenance forgery. It does **not** close version rollback — `_v` is
 * deliberately *not* bound, because the sync engine re-stamps `_v` on existing
 * ciphertext without holding a DEK (`with-sync/engine.ts:935-937`), and
 * because the merge never decrypts, so a bad AAD would surface only after the
 * newer copy had already been overwritten. Rollback needs #1042 + #1044.
 *
 * ## Why `vault` is not bound
 *
 * It was, briefly, and it broke `adoptPartition`. That path re-homes a whole
 * partition into a new vault name by moving envelopes **verbatim** —
 * `with-cargo/adopt-partition.ts:140` is a bare
 * `destinationStore.saveAll(vaultName, backup.collections)` with no
 * re-encryption, because it does not hold the keys to re-encrypt at that
 * point. Binding the vault name makes every adopted record undecryptable.
 *
 * The uncomfortable truth behind that: **relocation is not purely an attack.**
 * Adoption is a legitimate, supported relocation, and AAD cannot tell the two
 * apart. So the vault boundary has to be defended by something that can
 * distinguish intent — an authenticated head or an explicit re-key — rather
 * than by sealing a name the product deliberately changes.
 *
 * Cross-*collection* relocation has no such legitimate counterpart, so it stays
 * bound.
 *
 * @packageDocumentation
 */

/** The identity an envelope's body is sealed against. */
export interface RecordIdentity {
  readonly collection: string
  readonly id: string
  /** Absent is identical to `0` — the read paths treat them as one record. */
  readonly tier?: number | undefined
  /** Absent (no `_by` on the envelope) is distinct from an empty string. */
  readonly by?: string | undefined
}

const SCHEME = 'noydb-aad/1'

const encoder = new TextEncoder()

/**
 * Length-prefixed, order-fixed encoding.
 *
 * The obvious `${collection}:${id}` is unsafe: an attacker who
 * controls a collection name can choose one that re-splits the same joined
 * string a different way, so two different identities produce identical AAD
 * and the relocation this exists to prevent goes through. Every field is
 * therefore written as a 4-byte big-endian length followed by its UTF-8 bytes,
 * which no field content can imitate.
 *
 * A one-byte presence flag precedes `by` so that "no author recorded" and
 * "author recorded as the empty string" cannot be swapped for one another.
 */
export function buildRecordAad(identity: RecordIdentity): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(SCHEME)]

  const pushField = (value: string): void => {
    const bytes = encoder.encode(value)
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, bytes.length, false)
    parts.push(len, bytes)
  }

  pushField(identity.collection)
  pushField(identity.id)
  // Absent tier ≡ tier 0: `collection.ts` reads `(envelope._tier ?? 0) > 0`,
  // so treating them differently here would make a record written without a
  // tier undecryptable once read through a tier-aware path.
  pushField(String(identity.tier ?? 0))

  parts.push(new Uint8Array([identity.by === undefined ? 0 : 1]))
  if (identity.by !== undefined) pushField(identity.by)

  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}
