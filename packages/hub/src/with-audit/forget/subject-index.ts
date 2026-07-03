/**
 * The encrypted subject index.
 *
 * GDPR crypto-shred needs to answer "which records belong to data subject
 * X?" portably (the index must travel with the vault/bundle) WITHOUT leaking
 * subject-equivalence to the store. The rejected alternative — an unencrypted
 * subject tag in envelope metadata — would let anyone with store access see
 * which records share a subject. Instead we keep a reserved `_subject_index`
 * collection, encrypted under its OWN DEK (`getDEK('_subject_index')`):
 *
 *   - record id  = `HMAC-SHA256(indexDEK, subjectId)` (M-2). A bare
 *     `sha256Hex(subjectId)` would be offline-computable: an attacker with
 *     store access and a candidate list (emails / customer ids are low-entropy)
 *     could dictionary the hash to confirm "subject X is present here." Keying
 *     the id with the vault-only index DEK removes that capability — without the
 *     DEK the id cannot be derived. (Legacy entries written before M-2 used the
 *     bare sha256 id; the read/remove paths dual-look-up both forms.)
 *   - record body = AES-GCM(JSON `{ r: [{ collection, id }], p }`) under the
 *     index DEK, where `p` pads the plaintext to a bucketed length so the
 *     ciphertext `_data` length does not leak the approximate record count.
 *     Legacy bodies were a bare `[{ collection, id }]` array; reads accept both.
 *
 * ## Concurrency (RISK #3 — known v1 limitation)
 *
 * `addSubjectRef` / `removeSubjectRef` are read-modify-write with no CAS. The
 * design assumes a SINGLE WRITER (the noy-db single-process write model). Two
 * concurrent writers racing on the SAME subject can lose an entry (last-write
 * wins on the ref list). This is documented, not fixed in v1:
 * `rebuildSubjectIndex` performs a full scan to recover a correct index from
 * the canonical records, so a lost ref is recoverable. A CAS-backed index is
 * deferred to a later slice.
 *
 * @module
 */
import { encrypt, openEnvelopeJson, hmacSha256Hex, sha256Hex, type EnclaveKey } from '../../kernel/enclave/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'

/** Reserved collection holding the encrypted subject → records index. */
export const SUBJECT_INDEX_COLLECTION = '_subject_index'

/**
 * Bucket (bytes) the encrypted ref-list plaintext is padded up to, so the
 * ciphertext `_data` length leaks only `count` rounded up to a bucket — not the
 * exact record count. 256 keeps small subjects (the common case) indistinguishable.
 */
const REF_LIST_BUCKET = 256

/** A single record reference held in a subject's index entry. */
export interface SubjectRef {
  readonly collection: string
  readonly id: string
}

type GetDEK = (collectionName: string) => Promise<EnclaveKey>

/** SHA-256 hex of a UTF-8 string. The LEGACY (pre-M-2) subject-index key. */
async function sha256HexString(input: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(input))
}

/**
 * The subject-index record id(s) to consult for a subject, most-current first.
 *
 * - Encrypted vault: the PRIMARY id is `HMAC-SHA256(indexDEK, subjectId)` (M-2)
 *   — not offline-computable. The LEGACY `sha256Hex(subjectId)` id is also
 *   returned so reads/removes still find entries written before M-2 (dual-lookup).
 * - Plaintext/debug vault: no DEK to key with, so the only id is the legacy
 *   sha256 form (unchanged behaviour — plaintext mode is not zero-knowledge anyway).
 */
async function subjectKeys(getDEK: GetDEK, encrypted: boolean, subjectId: string): Promise<string[]> {
  const legacy = await sha256HexString(subjectId)
  if (!encrypted) return [legacy]
  const dek = await getDEK(SUBJECT_INDEX_COLLECTION)
  const keyed = await hmacSha256Hex(dek, new TextEncoder().encode(subjectId))
  return keyed === legacy ? [keyed] : [keyed, legacy]
}

