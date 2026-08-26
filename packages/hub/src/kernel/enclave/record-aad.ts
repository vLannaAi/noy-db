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
 * silent-hide, provenance forgery — and, since #1093, **version rollback**.
 *
 * ## `_v` is bound, and what it took to get there
 *
 * `_v` was deliberately left out at first, for a reason that was real rather
 * than cautious: the sync engine re-stamped `_v` on existing ciphertext without
 * holding a DEK (`advancePastRemote`), so binding it would have made every
 * conflict-superseded record undecryptable. #1042's `MergeAuthority` removed
 * that obstacle by giving the merge a DEK-holding capability, so advancing a
 * version became a **re-seal** instead of a metadata edit — and only then could
 * `_v` join the tuple.
 *
 * ⚠️ **What that buys, stated exactly** — the harness measured this, and the
 * loose version ("rollback is prevented") is wrong.
 *
 * A body can no longer be presented at a version it was not sealed at. So the
 * *restamped* rollback — take v1's bytes, label them v9, win the convergence
 * comparison, overwrite the newer copy — is refused, and refused **before**
 * `local.put`, so nothing is lost.
 *
 * A store re-serving the genuine v1 **at its own `_v: 1`** is still served, and
 * has to be: that envelope is internally consistent, and a reader arriving
 * fresh has nothing to compare it against. AAD binds a body to the version it
 * claims; it cannot know which version *should* have arrived.
 *
 * So rollback stops being forgery and becomes **withholding** — hiding the newer
 * version rather than faking one — which is `withVaultHead()`'s job (#1044).
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

/**
 * Where an envelope was fetched from — the **read** side's half of identity.
 *
 * A reader supplies only the address, because that is genuinely all it knows:
 * `_tier`, `_by` and `_v` are read back off the envelope itself
 * ({@link recordAadFor}). Splitting this out of {@link RecordIdentity} is what
 * lets `version` be *required* on the write side without forcing dozens of read
 * call sites to invent one.
 */
export interface RecordRef {
  readonly collection: string
  readonly id: string
}

/**
 * The identity an envelope's body is sealed against — the **write** side.
 *
 * Every field here is stamped onto the envelope by `buildRecordEnvelope` from
 * this one object, so what a writer *seals* and what it *stamps* cannot drift.
 */
export interface RecordIdentity extends RecordRef {
  /**
   * The `_v` this body is sealed at (#1093).
   *
   * Required, and required is the point: a version that could be omitted would
   * be a version some writer forgets, and a record sealed at a version nobody
   * chose is one a reader cannot open. The compiler asks the question at every
   * write site instead of leaving it to review.
   */
  readonly version: number
  /** Absent is identical to `0` — the read paths treat them as one record. */
  readonly tier?: number | undefined
  /** Absent (no `_by` on the envelope) is distinct from an empty string. */
  readonly by?: string | undefined
}

/** Bumped from `/1` when `_v` joined the tuple (#1093). Nothing branches on it. */
const SCHEME = 'noydb-aad/2'

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
  // ⚠️ Assert on the VALUE, not on the caller's type. `version` is required in
  // TypeScript, so this can only fire for a caller the compiler never saw — a
  // hand-built test fixture, a JS consumer, a `Partial` widened somewhere. It
  // matters because the failure it prevents is invisible: `String(undefined)`
  // is a perfectly good AAD field, so the record seals happily and becomes
  // undecryptable at the next read, with a TamperedError pointing at the READ
  // path where the code is correct. Several fixtures did exactly this (#1093).
  if (!Number.isFinite(identity.version)) {
    throw new TypeError(
      `record AAD: version must be a finite number for "${identity.collection}/${identity.id}", ` +
      `received ${String(identity.version)}. Sealing without one produces a record no reader can open.`,
    )
  }
  // Same argument as `version` above, for the two fields that are STRINGS
  // and therefore coerce instead of arriving as NaN (#1220). `String({})` is
  // `"[object Object]"` and `String(undefined)` is `"undefined"` — both seal
  // perfectly well and both produce a record no reader will ever address.
  // Measured: `collection.put({ id: 'd1', ... })` from JS stores under
  // `"[object Object]"`, and an unset identity reaches the store as
  // `undefined`. Assert on the OUTPUT condition — no seal may be computed
  // over a non-string address — rather than on the two calls that found it.
  for (const [field, value] of [['collection', identity.collection], ['id', identity.id]] as const) {
    if (typeof value !== 'string') {
      throw new TypeError(
        `record AAD: ${field} must be a string, received ${String(value)} ` +
        `(${typeof value}). Sealing against a coerced address produces a record ` +
        `no reader can open, and the failure surfaces on the READ path.`,
      )
    }
  }

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
  // `_v` (#1093). Written as its decimal string through the same length-prefixed
  // field encoding as everything else, so a version cannot be confused with the
  // author beside it.
  pushField(String(identity.version))

  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * The AAD a **reader** must supply to open `envelope`, given where it fetched
 * it from.
 *
 * This is the read-side counterpart of {@link buildRecordAad}, and the split
 * exists because of one asymmetry: **a writer always knows what it is writing;
 * a reader often does not.** Query execution, sync merge and backup restore
 * hold an envelope that arrived from a map or a batch, having discarded the
 * address it came from.
 *
 * What makes the read side tractable is that only `{collection, id}` has to be
 * threaded — precisely what the caller passed to `store.get`. `_tier`, `_by`
 * and `_v` are read back **off the envelope**, so no extra plumbing carries
 * them.
 *
 * That is not a weakening. An attacker who edits `_tier` to hide a record,
 * `_by` to forge provenance, or `_v` to pass an old body off as the current
 * one, changes the AAD the reader computes — and AES-GCM then fails to
 * authenticate. The tampered field defeats itself.
 */
export function recordAadFor(
  ref: RecordRef,
  envelope: {
    readonly _v: number
    readonly _tier?: number | undefined
    readonly _by?: string | undefined
  },
): Uint8Array {
  return buildRecordAad({
    collection: ref.collection,
    id: ref.id,
    version: envelope._v,
    tier: envelope._tier,
    by: envelope._by,
  })
}
