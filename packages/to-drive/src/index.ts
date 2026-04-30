/**
 * **@noy-db/to-drive** — Google Drive bundle store for noy-db.
 *
 * Stores each vault as a single `.noydb` bundle in Drive. Implements
 * the `NoydbBundleStore` contract (read/write/delete/list whole-bundle);
 * wrap with `wrapBundleStore()` from `@noy-db/hub` to get the standard
 * six-method `NoydbStore` surface.
 *
 * ## Privacy posture
 *
 * - **ULID filenames** — `01HXG4F5ZK7…noydb`, never `acme.noydb`.
 *   Drive folder listings are visible to share recipients, Workspace
 *   admins on managed accounts, and Google's internal search index.
 *   Naming the file after the vault leaks client identity to all of
 *   those. ULIDs give a sortable, collision-free alternative that
 *   discloses nothing.
 * - **`appDataFolder` by default** — a hidden Drive folder that does
 *   NOT show in the Drive UI and is scoped to the installed app only.
 *   Opt in to a user-visible folder for "restore from Drive" UX.
 * - **`drive.file` scope** — the OAuth token can only see files this
 *   app created. No read access to the user's other Drive contents.
 * - **No custom properties** — Drive allows arbitrary key/value
 *   metadata on files. This adapter writes nothing there. Every piece
 *   of vault metadata lives inside the encrypted body.
 *
 * ## Driver — bring your own
 *
 * noy-db does NOT pull `googleapis` (or any Google SDK) as a runtime
 * dependency. The consumer wires their preferred client (`googleapis`,
 * `gapi-client-ts`, a bespoke `fetch` wrapper) and passes a duck-typed
 * `DriveClient` in. Every OAuth refresh concern stays outside this
 * package.
 *
 * ## Handle registry
 *
 * Drive's API identifies files by `fileId`, not filename. To resolve
 * "give me the bundle for vault ACME," the store needs to remember
 * which fileId corresponds to which vault. Two options:
 *
 *   1. **Consumer-persisted** — pass a `HandleStore` that implements
 *      `getHandle(vaultId)` / `setHandle(vaultId, handle)`. Typical
 *      implementations: localStorage in browsers, the vault's
 *      `_sync_credentials` collection, or a JSON file on disk.
 *   2. **Drive-lookup** (default) — when no handle is cached, issue a
 *      `files.list` call filtering by the ULID-encoded vaultId hash.
 *      Slower but requires no extra plumbing.
 *
 * @packageDocumentation
 */

import type { NoydbBundleStore } from '@noy-db/hub'
import { BundleVersionConflictError } from '@noy-db/hub'

// ── Duck-typed Drive client ──────────────────────────────────────────────

/**
 * Minimal shape the store needs from a Google Drive client. Every
 * production Drive wrapper (`googleapis`, `gapi`, hand-rolled `fetch`
 * code) can expose this surface with a thin adapter.
 */
export interface DriveClient {
  createFile(request: DriveCreateRequest): Promise<DriveFileMeta>
  updateFile(fileId: string, request: DriveUpdateRequest): Promise<DriveFileMeta>
  getFileMetadata(fileId: string): Promise<DriveFileMeta | null>
  getFileBytes(fileId: string): Promise<Uint8Array | null>
  deleteFile(fileId: string): Promise<void>
  listFiles(query: DriveListQuery): Promise<DriveFileMeta[]>
}

export interface DriveCreateRequest {
  readonly name: string
  readonly bytes: Uint8Array
  readonly parents: readonly string[]
  readonly mimeType?: string
}

export interface DriveUpdateRequest {
  readonly bytes: Uint8Array
  readonly expectedRevision?: string | null
}

export interface DriveListQuery {
  readonly parents?: readonly string[]
  readonly namePrefix?: string
  readonly nameExact?: string
  readonly mimeType?: string
  readonly limit?: number
}

export interface DriveFileMeta {
  readonly id: string
  readonly name: string
  readonly headRevisionId: string
  readonly size: number
}

// ── Handle registry ──────────────────────────────────────────────────────

export interface HandleStore {
  getHandle(vaultId: string): Promise<DriveHandle | null>
  setHandle(vaultId: string, handle: DriveHandle): Promise<void>
  deleteHandle(vaultId: string): Promise<void>
  /** Return every known { vaultId, handle } pair. Used by `listBundles()`. */
  listHandles?(): Promise<Array<{ vaultId: string; handle: DriveHandle }>>
}

export interface DriveHandle {
  /** Stable Drive fileId. */
  readonly fileId: string
  /** ULID filename — what lives in Drive. */
  readonly name: string
}

/**
 * In-memory handle store — fine for short-lived processes and tests.
 * Production consumers should persist handles to localStorage, IDB,
 * or a vault's `_sync_credentials` collection.
 */