/** The id new writes land under (keyed when encrypted, else legacy sha256). */
async function primarySubjectKey(getDEK: GetDEK, encrypted: boolean, subjectId: string): Promise<string> {
  return (await subjectKeys(getDEK, encrypted, subjectId))[0]!
}

/** Parse a stored ref-list body: new padded `{ r, p }` wrapper OR legacy bare array. */
function parseRefs(json: string): SubjectRef[] {
  const parsed = JSON.parse(json) as SubjectRef[] | { r: SubjectRef[] }
  return Array.isArray(parsed) ? parsed : parsed.r
}

/** Serialize + pad the ref list to a bucket boundary (encrypted vaults only). */
function serializeRefs(refs: SubjectRef[]): string {
  const base = JSON.stringify({ r: refs, p: '' })
  const pad = Math.ceil(base.length / REF_LIST_BUCKET) * REF_LIST_BUCKET - base.length
  return JSON.stringify({ r: refs, p: ' '.repeat(pad) })
}

/** Read + decrypt the ref list at a SINGLE index key. Returns `[]` when absent. */
async function readRefs(
  adapter: NoydbStore,
  vault: string,
  getDEK: GetDEK,
  encrypted: boolean,
  key: string,
): Promise<SubjectRef[]> {
  const env = await adapter.get(vault, SUBJECT_INDEX_COLLECTION, key)
  if (!env || !env._data) return []
  if (!encrypted) return parseRefs(env._data)
  const dek = await getDEK(SUBJECT_INDEX_COLLECTION)
  const json = await openEnvelopeJson(env, dek)
  return parseRefs(json)
}

/** Encrypt + write a ref list for a subject under its derived key. */
async function writeRefs(
  adapter: NoydbStore,
  vault: string,
  getDEK: GetDEK,
  encrypted: boolean,
  key: string,
  refs: SubjectRef[],
): Promise<void> {
  let env: EncryptedEnvelope
  if (!encrypted) {
    // Plaintext/debug vault: keep the legacy bare-array form (no padding needed).
    env = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify(refs) }
  } else {
    const dek = await getDEK(SUBJECT_INDEX_COLLECTION)
    const { iv, data } = await encrypt(serializeRefs(refs), dek)
    env = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: new Date().toISOString(), _iv: iv, _data: data }
  }
  await adapter.put(vault, SUBJECT_INDEX_COLLECTION, key, env)
}

/**
 * Add a `{ collection, id }` ref to a subject's index entry (idempotent —
 * a duplicate ref is not appended). Read-modify-write; see the concurrency
 * note in the module docstring.
 */
export async function addSubjectRef(
  adapter: NoydbStore,
  vault: string,
  getDEK: GetDEK,
  encrypted: boolean,
  subjectId: string,
  ref: SubjectRef,
): Promise<void> {
  const key = await primarySubjectKey(getDEK, encrypted, subjectId)
  const refs = await readRefs(adapter, vault, getDEK, encrypted, key)
  if (refs.some((r) => r.collection === ref.collection && r.id === ref.id)) return
  refs.push(ref)
  await writeRefs(adapter, vault, getDEK, encrypted, key, refs)
}

/**
 * Remove a `{ collection, id }` ref from a subject's index entry. When the
 * last ref is removed the (now empty) entry is deleted so the store holds no
 * residual key for an erased subject.
 */
export async function removeSubjectRef(
  adapter: NoydbStore,
  vault: string,
  getDEK: GetDEK,
  encrypted: boolean,
  subjectId: string,
  ref: SubjectRef,
): Promise<void> {
  // Dual-lookup: drop the ref from BOTH the keyed (M-2) and the legacy sha256
  // entry, so a pre-M-2 subject is still fully erased.
  for (const key of await subjectKeys(getDEK, encrypted, subjectId)) {
    const refs = await readRefs(adapter, vault, getDEK, encrypted, key)
    const next = refs.filter((r) => !(r.collection === ref.collection && r.id === ref.id))
    if (next.length === refs.length) continue
    if (next.length === 0) {
      await adapter.delete(vault, SUBJECT_INDEX_COLLECTION, key)
    } else {
      await writeRefs(adapter, vault, getDEK, encrypted, key, next)
    }
  }
}

