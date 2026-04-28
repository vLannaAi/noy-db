/**
 * **@noy-db/as-zip** — composite record + blob archive for noy-db.
 *
 * Bundles a collection's records AND every record's attached blobs
 * into a single zip archive. The canonical "download this audit
 * trail" / "migrate this case folder" primitive. Part of the
 * `@noy-db/as-*` portable-artefact family — plaintext tier,
 * document sub-family.
 *
 * ## Authorisation (RFC #249)
 *
 * One capability check: `assertCanExport('plaintext', 'zip')`.
 * A composite archive is semantically the `'zip'` format from the
 * auth model's POV — requiring separate `'json'`, `'csv'`, `'blob'`
 * grants for a single call would fragment the grant surface without
 * adding any real isolation (the archive concatenates them anyway).
 *
 * The owner grants the composite capability explicitly:
 *
 * ```ts
 * await db.grant('firm', {
 *   userId: 'auditor',
 *   role: 'viewer',
 *   passphrase: '…',
 *   exportCapability: { plaintext: ['zip'] },
 * })
 * ```
 *
 * ## Archive layout
 *
 * ```
 * archive.zip
 * ├── manifest.json      # index + provenance (record count, blob count, exported-at, exported-by)
 * ├── records.json       # array of decrypted records
 * └── attachments/
 *     ├── <recordId>/<slot>        # raw blob bytes, MIME-native
 *     └── ...
 * ```
 *
 * The folder-per-record layout makes composite entities (email +
 * body + attachments, invoice + scan + receipt) navigable in
 * Finder/Explorer without tooling.
 *
 * See [`docs/patterns/as-exports.md`](https://github.com/vLannaAi/noy-db/blob/main/docs/patterns/as-exports.md).
 *
 * @packageDocumentation
 */

import type { Vault } from '@noy-db/hub'
import { writeZip, type ZipEntry } from './zip.js'

// Re-export the low-level encoder so consumers who want to build
// custom archives (non-noy-db payloads) can reuse it directly.
export { writeZip, crc32, type ZipEntry, type WriteZipOptions } from './zip.js'

// Re-export the reader + cipher errors. ZipReadError is thrown on
// format violations; ZipCipherError on wrong-password or tampered
// ciphertext (the two are surfaced as the same class so callers can
// catch one and not the other).
export { readZip, type ReadZipEntry, type ReadZipOptions, ZipReadError } from './read.js'
export { ZipCipherError } from './aes.js'

/** Record-selection options. */
export interface AsZipRecordsOptions {
  /** Collection to export. Must be in the caller's read ACL. */
  readonly collection: string
  /**
   * Optional predicate against each decrypted record. When omitted,
   * every record is included. Runs after decryption, before zip
   * assembly — doesn't reduce I/O, just the final set.
   */
  readonly filter?: (record: unknown) => boolean
}

/** Blob-selection options. */
export interface AsZipAttachmentsOptions {
  /**
   * Which slots to include per record. `'*'` (default) includes
   * every slot on every record; a string[] selects specific slot
   * names. Pass an empty array to skip blob inclusion entirely.
   */
  readonly slots?: readonly string[] | '*'
}

/** Top-level options for every entry point. */
export interface AsZipOptions {
  readonly records: AsZipRecordsOptions
  readonly attachments?: AsZipAttachmentsOptions
  /**
   * Optional WinZip-AES-256 passphrase (#304). When set, every entry
   * inside the archive (records + attachments + manifest) is
   * encrypted with WinZip-AES-256 and the recipient must supply the
   * passphrase to extract.
   *
   * **Interop note:** the implementation is strictly to spec but has
   * not been validated against 7-Zip / Archive Utility / WinRAR in
   * this checkout. Round-trips against the package's own reader pass.
   * See https://github.com/vLannaAi/noy-db/issues/304 for the
   * cross-tool validation matrix.
   *
   * **Security framing:** this is the *interop* layer for
   * cross-platform handoff to archive tools, not the *encryption*
   * layer for sharing noy-db state. Use `as-noydb` for multi-recipient
   * + revocable + audited egress.
   */
  readonly password?: string
}

/** Options for `download()` — adds an optional filename. */
export interface AsZipDownloadOptions extends AsZipOptions {
  /** Filename offered to the browser. Default `'<collection>.zip'`. */
  readonly filename?: string
}

/** Options for `write()` — requires explicit risk acknowledgement. */
export interface AsZipWriteOptions extends AsZipOptions {
  /**
   * Required for Node file-write calls — consumer acknowledgement
   * that plaintext bytes will persist on disk past the current
   * process lifetime (Tier 3 risk).
   */
  readonly acknowledgeRisks: true
}

