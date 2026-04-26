import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, ExportCapabilityError, createNoydb } from '@noy-db/hub'
import { toBytes, peek, write } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string): Map<string, EncryptedEnvelope> => {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

async function seed(opts: { role?: 'owner' | 'operator'; bundle?: boolean } = {}) {
  const role = opts.role ?? 'owner'
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'u1', secret: 'pw' })
  const v1 = await db.openVault('acme')
  await v1.collection<{ id: string; amount: number }>('invoices').put('i1', { id: 'i1', amount: 100 })

  if (opts.bundle !== undefined) {
    await db.grant('acme', {
      userId: 'u1', displayName: 'User', role,
      passphrase: 'pw',
      exportCapability: { bundle: opts.bundle },
    })
    await db.close()
    const db2 = await createNoydb({ store: adapter, user: 'u1', secret: 'pw' })
    const vault = await db2.openVault('acme')
    return { db: db2, vault }
  }
  return { db, vault: v1 }
}

describe('as-noydb', () => {
  it('toBytes produces a valid bundle starting with the NDB1 magic', async () => {
    const { vault } = await seed({ bundle: true })
    const bytes = await toBytes(vault)
    expect(bytes).toBeInstanceOf(Uint8Array)
    // NDB1 magic header (0x4E 0x44 0x42 0x31).
    expect(bytes[0]).toBe(0x4E)
    expect(bytes[1]).toBe(0x44)
    expect(bytes[2]).toBe(0x42)
    expect(bytes[3]).toBe(0x31)
  })

  it('peek() returns the header without decrypting the body', async () => {
    const { vault } = await seed({ bundle: true })
    const bytes = await toBytes(vault)
    const header = peek(bytes)
    expect(header.formatVersion).toBeDefined()
    expect(header.handle).toBeTruthy()
    expect(header.bodyBytes).toBeGreaterThan(0)
    expect(header.bodySha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('owner defaults to bundle-allowed even without explicit grant', async () => {
    const { vault } = await seed() // no explicit exportCapability → role defaults apply
    // Owner's default includes bundle: true — should succeed.
    await expect(toBytes(vault)).resolves.toBeInstanceOf(Uint8Array)
  })

  it('throws ExportCapabilityError when bundle is explicitly denied', async () => {
    const { vault } = await seed({ role: 'operator', bundle: false })
    await expect(toBytes(vault)).rejects.toBeInstanceOf(ExportCapabilityError)
  })

  it('write() persists the bundle bytes to disk (no acknowledgeRisks needed)', async () => {
    const { vault } = await seed({ bundle: true })
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const { readFile } = await import('node:fs/promises')
    const dir = await mkdtemp(path.join(tmpdir(), 'as-noydb-'))
    const file = path.join(dir, 'out.noydb')
    await write(vault, file)
    const bytes = await readFile(file)
    expect(bytes[0]).toBe(0x4E) // NDB1 magic
  })
})