/**
 * Look up every record ref for a subject. Returns `[]` when none exist. Unions
 * the keyed (M-2) and legacy sha256 entries (dual-lookup), deduplicated, so a
 * subject indexed before M-2 is still fully found.
 */
export async function lookupSubject(
  adapter: NoydbStore,
  vault: string,
  getDEK: GetDEK,
  encrypted: boolean,
  subjectId: string,
): Promise<SubjectRef[]> {
  const keys = await subjectKeys(getDEK, encrypted, subjectId)
  const seen = new Set<string>()
  const out: SubjectRef[] = []
  for (const key of keys) {
    for (const ref of await readRefs(adapter, vault, getDEK, encrypted, key)) {
      const dedup = `${ref.collection}\u0000${ref.id}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      out.push(ref)
    }
  }
  return out
}

/**
 * Rebuild the entire subject index from the canonical records (the recovery
 * path for the documented read-modify-write race). Scans each declared
 * collection, reads `record[subjectField]` (dotted path), and rewrites the
 * index from scratch. Tombstoned (already-shredded) records contribute no
 * ref — their body is gone, so they cannot be re-indexed.
 *
 * `decodeRecord` decrypts an envelope to a plain object (or returns null for
 * a tombstone / unreadable record); supplied by the caller so this module
 * stays free of Collection internals.
 */
export async function rebuildSubjectIndex(
  adapter: NoydbStore,
  vault: string,
  getDEK: GetDEK,
  encrypted: boolean,
  subjects: Readonly<Record<string, string>>,
  decodeRecord: (collection: string, id: string, env: EncryptedEnvelope) => Promise<Record<string, unknown> | null>,
): Promise<number> {
  // Drop every existing index entry first so removed refs don't linger.
  const existing = await adapter.list(vault, SUBJECT_INDEX_COLLECTION)
  for (const k of existing) {
    await adapter.delete(vault, SUBJECT_INDEX_COLLECTION, k)
  }

  // subjectId → refs, accumulated across all declared collections.
  const bySubject = new Map<string, SubjectRef[]>()
  for (const [collection, field] of Object.entries(subjects)) {
    const ids = await adapter.list(vault, collection)
    for (const id of ids) {
      if (id.startsWith('_')) continue
      const env = await adapter.get(vault, collection, id)
      if (!env || !env._data) continue // missing or tombstone
      const record = await decodeRecord(collection, id, env)
      if (record === null) continue
      const subjectValue = readDottedPath(record, field)
      if (subjectValue === undefined || subjectValue === null) continue
      const subjectId = coerceSubjectId(subjectValue)
      const list = bySubject.get(subjectId) ?? []
      list.push({ collection, id })
      bySubject.set(subjectId, list)
    }
  }

  let entries = 0
  for (const [subjectId, refs] of bySubject) {
    const key = await primarySubjectKey(getDEK, encrypted, subjectId)
    await writeRefs(adapter, vault, getDEK, encrypted, key, refs)
    entries++
  }
  return entries
}

/**
 * Coerce a read subject-field value to a stable string id. Primitives use
 * their natural string form; objects/arrays are JSON-stringified so structural
 * subjects still get a deterministic key (avoids the `[object Object]` trap).
 */
export function coerceSubjectId(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value)
}

/** Read a (possibly dotted) field path from a plain record. */
export function readDottedPath(record: Record<string, unknown>, field: string): unknown {
  if (!field.includes('.')) return record[field]
  let cursor: unknown = record
  for (const segment of field.split('.')) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}