/** Manifest entry — one per record that landed in the archive. */
export interface ManifestRecord {
  readonly id: string
  readonly attachments: ReadonlyArray<{
    readonly slot: string
    readonly path: string
    readonly size: number
    readonly mimeType?: string
  }>
}

/** Archive-level manifest. Serialised as `manifest.json`. */
export interface ArchiveManifest {
  readonly _noydb_archive: 1
  readonly collection: string
  readonly exportedAt: string
  readonly recordCount: number
  readonly attachmentCount: number
  readonly records: readonly ManifestRecord[]
}

/**
 * Assemble the archive bytes. Pure beyond the auth check + store
 * reads. Records are written as `records.json`; blobs as
 * `attachments/<recordId>/<slot>`. A `manifest.json` index lands
 * at the archive root so extractors can walk the content without
 * re-reading every file.
 */
export async function toBytes(vault: Vault, options: AsZipOptions): Promise<Uint8Array> {
  vault.assertCanExport('plaintext', 'zip')

  const collectionName = options.records.collection
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const collection = vault.collection<any>(collectionName)

  // Pull every id the caller can see + the decrypted record for each.
  const ids = await collection.list().then((rs) => extractIds(rs))
  const records: Array<{ id: string; record: unknown }> = []
  for (const id of ids) {
    const r = await collection.get(id)
    if (r === null) continue
    if (options.records.filter && !options.records.filter(r)) continue
    records.push({ id, record: r })
  }

  // Gather attachments per record, filtered by slot selection.
  const slotsSelector = options.attachments?.slots ?? '*'
  const attachmentEntries: Array<{ path: string; bytes: Uint8Array; size: number; slot: string; mimeType?: string; recordId: string }> = []
  const includeAll = slotsSelector === '*'
  const includeSet = includeAll ? null : new Set<string>(slotsSelector)

  for (const { id } of records) {
    const blobSet = collection.blob(id)
    const slotsList = await blobSet.list()
    for (const slot of slotsList) {
      if (!includeAll && !includeSet!.has(slot.name)) continue
      const bytes = await blobSet.get(slot.name)
      if (!bytes) continue
      const safeId = sanitiseFsSegment(id)
      const safeSlot = sanitiseFsSegment(slot.name)
      const entry = {
        path: `attachments/${safeId}/${safeSlot}`,
        bytes,
        size: bytes.length,
        slot: slot.name,
        recordId: id,
        ...(slot.mimeType !== undefined && { mimeType: slot.mimeType }),
      }
      attachmentEntries.push(entry)
    }
  }

  // Manifest + records.json.
  const recordIndex: ManifestRecord[] = records.map(({ id }) => {
    const attach = attachmentEntries
      .filter((a) => a.recordId === id)
      .map(({ slot, path, size, mimeType }) => ({
        slot,
        path,
        size,
        ...(mimeType !== undefined && { mimeType }),
      }))
    return { id, attachments: attach }
  })
  const manifest: ArchiveManifest = {
    _noydb_archive: 1,
    collection: collectionName,
    exportedAt: new Date().toISOString(),
    recordCount: records.length,
    attachmentCount: attachmentEntries.length,
    records: recordIndex,
  }

  const encoder = new TextEncoder()
  const entries: ZipEntry[] = [
    { path: 'manifest.json', bytes: encoder.encode(JSON.stringify(manifest, null, 2)) },
    {
      path: 'records.json',
      bytes: encoder.encode(
        JSON.stringify(
          records.map((r) => {
            const pojo = toPojo(r.record)
            const base = pojo && typeof pojo === 'object' && !Array.isArray(pojo)
              ? (pojo as Record<string, unknown>)
              : { value: pojo }
            return { _id: r.id, ...base }
          }),
          null,
          2,
        ),
      ),
    },
  ]
  for (const a of attachmentEntries) {
    entries.push({ path: a.path, bytes: a.bytes })
  }

  return writeZip(entries, options.password !== undefined ? { password: options.password } : {})
}

/**
 * Browser download — wraps `toBytes()` in a `Blob` and triggers the
 * browser's download prompt. Requires `URL.createObjectURL` +
 * `document.createElement`. Throws in headless Node.
 */
