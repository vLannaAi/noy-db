import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNoydb, withGuard, RecordLockedError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/types.js'

// Minimal file-backed store — same shape as @noy-db/to-file's `jsonFile()`.
// Inlined here because hub tests don't depend on sibling @noy-db/to-* packages.
// Layout: {dir}/{vault}/{collection}/{id}.json
function fileStore(dir: string): NoydbStore {
  const recPath = (v: string, c: string, i: string) => join(dir, v, c, `${i}.json`)
  const colDir = (v: string, c: string) => join(dir, v, c)
  return {
    capabilities: { casAtomic: false, auth: { kind: 'none' } },
    async get(v, c, i) {
      try {
        return JSON.parse(await readFile(recPath(v, c, i), 'utf-8')) as EncryptedEnvelope
      } catch {
        return null
      }
    },
    async put(v, c, i, env) {
      await mkdir(colDir(v, c), { recursive: true })
      await writeFile(recPath(v, c, i), JSON.stringify(env), 'utf-8')
    },
    async delete(v, c, i) {
      try { await unlink(recPath(v, c, i)) } catch { /* not found is fine */ }
    },
    async list(v, c) {
      try {
        const files = await readdir(colDir(v, c))
        return files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))
      } catch {
        return []
      }
    },
    async loadAll(v) {
      const out: VaultSnapshot = {}
      const vDir = join(dir, v)
      let collections: string[]
      try { collections = await readdir(vDir) } catch { return out }
      for (const c of collections) {
        const cPath = join(vDir, c)
        try {
          const st = await stat(cPath)
          if (!st.isDirectory()) continue
        } catch { continue }
        const records: Record<string, EncryptedEnvelope> = {}
        const files = await readdir(cPath)
        for (const f of files) {
          if (!f.endsWith('.json')) continue
          const id = f.slice(0, -5)
          records[id] = JSON.parse(await readFile(join(cPath, f), 'utf-8')) as EncryptedEnvelope
        }
        out[c] = records
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        await mkdir(colDir(v, c), { recursive: true })
        for (const i of Object.keys(payload[c])) {
          await writeFile(recPath(v, c, i), JSON.stringify(payload[c][i]), 'utf-8')
        }
      }
    },
  }
}

describe('Guards work over a persistent file-backed store', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noydb-guards-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('locks survive a vault close + re-open from persistent storage', async () => {
    const guard = withGuard<{ id: string; locked: boolean }>({
      collection: 'widgets',
      check: async (incoming, { existing }) => {
        if (existing?.locked) {
          throw new RecordLockedError('widgets', incoming.id, 'record is locked')
        }
      },
    })
    const open = () => createNoydb({
      store: fileStore(dir),
      user: 'alice',
      secret: 'guards-cross-store-passphrase-2026',
      guardStrategies: [guard],
    })

    // First instance: write a locked record.
    const db1 = await open()
    const v1 = await db1.openVault('demo')
    await v1.collection('widgets').put('w1', { id: 'w1', locked: true })

    // Second instance over the same on-disk state — the guard must still fire,
    // proving the lock survives a vault re-open (state lives in persisted records,
    // not in-memory guard state).
    const db2 = await open()
    const v2 = await db2.openVault('demo')
    await expect(
      v2.collection('widgets').put('w1', { id: 'w1', locked: false }),
    ).rejects.toBeInstanceOf(RecordLockedError)
  })
})
