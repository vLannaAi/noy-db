import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '@noy-db/core'
import { ConflictError } from '@noy-db/core'

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
  }
}