export async function download(vault: Vault, options: AsZipDownloadOptions): Promise<void> {
  const bytes = await toBytes(vault, options)
  const filename = options.filename ?? `${options.records.collection}.zip`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob = new Blob([bytes as any], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Node file-write — persists the archive to disk. Requires
 * explicit `acknowledgeRisks: true` (Tier 3 egress — the archive
 * contains plaintext records + blob bytes).
 */
export async function write(
  vault: Vault,
  path: string,
  options: AsZipWriteOptions,
): Promise<void> {
  if (options.acknowledgeRisks !== true) {
    throw new Error(
      'as-zip.write: acknowledgeRisks: true is required for on-disk plaintext output. ' +
        'This call creates a persistent plaintext archive outside noy-db\'s encrypted ' +
        'storage — see docs/patterns/as-exports.md §"The three tiers of \\"plaintext out\\""',
    )
  }
  const bytes = await toBytes(vault, options)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, bytes)
}

// ── Import (#302 phase 1 + #304 password) ─────────────────────────

import { diffVault, type VaultDiff } from '@noy-db/hub'
import { readZip } from './read.js'

export type ImportPolicy = 'merge' | 'replace' | 'insert-only'

export interface AsZipImportOptions {
  /** Target collection for the records. */
  readonly collection: string
  /** Field on each record that carries its id. Default `'id'`. */
  readonly idKey?: string
  /** Reconciliation policy. Default `'merge'`. */
  readonly policy?: ImportPolicy
  /** WinZip-AES-256 passphrase if the archive is encrypted (#304). */
  readonly password?: string
}

export interface AsZipImportPlan {
  readonly plan: VaultDiff
  readonly policy: ImportPolicy
  apply(): Promise<void>
}

/**
 * Read a `.zip` archive (optionally WinZip-AES-256 encrypted), parse
 * `records.json` from it, and return an `ImportPlan` whose `apply()`
 * writes the changes through the normal collection API.
 *
 * Pairs with `toBytes` for round-trip workflows. The records JSON
 * format matches what `toBytes` writes — array of records under
 * the configured collection's id key.
 */
export async function fromBytes(
  vault: Vault,
  bytes: Uint8Array,
  options: AsZipImportOptions,
): Promise<AsZipImportPlan> {
  vault.assertCanImport('plaintext', 'zip')
  const policy: ImportPolicy = options.policy ?? 'merge'
  const idKey = options.idKey ?? 'id'

  const entries = await readZip(bytes, options.password !== undefined ? { password: options.password } : {})
  const recordsEntry = entries.find((e) => e.path === 'records.json')
  if (!recordsEntry) {
    throw new Error('as-zip.fromBytes: archive is missing records.json')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(recordsEntry.bytes))
  } catch (err) {
    throw new Error(`as-zip.fromBytes: records.json is not valid JSON (${(err as Error).message})`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('as-zip.fromBytes: records.json must be a JSON array of records')
  }

  const plan = await diffVault(vault, { [options.collection]: parsed as Record<string, unknown>[] }, {
    collections: [options.collection],
    idKey,
  })

  return {
    plan,
    policy,
    async apply(): Promise<void> {
      // Routes through the txStrategy seam — throws clearly when
      // withTransactions() isn't opted in. Atomicity rolls back any
      // partial writes if a put fails mid-batch.
      await vault.noydb.transaction((tx) => {
        const txVault = tx.vault(vault.name)
        for (const entry of plan.added) {
          txVault.collection(entry.collection).put(entry.id, entry.record)
        }
        if (policy !== 'insert-only') {
          for (const entry of plan.modified) {
            txVault.collection(entry.collection).put(entry.id, entry.record)
          }
        }
        if (policy === 'replace') {
          for (const entry of plan.deleted) {
            txVault.collection(entry.collection).delete(entry.id)
          }
        }
      })
    },
  }
}

// ── internals ─────────────────────────────────────────────────────

/**
 * Collection.list() returns an array of records OR record ids
 * depending on the call shape. as-zip always needs ids + records
 * separately; we call list() to materialise records then build the
 * id list from `_id`/record identity. Fall back to treating the
 * list as ids directly when records don't carry a canonical id.
 */
function extractIds(list: unknown[]): string[] {
  const out: string[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      out.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>
      // Canonical — a `.id` field. Falls back to `_id` for
      // consumers that store ids in a mongo-style field.
      const id = rec.id ?? rec._id
      if (typeof id === 'string') out.push(id)
    }
  }
  return out
}

/** Stringify-safe view of a record — drops functions, coerces Dates to ISO. */
function toPojo(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toPojo)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = toPojo(v)
    return out
  }
  return value
}

/**
 * Filesystem-friendly path segment — replaces characters that
 * unzippers on Windows / Linux / macOS may reject or interpret
 * specially (path separators, control chars, reserved names).
 * Preserves the id's readability for sensible ULID / UUID / numeric
 * cases.
 */
function sanitiseFsSegment(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_') || '_'
}
