/**
 * The encrypted subject index (#304).
 *
 * GDPR crypto-shred needs to answer "which records belong to data subject
 * X?" portably (the index must travel with the vault/bundle) WITHOUT leaking
 * subject-equivalence to the store. The rejected alternative — an unencrypted
 * subject tag in envelope metadata — would let anyone with store access see
 * which records share a subject. Instead we keep a reserved `_subject_index`
 * collection, encrypted under its OWN DEK (`getDEK('_subject_index')`):
 *
 *   - record id  = `sha256Hex(subjectId)` — the raw subject id never appears
 *     as a key, so the store can't correlate index entries to a known subject.
 *   - record body = AES-GCM(JSON `[{ collection, id }]`) under the index DEK.
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
import { encrypt, decrypt } from '../../crypto.js'
import type { NoydbStore, EncryptedEnvelope } from '../../types.js'
import { NOYDB_FORMAT_VERSION } from '../../types.js'

/** Reserved collection holding the encrypted subject → records index. */
export const SUBJECT_INDEX_COLLECTION = '_subject_index'

/** A single record reference held in a subject's index entry. */
export interface SubjectRef {
  readonly collection: string
  readonly id: string
}

type GetDEK = (collectionName: string) => Promise<CryptoKey>

/** SHA-256 hex of a UTF-8 string. The subject-index record key derivation. */
async function sha256HexString(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Stable subject-index record id for a subject id. */
export async function subjectKey(subjectId: string): Promise<string> {
  return sha256HexString(subjectId)
}

/** Read + decrypt the ref list for a subject. Returns `[]` when absent. */
async function readRefs(
  adapter: NoydbStore,
  vault: string,
  getDEK: GetDEK,
  encrypted: boolean,
  key: string,
): Promise<SubjectRef[]> {
  const env = await adapter.get(vault, SUBJECT_INDEX_COLLECTION, key)
  if (!env || !env._data) return []
  if (!encrypted) return JSON.parse(env._data) as SubjectRef[]
  const dek = await getDEK(SUBJECT_INDEX_COLLECTION)
  const json = await decrypt(env._iv, env._data, dek)
  return JSON.parse(json) as SubjectRef[]
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
  const json = JSON.stringify(refs)
  let env: EncryptedEnvelope
  if (!encrypted) {
    env = { _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: new Date().toISOString(), _iv: '', _data: json }
  } else {
    const dek = await getDEK(SUBJECT_INDEX_COLLECTION)
    const { iv, data } = await encrypt(json, dek)
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
  const key = await subjectKey(subjectId)
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
  const key = await subjectKey(subjectId)
  const refs = await readRefs(adapter, vault, getDEK, encrypted, key)
  const next = refs.filter((r) => !(r.collection === ref.collection && r.id === ref.id))
  if (next.length === refs.length) return
  if (next.length === 0) {
    await adapter.delete(vault, SUBJECT_INDEX_COLLECTION, key)
    return
  }
  await writeRefs(adapter, vault, getDEK, encrypted, key, next)
}

/** Look up every record ref for a subject. Returns `[]` when none exist. */
export async function lookupSubject(
  adapter: NoydbStore,
  vault: string,
  getDEK: GetDEK,
  encrypted: boolean,
  subjectId: string,
): Promise<SubjectRef[]> {
  const key = await subjectKey(subjectId)
  return readRefs(adapter, vault, getDEK, encrypted, key)
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
    const key = await subjectKey(subjectId)
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
