import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  NoydbAdapter,
  EncryptedEnvelope,
  CompartmentSnapshot,
  Compartment,
  WriteNoydbBundleOptions,
  NoydbBundleReadResult,
} from '@noy-db/core'
import {
  ConflictError,
  writeNoydbBundle,
  readNoydbBundle,
} from '@noy-db/core'

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
 * {dir}/{compartment}/{collection}/{id}.json
 * {dir}/{compartment}/_keyring/{userId}.json
 * ```
 */
export function jsonFile(options: JsonFileOptions): NoydbAdapter {
  const { dir, pretty = true } = options

  function recordPath(compartment: string, collection: string, id: string): string {
    return join(dir, compartment, collection, `${id}.json`)
  }

  function collectionDir(compartment: string, collection: string): string {
    return join(dir, compartment, collection)
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

    async get(compartment, collection, id) {
      const path = recordPath(compartment, collection, id)
      try {
        const content = await readFile(path, 'utf-8')
        return JSON.parse(content) as EncryptedEnvelope
      } catch {
        return null
      }
    },

    async put(compartment, collection, id, envelope, expectedVersion) {
      const path = recordPath(compartment, collection, id)

      if (expectedVersion !== undefined && await fileExists(path)) {
        const existing = JSON.parse(await readFile(path, 'utf-8')) as EncryptedEnvelope
        if (existing._v !== expectedVersion) {
          throw new ConflictError(existing._v, `Version conflict: expected ${expectedVersion}, found ${existing._v}`)
        }
      }

      await ensureDir(collectionDir(compartment, collection))
      await writeFile(path, serialize(envelope), 'utf-8')
    },

    async delete(compartment, collection, id) {
      const path = recordPath(compartment, collection, id)
      try {
        await unlink(path)
      } catch {
        // File doesn't exist — that's fine
      }
    },

    async list(compartment, collection) {
      const dirPath = collectionDir(compartment, collection)
      try {
        const entries = await readdir(dirPath)
        return entries
          .filter(f => f.endsWith('.json'))
          .map(f => f.slice(0, -5)) // remove .json extension
      } catch {
        return []
      }
    },

    async loadAll(compartment) {
      const compDir = join(dir, compartment)
      const snapshot: CompartmentSnapshot = {}

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

    async saveAll(compartment, data) {
      for (const [collName, records] of Object.entries(data)) {
        const collDir = collectionDir(compartment, collName)
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
     * Enumerate every top-level compartment subdirectory under the
     * configured base directory. Used by
     * `Noydb.listAccessibleCompartments()` (v0.5 #63).
     *
     * The implementation is `readdir(dir)` filtered to entries that
     * are themselves directories — files at the top level (READMEs,
     * .DS_Store, etc.) are skipped, and missing base directory
     * returns an empty array rather than throwing. Result order is
     * filesystem-defined; consumers that want stable order should
     * sort themselves.
     */
    async listCompartments() {
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
    async listPage(compartment, collection, cursor, limit = 100) {
      const dirPath = collectionDir(compartment, collection)
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
 * Write a `.noydb` container for a compartment to a local file.
 *
 * Thin wrapper around `writeNoydbBundle` from `@noy-db/core` —
 * the core primitive returns a `Uint8Array`, this helper just
 * pipes it to `node:fs.writeFile` after ensuring the parent
 * directory exists. Use the same options as the core primitive.
 *
 * **Path convention** is up to the caller — `.noydb` is the
 * recommended extension. Consumers using cloud-sync folders
 * should name files by the bundle handle (available via
 * `compartment.getBundleHandle()`) rather than the compartment
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
  compartment: Compartment,
  opts: WriteNoydbBundleOptions = {},
): Promise<void> {
  const bytes = await writeNoydbBundle(compartment, opts)
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
 * string ready to feed to `compartment.load(json, passphrase)`.
 * Throws `BundleIntegrityError` from `@noy-db/core` if the body
 * bytes don't match the integrity hash declared in the header
 * (the bundle was modified between write and read), or any
 * format error from the core reader if the bytes aren't a valid
 * bundle at all.
 *
 * Does NOT take a passphrase — the bundle reader is purely a
 * format layer. Restoring a compartment from the returned dump
 * JSON requires a separate `compartment.load()` call with the
 * passphrase, mirroring the split between
 * `readNoydbBundle()` and `compartment.load()` in core.
 */
export async function loadBundle(path: string): Promise<NoydbBundleReadResult> {
  const bytes = await readFile(path)
  // node:fs.readFile returns a Buffer, which is a Uint8Array
  // subclass — `readNoydbBundle` accepts Uint8Array directly,
  // no copy needed.
  return readNoydbBundle(bytes)
}
