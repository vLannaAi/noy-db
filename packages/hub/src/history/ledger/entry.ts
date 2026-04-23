/**
 * Ledger entry shape + canonical JSON + sha256 helpers.
 *
 * This file holds the PURE primitives used by the hash-chained ledger:
 * the entry type, the deterministic (sort-stable) JSON encoder, and
 * the sha256 hasher that produces `prevHash` and `ledger.head()`.
 *
 * Everything here is validator-free and side-effect free — the only
 * runtime dep is Web Crypto's `subtle.digest` for the sha256 call,
 * which we already use for every other hashing operation in the core.
 *
 * The hash chain property works like this:
 *
 *   hash(entry[i])       = sha256(canonicalJSON(entry[i]))
 *   entry[i+1].prevHash  = hash(entry[i])
 *
 * Any modification to `entry[i]` (field values, field order, whitespace)
 * produces a different `hash(entry[i])`, which means `entry[i+1]`'s
 * stored `prevHash` no longer matches the recomputed hash, which means
 * `verify()` returns `{ ok: false, divergedAt: i + 1 }`. The chain is
 * append-only and tamper-evident without external anchoring.
 */

/**
 * A single ledger entry in its plaintext form — what gets serialized,
 * hashed, and then encrypted with the ledger DEK before being written
 * to the `_ledger/` adapter collection.
 *
 * ## Why hash the ciphertext, not the plaintext?
 *
 * `payloadHash` is the sha256 of the record's ENCRYPTED envelope bytes,
 * not its plaintext. This matters:
 *
 *   1. **Zero-knowledge preserved.** A user (or a third party) can
 *      verify the ledger against the stored envelopes without any
 *      decryption keys. The adapter layer already holds only
 *      ciphertext, so hashing the ciphertext keeps the ledger at the
 *      same privacy level as the adapter.
 *
 *   2. **Determinism.** Plaintext → ciphertext is randomized by the
 *      fresh per-write IV, so `hash(plaintext)` would need extra
 *      normalization. `hash(ciphertext)` is already deterministic and
 *      unique per write.
 *
 *   3. **Detection property.** If an attacker modifies even one byte of
 *      the stored ciphertext (trying to flip a record), the hash
 *      changes, the ledger's recorded `payloadHash` no longer matches,
 *      and a data-integrity check fails. We don't do that check in
 *      `verify()` today (v0.4 only checks chain consistency), but the
 *      hook is there for a future `verifyIntegrity()` follow-up.
 *
 * Fields marked `op`, `collection`, `id`, `version`, `ts`, `actor` are
 * plaintext METADATA about the operation — NOT the record itself. The
 * entry is still encrypted at rest via the ledger DEK, but adapters
 * could theoretically infer operation patterns from the sizes and
 * timestamps. This is an accepted trade-off for the tamper-evidence
 * property; full ORAM-level privacy is out of scope for noy-db.
 */
export interface LedgerEntry {
  /**
   * Zero-based sequential position of this entry in the chain. The
   * canonical adapter key is this number zero-padded to 10 digits
   * (`"0000000001"`) so lexicographic ordering matches numeric order.
   */
  readonly index: number

  /**
   * Hex-encoded sha256 of the canonical JSON of the PREVIOUS entry.
   * The genesis entry (index 0) has `prevHash === ''` — the first
   * entry in a fresh vault has nothing to point back to.
   */
  readonly prevHash: string

  /**
   * Which kind of mutation this entry records. v0.4 only supports
   * data operations (`put`, `delete`). Access-control operations
   * (`grant`, `revoke`, `rotate`) will be added in a follow-up once
   * the keyring write path is instrumented — that's tracked in the
   * v0.4 epic issue.
   */
  readonly op: 'put' | 'delete'

  /** The collection the mutation targeted. */
  readonly collection: string

  /** The record id the mutation targeted. */
  readonly id: string

  /**
   * The record version AFTER this mutation. For `put` this is the
   * newly assigned version; for `delete` this is the version that
   * was deleted (the last version visible to reads).
   */
  readonly version: number

  /** ISO timestamp of the mutation. */
  readonly ts: string

  /** User id of the actor who performed the mutation. */
  readonly actor: string

  /**
   * Hex-encoded sha256 of the encrypted envelope's `_data` field.
   * For `put`, this is the hash of the new ciphertext. For `delete`,
   * it's the hash of the last visible ciphertext at deletion time,
   * or the empty string if nothing was there to delete. Hashing the
   * ciphertext (not the plaintext) preserves zero-knowledge — see
   * the file docstring.
   */
  readonly payloadHash: string

