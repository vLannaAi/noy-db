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
 * | `listVaults` | ✓ — enumerates subdirectories |
 * | `listPage` | ✓ — cursor-based pagination over sorted filenames |
 * | `ping` | ✓ — `stat(dir)` |
 *
 * ## Bundle helpers
 *
 * {@link saveBundle} and {@link loadBundle} are thin wrappers around the
 * core `writeNoydbBundle` / `readNoydbBundle` primitives that pipe bytes
 * to/from `node:fs`.
 *
 * @packageDocumentation
 */

import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  Vault,
  WriteNoydbBundleOptions,
  NoydbBundleReadResult,
} from '@noy-db/hub'
import {
  ConflictError,
  writeNoydbBundle,
  readNoydbBundle,
} from '@noy-db/hub'

/**
 * Options for `jsonFile()`.
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
export function jsonFile(options: JsonFileOptions): NoydbStore {
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
      await writeFile(path, serialize(envelope), 'utf-8')
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
          await writeFile(join(collDir, `${id}.json`), serialize(envelope), 'utf-8')
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
     * `Noydb.listAccessibleVaults()` (v0.5 #63).
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

// ─── .noydb bundle helpers (v0.6 #100) ─────────────────────────────────

/**
 * Write a `.noydb` container for a vault to a local file.
 *
 * Thin wrapper around `writeNoydbBundle` from `@noy-db/core` —
 * the core primitive returns a `Uint8Array`, this helper just
 * pipes it to `node:fs.writeFile` after ensuring the parent
 * directory exists. Use the same options as the core primitive.
 *
 * **Path convention** is up to the caller — `.noydb` is the
 * recommended extension. Consumers using cloud-sync folders
 * should name files by the bundle handle (available via
 * `vault.getBundleHandle()`) rather than the vault
 * name to avoid leaking metadata at the filesystem layer:
 *
 * ```ts
 * const handle = await company.getBundleHandle()
 * await saveBundle(`./bundles/${handle}.noydb`, company)
 * ```
 *
 * The full container is written atomically by `node:fs.writeFile`
 * (the platform's atomic-write semantics apply — POSIX `write()`
 * is atomic up to PIPE_BUF, larger files race with concurrent
 * readers; consumers writing into shared cloud folders should
 * pair this with their cloud sync's conflict resolution).
 */
export async function saveBundle(
  path: string,
  vault: Vault,
  opts: WriteNoydbBundleOptions = {},
): Promise<void> {
  const bytes = await writeNoydbBundle(vault, opts)
  // Ensure the parent directory exists — `writeFile` does NOT
  // create intermediate directories on its own. Recursive mkdir
  // is a no-op when the directory already exists.
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

/**
 * Read and verify a `.noydb` container from a local file.
 *
 * Returns the parsed header plus the unwrapped `dump()` JSON
 * string ready to feed to `vault.load(json, passphrase)`.
 * Throws `BundleIntegrityError` from `@noy-db/core` if the body
 * bytes don't match the integrity hash declared in the header
 * (the bundle was modified between write and read), or any
 * format error from the core reader if the bytes aren't a valid
 * bundle at all.
 *
 * Does NOT take a passphrase — the bundle reader is purely a
 * format layer. Restoring a vault from the returned dump
 * JSON requires a separate `vault.load()` call with the
 * passphrase, mirroring the split between
 * `readNoydbBundle()` and `vault.load()` in core.
 */
export async function loadBundle(path: string): Promise<NoydbBundleReadResult> {
  const bytes = await readFile(path)
  // node:fs.readFile returns a Buffer, which is a Uint8Array
  // subclass — `readNoydbBundle` accepts Uint8Array directly,
  // no copy needed.
  return readNoydbBundle(bytes)
}

// Export-blobs FS materializer (#292) — wraps `vault.exportBlobs()` with
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
