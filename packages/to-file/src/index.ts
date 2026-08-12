/**
 * **@noy-db/to-file** — JSON file store for NOYDB (USB / local disk).
 *
 * Maps the NOYDB hierarchy directly to the filesystem:
 *
 * ```
 * {dir}/
 *   {vault}/
 *     {collection}/
 *       {id}.json          ← EncryptedEnvelope, optionally pretty-printed
 *     _keyring/
 *       {userId}.json      ← wrapped DEKs for this user
 *     _sync/
 *       meta.json          ← sync metadata
 * ```
 *
 * ## When to use
 *
 * - **USB stick workflow** — the data directory lives on a removable drive.
 *   Plug in, unlock, work offline, eject. No cloud dependency.
 * - **Local development** — simple, inspectable files; no Docker or cloud
 *   credentials required.
 * - **Single-user desktop apps** — Electron, Tauri, or any Node.js app that
 *   writes to a local directory.
 *
 * ## Capabilities
 *
 * | Capability | Value |
 * |---|---|
 * | `casAtomic` | `false` — no atomic compare-and-swap at the FS layer |
 * | `serverWriteTime` | `true` — local filesystem clock; solo-writer only |
 * | `listVaults` | ✓ — enumerates subdirectories |
 * | `listPage` | ✓ — cursor-based pagination over sorted filenames |
 * | `ping` | ✓ — `stat(dir)` |
 *
 * ## Atomicity
 *
 * The filesystem has `rename` but no atomic CAS — `casAtomic` is `false`,
 * and the `expectedVersion` check is read-then-write, so it is advisory
 * under concurrent writers. Per-record writes do go through
 * `{id}.json.{pid}.{n}.tmp` + rename, so a write interrupted partway (a
 * laptop dropping Wi-Fi mid-write to a mounted share, a USB stick pulled
 * during a flush) can never leave a truncated `{id}.json` behind — readers
 * see the complete previous file or the complete new one. Orphaned `.tmp`
 * sidecars from a crashed process are invisible to `list`, `listPage` and
 * `loadAll`, which only accept `.json`.
 *
 * This is atomicity of *visibility*, not durability: surviving a power cut
 * would additionally require fsyncing the file and its directory, which is
 * deliberately not paid per record.
 *
 * ## Pod helpers
 *
 * {@link savePod} and {@link loadPod} are thin wrappers around the hub
 * `writePod` / `readPod` primitives that pipe bytes to/from `node:fs`.
 *
 * @packageDocumentation
 */

import { readFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWrite } from './atomic-write.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  StoreDescriptor,
  StoreFactory,
  StoreLocator,
} from '@noy-db/hub/to'
import { ConflictError } from '@noy-db/hub/to'
import type {
  Vault,
  WritePodOptions,
  PodReadResult,
} from '@noy-db/hub'
import { writePod, readPod } from '@noy-db/hub'

/**
 * Options for `toFile()`.
 *
 * Files are laid out as `{dir}/{vault}/{collection}/{id}.json`.
 * Internal collections (`_keyring`, `_sync`) follow the same pattern
 * under their vault directory.
 */
export interface JsonFileOptions {
  /** Base directory for NOYDB data. */
  dir: string
  /** Pretty-print JSON files. Default: true. */
  pretty?: boolean
  /** Clock uncertainty bound (ms). Default: 0. */
  clockUncertaintyMs?: number
}

/**
 * Create a JSON file adapter.
 * Maps the NOYDB hierarchy to the filesystem:
 *
 * ```
 * {dir}/{vault}/{collection}/{id}.json
 * {dir}/{vault}/_keyring/{userId}.json
 * ```
 */