export function memoryHandleStore(): HandleStore {
  const map = new Map<string, DriveHandle>()
  return {
    async getHandle(vaultId) { return map.get(vaultId) ?? null },
    async setHandle(vaultId, handle) { map.set(vaultId, handle) },
    async deleteHandle(vaultId) { map.delete(vaultId) },
    async listHandles() {
      return [...map.entries()].map(([vaultId, handle]) => ({ vaultId, handle }))
    },
  }
}

// ── ULID generator (minimal, copy-free) ───────────────────────────────────

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Generate a new ULID — 26 characters: 10 chars of timestamp (ms
 * granularity, sortable lexically when generated ≥ 1 ms apart) plus
 * 16 chars of entropy (80 bits).
 */
export function newUlid(): string {
  const time = Date.now()
  let timePart = ''
  let t = time
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ALPHABET[t % 32]! + timePart
    t = Math.floor(t / 32)
  }
  // 16 chars of random → 16 bytes. 256 is a multiple of 32 so `byte % 32`
  // produces a uniform distribution over the alphabet.
  const rand = globalThis.crypto.getRandomValues(new Uint8Array(16))
  let randPart = ''
  for (const byte of rand) {
    randPart += ULID_ALPHABET[byte % 32]
  }
  return timePart + randPart
}

// ── Options + factory ────────────────────────────────────────────────────

export interface DriveStoreOptions {
  readonly drive: DriveClient
  /**
   * Parent folder id. Defaults to Drive's `appDataFolder` — hidden from
   * the user, scoped to the app. Pass an explicit id to use a
   * user-visible folder.
   */
  readonly parentId?: string
  /** Handle registry — memory by default. Persist yourself in prod. */
  readonly handles?: HandleStore
  /** Bundle filename suffix. Default `'.noydb'`. */
  readonly suffix?: string
}

const APP_DATA_FOLDER = 'appDataFolder'
const DEFAULT_MIME = 'application/octet-stream'

export function drive(options: DriveStoreOptions): NoydbBundleStore {
  const parentId = options.parentId ?? APP_DATA_FOLDER
  const handles = options.handles ?? memoryHandleStore()
  const suffix = options.suffix ?? '.noydb'
  const { drive: client } = options

  async function handleFor(vaultId: string): Promise<DriveHandle | null> {
    return handles.getHandle(vaultId)
  }

  return {
    kind: 'bundle',
    name: 'google-drive',

    async readBundle(vaultId) {
      const handle = await handleFor(vaultId)
      if (!handle) return null

      const meta = await client.getFileMetadata(handle.fileId)
      if (!meta) {
        // Out-of-band deletion — clear the cached handle.
        await handles.deleteHandle(vaultId)
        return null
      }
      const bytes = await client.getFileBytes(handle.fileId)
      if (!bytes) return null
      return { bytes, version: meta.headRevisionId }
    },

    async writeBundle(vaultId, bytes, expectedVersion) {
      const handle = await handleFor(vaultId)
      if (!handle) {
        if (expectedVersion !== null) {
          throw new BundleVersionConflictError(
            `No existing bundle for vault "${vaultId}" but expectedVersion="${expectedVersion}" was supplied.`,
          )
        }
        const name = `${newUlid()}${suffix}`
        const meta = await client.createFile({
          name,
          bytes,
          parents: [parentId],
          mimeType: DEFAULT_MIME,
        })
        await handles.setHandle(vaultId, { fileId: meta.id, name: meta.name })
        return { version: meta.headRevisionId }
      }
      const meta = await client.updateFile(handle.fileId, {
        bytes,
        expectedRevision: expectedVersion,
      })
      return { version: meta.headRevisionId }
    },

    async deleteBundle(vaultId) {
      const handle = await handleFor(vaultId)
      if (!handle) return
      try {
        await client.deleteFile(handle.fileId)
      } catch {
        // Already gone.
      }
      await handles.deleteHandle(vaultId)
    },

    async listBundles() {
      if (handles.listHandles) {
        const known = await handles.listHandles()
        const out: Array<{ vaultId: string; version: string; size: number }> = []
        for (const { vaultId, handle } of known) {
          const meta = await client.getFileMetadata(handle.fileId)
          if (!meta) continue
          out.push({ vaultId, version: meta.headRevisionId, size: meta.size })
        }
        return out
      }
      // No handle index: fall back to Drive listing. This returns Drive
      // file ids as "vault ids", which is imperfect — consumers are
      // expected to either run a handle store or never call listBundles.
      const files = await client.listFiles({ parents: [parentId], mimeType: DEFAULT_MIME })
      return files
        .filter(f => f.name.endsWith(suffix))
        .map(f => ({ vaultId: f.name.slice(0, -suffix.length), version: f.headRevisionId, size: f.size }))
    },
  }
}