  /**
   * Optional hex-encoded sha256 of the encrypted JSON Patch delta
   * blob stored alongside this entry in `_ledger_deltas/`. Present
   * only for `put` operations that had a previous version — the
   * genesis put of a new record, and every `delete`, leave this
   * field undefined.
   *
   * The delta payload itself lives in a sibling internal collection
   * (`_ledger_deltas/<paddedIndex>`) and is encrypted with the
   * ledger DEK. Callers use `ledger.loadDelta(index)` to decrypt and
   * deserialize it when reconstructing a historical version.
   *
   * Why optional instead of always-present: the first put of a
   * record has no previous version to diff against, so storing an
   * empty patch would be noise. For deletes there's no "next" state
   * to describe with a delta. Both cases set this field to undefined.
   *
   * Note: the canonical-JSON hasher treats `undefined` as invalid
   * (it's one of the guard rails), so on the wire this field is
   * either `{ deltaHash: '<hex>' }` or absent from the JSON
   * entirely — never `{ deltaHash: undefined }`.
   */
  readonly deltaHash?: string
}

/**
 * Canonical (sort-stable) JSON encoder.
 *
 * This function is the load-bearing primitive of the hash chain:
 * `sha256(canonicalJSON(entry))` must produce the same hex string
 * every time, on every machine, for the same logical entry — otherwise
 * `verify()` would return `{ ok: false }` on cross-platform reads.
 *
 * JavaScript's `JSON.stringify` is almost canonical, but NOT quite:
 * it preserves the insertion order of object keys, which means
 * `{a:1,b:2}` and `{b:2,a:1}` serialize differently. We fix this by
 * recursively walking objects and sorting their keys before
 * concatenation.
 *
 * Arrays keep their original order (reordering them would change
 * semantics). Numbers, strings, booleans, and `null` use the default
 * JSON encoding. `undefined` and functions are rejected — ledger
 * entries are plain data, and silently dropping `undefined` would
 * break the "same input → same hash" property if a caller forgot to
 * omit a field.
 *
 * Performance: one pass per nesting level; O(n log n) for key sorting
 * at each object. Entries are small (< 1 KB) so this is negligible
 * compared to the sha256 call.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `canonicalJson: refusing to encode non-finite number ${String(value)}`,
      )
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') {
    throw new Error('canonicalJson: BigInt is not JSON-serializable')
  }
  if (typeof value === 'undefined' || typeof value === 'function') {
    throw new Error(
      `canonicalJson: refusing to encode ${typeof value} — include all fields explicitly`,
    )
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const parts: string[] = []
    for (const key of keys) {
      parts.push(JSON.stringify(key) + ':' + canonicalJson(obj[key]))
    }
    return '{' + parts.join(',') + '}'
  }
  throw new Error(`canonicalJson: unexpected value type: ${typeof value}`)
}

/**
 * Compute a hex-encoded sha256 of a string via Web Crypto's subtle API.
 *
 * We use hex (not base64) for hashes because hex is case-insensitive,
 * fixed-length (64 chars), and easier to compare visually in debug
 * output. Base64 would save a few bytes in storage but every encrypted
 * ledger entry is already much larger than the hash itself.
 */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return bytesToHex(new Uint8Array(digest))
}

/**
 * Compute the canonical hash of a ledger entry. Short wrapper around
 * `canonicalJson` + `sha256Hex`; callers use this instead of composing
 * the two functions every time, so any future change to the hashing
 * pipeline (e.g., adding a domain-separation prefix) lives in one place.
 */
export async function hashEntry(entry: LedgerEntry): Promise<string> {
  return sha256Hex(canonicalJson(entry))
}

/** Convert a Uint8Array to a lowercase hex string. */
function bytesToHex(bytes: Uint8Array): string {
  const hex = new Array<string>(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    // Non-null assertion: indexing a Uint8Array within bounds always
    // returns a number, but the compiler's noUncheckedIndexedAccess
    // flag widens it to `number | undefined`. Safe here by construction.
    hex[i] = (bytes[i] ?? 0).toString(16).padStart(2, '0')
  }
  return hex.join('')
}

/**
 * Pad an index to the canonical 10-digit form used as the adapter key.
 * Ten digits is enough for ~10 billion ledger entries per vault
 * — far beyond any realistic use case, but cheap enough that the extra
 * digits don't hurt storage.
 */
export function paddedIndex(index: number): string {
  return String(index).padStart(10, '0')
}

/** Parse a padded adapter key back into a number. Returns NaN on malformed input. */
export function parseIndex(key: string): number {
  return Number.parseInt(key, 10)
}
