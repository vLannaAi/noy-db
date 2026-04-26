/**
 * `exportBlobsToDirectory(vault, targetDir, opts)` — bulk blob
 * extraction into a real filesystem directory, with target-profile
 * filename sanitization and Zip-Slip path containment built in
 *.
 *
 * Wraps `vault.exportBlobs()` (the framework-agnostic async iterable
 * in core) with the FS-write concerns that don't belong in core:
 *
 *   - sanitize filenames per a target profile (`posix`, `windows`,
 *     `macos-smb`, `zip`, `url-path`, `s3-key`, `opaque`),
 *   - guard against path-escape after sanitization (`PathEscapeError`),
 *   - resolve filename collisions (`suffix` / `overwrite` / `fail` /
 *     custom callback),
 *   - emit a sidecar `manifest.json` when the profile is `'opaque'`,
 *     mapping opaque ids back to the original record-supplied
 *     filenames.
 *
 * @module
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, sep, dirname, extname } from 'node:path'
import type { Vault } from '@noy-db/hub'
import { PathEscapeError } from '@noy-db/hub'
import { sanitizeFilename, type FilenameProfile } from '@noy-db/hub/util'

/** Strategy for resolving two records that sanitize to the same name. */
export type CollisionStrategy =
  | 'suffix'
  | 'overwrite'
  | 'fail'
  | ((existing: string, attempt: number) => string)

export interface ExportBlobsToDirectoryOptions {
  /**
   * Filename profile to sanitize against. Default: `'macos-smb'` —
   * the most restrictive intersection of the rules adopters
   * typically hit. Pick a more specific profile when you know the
   * exact destination.
   */
  readonly filenameProfile?: FilenameProfile
  /**
   * How to handle two blobs whose sanitized filenames collide.
   * Default: `'suffix'`.
   */
  readonly onCollision?: CollisionStrategy
  /**
   * Optional collection allowlist forwarded to `vault.exportBlobs`.
   */
  readonly collections?: readonly string[]
  /**
   * Optional record predicate forwarded to `vault.exportBlobs`.
   */
  readonly where?: (
    record: unknown,
    context: { collection: string; id: string },
  ) => boolean
  /**
   * Optional resume cursor forwarded to `vault.exportBlobs`.
   */
  readonly afterBlobId?: string
  /**
   * External abort signal forwarded to `vault.exportBlobs`.
   */
  readonly signal?: AbortSignal
}

export interface ExportBlobsToDirectoryResult {
  /** Total blobs written. */
  readonly written: number
  /** Total bytes written across all blobs. */
  readonly bytes: number
  /** Pairs of `{ blobId, path }` for every blob that landed on disk. */
  readonly entries: ReadonlyArray<{ blobId: string; path: string }>
  /**
   * When `filenameProfile === 'opaque'`, the absolute path of the
   * `manifest.json` sidecar. `null` for every other profile.
   */
  readonly manifestPath: string | null
}

interface OpaqueManifestEntry {
  readonly opaqueName: string
  readonly originalName: string
  readonly collection: string
  readonly recordId: string
  readonly slot: string
  readonly blobId: string
  readonly mimeType?: string
}

/**
 * Materialize every blob in the vault into `targetDir`. Returns a
 * summary suitable for logging / audit.
 *
 * Caller MUST already hold whatever capability the vault demands
 * (`canExportPlaintext['blob']`) — this function delegates to
 * `vault.exportBlobs()`, which performs the capability check itself.
 */
export async function exportBlobsToDirectory(
  vault: Vault,
  targetDir: string,
  options: ExportBlobsToDirectoryOptions = {},
): Promise<ExportBlobsToDirectoryResult> {
  const profile: FilenameProfile = options.filenameProfile ?? 'macos-smb'
  const onCollision: CollisionStrategy = options.onCollision ?? 'suffix'

  const absTargetDir = resolve(targetDir)
  await mkdir(absTargetDir, { recursive: true })
  const containmentPrefix = absTargetDir + sep

  // Track filenames already used in this run so collision resolution
  // is deterministic and cheap (no extra stat() per attempt).
  const used = new Set<string>()
  const entries: { blobId: string; path: string }[] = []
  const opaqueEntries: OpaqueManifestEntry[] = []
  let totalBytes = 0

  const handle = vault.exportBlobs({
    ...(options.collections && { collections: options.collections }),
    ...(options.where && { where: options.where }),
    ...(options.afterBlobId && { afterBlobId: options.afterBlobId }),
    ...(options.signal && { signal: options.signal }),
  })

  for await (const blob of handle) {
    const original = blob.meta.filename
    const sanitizeOpts =
      profile === 'opaque'
        ? { profile, opaqueId: blob.blobId } as const
        : { profile } as const
    const candidate = sanitizeFilename(original, sanitizeOpts)
    const finalName = resolveCollision(candidate, used, onCollision)
    used.add(finalName)

    const absPath = resolve(absTargetDir, finalName)
    if (absPath !== absTargetDir && !absPath.startsWith(containmentPrefix)) {
      throw new PathEscapeError({ attempted: finalName, targetDir: absTargetDir })
    }

    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, blob.bytes)
    entries.push({ blobId: blob.blobId, path: absPath })
    totalBytes += blob.bytes.byteLength

    if (profile === 'opaque') {
      const entry: OpaqueManifestEntry = {
        opaqueName: finalName,
        originalName: original,
        collection: blob.recordRef.collection,
        recordId: blob.recordRef.id,
        slot: blob.recordRef.slot,
        blobId: blob.blobId,
        ...(blob.meta.mimeType !== undefined && { mimeType: blob.meta.mimeType }),
      }
      opaqueEntries.push(entry)
    }
  }

  let manifestPath: string | null = null
  if (profile === 'opaque') {
    manifestPath = resolve(absTargetDir, 'manifest.json')
    const json = JSON.stringify(
      {
        format: 'noydb-opaque-export',
        version: 1,
        entries: opaqueEntries,
      },
      null,
      2,
    )
    await writeFile(manifestPath, json)
  }

  return {
    written: entries.length,
    bytes: totalBytes,
    entries,
    manifestPath,
  }
}

function resolveCollision(
  candidate: string,
  used: Set<string>,
  strategy: CollisionStrategy,
): string {
  if (!used.has(candidate)) return candidate
  if (strategy === 'overwrite') return candidate
  if (strategy === 'fail') {
    throw new Error(`exportBlobsToDirectory: filename collision on "${candidate}"`)
  }
  // `'suffix'` and the function-callback path both build a sequence
  // of attempts and pick the first non-colliding one.
  for (let attempt = 1; attempt < 10_000; attempt++) {
    const next =
      typeof strategy === 'function'
        ? strategy(candidate, attempt)
        : addSuffix(candidate, attempt)
    if (!used.has(next)) return next
  }
  throw new Error(`exportBlobsToDirectory: collision suffix exhausted for "${candidate}"`)
}

function addSuffix(name: string, attempt: number): string {
  const ext = extname(name)
  if (ext.length > 0 && ext.length < name.length) {
    const stem = name.slice(0, name.length - ext.length)
    return `${stem}-${attempt}${ext}`
  }
  return `${name}-${attempt}`
}