export function toFile(options: JsonFileOptions): NoydbStore {
  const { dir, pretty = true } = options

  function recordPath(vault: string, collection: string, id: string): string {
    return join(dir, vault, collection, `${id}.json`)
  }

  function collectionDir(vault: string, collection: string): string {
    return join(dir, vault, collection)
  }

  async function ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }

  async function fileExists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  function serialize(envelope: EncryptedEnvelope): string {
    return pretty ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope)
  }

  return {
    name: 'file',
    capabilities: {
      casAtomic: false,
      serverWriteTime: true,
      auth: { kind: 'filesystem', required: false, flow: 'static' },
    },

    async getStoreTime() {
      const now = Date.now()
      const ε = options.clockUncertaintyMs ?? 0
      return { earliest: now - ε, latest: now + ε }
    },

    async get(vault, collection, id) {
      const path = recordPath(vault, collection, id)
      try {
        const content = await readFile(path, 'utf-8')
        return JSON.parse(content) as EncryptedEnvelope
      } catch {
        return null
      }
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const path = recordPath(vault, collection, id)

      if (expectedVersion !== undefined && await fileExists(path)) {
        const existing = JSON.parse(await readFile(path, 'utf-8')) as EncryptedEnvelope
        if (existing._v !== expectedVersion) {
          throw new ConflictError(existing._v, `Version conflict: expected ${expectedVersion}, found ${existing._v}`)
        }
      }

      await ensureDir(collectionDir(vault, collection))
      await atomicWrite(path, serialize(envelope))
    },

    async delete(vault, collection, id) {
      const path = recordPath(vault, collection, id)
      try {
        await unlink(path)
      } catch {
        // File doesn't exist — that's fine
      }
    },

    async list(vault, collection) {
      const dirPath = collectionDir(vault, collection)
      try {
        const entries = await readdir(dirPath)
        return entries
          .filter(f => f.endsWith('.json'))
          .map(f => f.slice(0, -5)) // remove .json extension
      } catch {
        return []
      }
    },

    async loadAll(vault) {
      const compDir = join(dir, vault)
      const snapshot: VaultSnapshot = {}

      try {
        const collections = await readdir(compDir)
        for (const collName of collections) {
          if (collName.startsWith('_')) continue // skip _keyring, _sync
          const collPath = join(compDir, collName)
          const collStat = await stat(collPath)
          if (!collStat.isDirectory()) continue

          const records: Record<string, EncryptedEnvelope> = {}
          const files = await readdir(collPath)
          for (const file of files) {
            if (!file.endsWith('.json')) continue
            const id = file.slice(0, -5)
            const content = await readFile(join(collPath, file), 'utf-8')
            records[id] = JSON.parse(content) as EncryptedEnvelope
          }
          snapshot[collName] = records
        }
      } catch {
        // Directory doesn't exist — return empty snapshot
      }

      return snapshot
    },

    async saveAll(vault, data) {
      for (const [collName, records] of Object.entries(data)) {
        const collDir = collectionDir(vault, collName)
        await ensureDir(collDir)
        for (const [id, envelope] of Object.entries(records)) {
          await atomicWrite(join(collDir, `${id}.json`), serialize(envelope))
        }
      }
    },

    async ping() {
      try {
        await stat(dir)
        return true
      } catch {
        return false
      }
    },

    /**
     * Enumerate every top-level vault subdirectory under the
     * configured base directory. Used by
     * `Noydb.listAccessibleVaults()`.
     *
     * The implementation is `readdir(dir)` filtered to entries that
     * are themselves directories — files at the top level (READMEs,
     * .DS_Store, etc.) are skipped, and missing base directory
     * returns an empty array rather than throwing. Result order is
     * filesystem-defined; consumers that want stable order should
     * sort themselves.
     */
    async listVaults() {
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        return []
      }
      const compartments: string[] = []
      for (const entry of entries) {
        try {
          const entryStat = await stat(join(dir, entry))
          if (entryStat.isDirectory()) compartments.push(entry)
        } catch {
          // Entry vanished between readdir and stat — skip silently.
        }
      }
      return compartments
    },

    /**
     * Paginate over a collection. Cursor is a numeric offset (as a string)
     * into the sorted filename list. Files are sorted alphabetically so
     * pages are stable across runs and across processes that share the
     * same data directory.
     *
     * The default `limit` is 100. Each item carries its decoded envelope
     * so callers don't need an extra `get()` round-trip per id.
     */
    async listPage(vault, collection, cursor, limit = 100) {
      const dirPath = collectionDir(vault, collection)
      let files: string[]
      try {
        files = await readdir(dirPath)
      } catch {
        return { items: [], nextCursor: null }
      }

      const ids = files
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
        .sort()

      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)

      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (let i = start; i < end; i++) {
        const id = ids[i]!
        try {
          const content = await readFile(join(dirPath, `${id}.json`), 'utf-8')
          items.push({ id, envelope: JSON.parse(content) as EncryptedEnvelope })
        } catch {
          // File disappeared between readdir and readFile — skip silently.
        }
      }

      return {
        items,
        nextCursor: end < ids.length ? String(end) : null,
      }
    },
  }
}

// ─── Store-locator descriptor (#945 — `local`-class reference impl) ──

/**
 * Builds the `StoreDescriptor` form of a `toFile()` store: `kind: 'file'`,
 * `class: 'local'`, and a serializable `address` carrying the base
 * directory (same value `JsonFileOptions.dir` would take directly).
 *
 * Credentialless — `to-file` never needs a `StoreCredentialSource`.
 */
export function fileStoreDescriptor(dir: string): StoreDescriptor {
  return { kind: 'file', class: 'local', address: { dir } }
}

/**
 * `StoreFactory` for `to-file`: reconstructs the same store `toFile()`
 * builds, from a `StoreDescriptor` (as produced by {@link fileStoreDescriptor}).
 *
 * `to-file` is a credentialless local store, so `opts.credentials` is
 * unused. `opts.binding` may carry a device-local directory override — a
 * bare string or `{ dir }` — applied in place of `descriptor.address.dir`
 * when present (e.g. a different mount point on this device than what the
 * descriptor was authored with).
 */
export const fileStoreFactory: StoreFactory = (descriptor, opts) => {
  const address = descriptor.address as { dir: string }
  const binding = opts.binding as { dir?: string } | string | undefined

  let dir: string
  if (typeof binding === 'string') {
    dir = binding
  } else if (binding && binding.dir !== undefined) {
    dir = binding.dir
  } else {
    dir = address.dir
  }

  return toFile({ dir })
}

/** Registers {@link fileStoreFactory} under the `'file'` kind on `locator`. */
export function registerFileStore(locator: StoreLocator): void {
  locator.register('file', fileStoreFactory)
}

// ─── .noydb pod helpers ────────────────────────────────────

/**
 * Write a `.noydb` container for a vault to a local file.
 *
 * Thin wrapper around `writePod` from `@noy-db/hub` — the hub
 * primitive returns a `Uint8Array`, this helper just pipes it to
 * disk after ensuring the parent directory exists. Use the same
 * options as the hub primitive.
 *
 * **Path convention** is up to the caller — `.noydb` is the
 * recommended extension. Consumers using cloud-sync folders
 * should name files by the bundle handle (available via
 * `vault.getPodHandle()`) rather than the vault
 * name to avoid leaking metadata at the filesystem layer:
 *
 * ```ts
 * const handle = await company.getPodHandle()
 * await savePod(`./pods/${handle}.noydb`, company)
 * ```
 *
 * The container is staged in a `.tmp` sidecar and renamed into
 * place (#1040), so a reader — or a cloud-sync daemon watching the
 * folder — never observes a partially-written pod under its final
 * name. A pod is past `PIPE_BUF` essentially always, so the
 * previous bare `writeFile` genuinely did race with concurrent
 * readers despite the docstring that claimed otherwise.
 */
export async function savePod(
  path: string,
  vault: Vault,
  opts: WritePodOptions = {},
): Promise<void> {
  const bytes = await writePod(vault, opts)
  // Ensure the parent directory exists — the write does NOT
  // create intermediate directories on its own. Recursive mkdir
  // is a no-op when the directory already exists.
  await mkdir(dirname(path), { recursive: true })
  await atomicWrite(path, bytes)
}

/**
 * Read and verify a `.noydb` container from a local file.
 *
 * Returns the parsed header plus the unwrapped `dump()` JSON
 * string ready to feed to `vault.load(json, secret)`.
 * Throws `PodIntegrityError` from `@noy-db/hub` if the body
 * bytes don't match the integrity hash declared in the header
 * (the pod was modified between write and read), or any
 * format error from the hub reader if the bytes aren't a valid
 * pod at all.
 *
 * Does NOT take a secret — the pod reader is purely a
 * format layer. Restoring a vault from the returned dump
 * JSON requires a separate `vault.load()` call with the
 * secret, mirroring the split between
 * `readPod()` and `vault.load()` in hub.
 */
export async function loadPod(path: string): Promise<PodReadResult> {
  const bytes = await readFile(path)
  // node:fs.readFile returns a Buffer, which is a Uint8Array
  // subclass — `readPod` accepts Uint8Array directly,
  // no copy needed.
  return readPod(bytes)
}


// Export-blobs FS materializer — wraps `vault.exportBlobs()` with
// target-profile filename sanitization, Zip-Slip path containment, and
// collision policy. Lives in `to-file` (not core) because hub stays
// portable across browser/Node and shouldn't import `node:fs`.
export {
  exportBlobsToDirectory,
} from './export-blobs-to-directory.js'
export type {
  ExportBlobsToDirectoryOptions,
  ExportBlobsToDirectoryResult,
  CollisionStrategy,
} from './export-blobs-to-directory.js'
