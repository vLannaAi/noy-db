import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, ExportCapabilityError, createNoydb } from '@noy-db/hub'
import { toString } from '../src/index.js'

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
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
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

interface Invoice { id: string; amount: number; client: string; paid: boolean }

async function seed(grant: readonly ('sql' | 'csv')[] = ['sql']) {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner', secret: 'pw' })
  const v = await db.openVault('acme')
  await v.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100, client: "O'Malley", paid: true })
  await v.collection<Invoice>('invoices').put('i2', { id: 'i2', amount: 250, client: 'Acme', paid: false })
  await db.grant('acme', {
    userId: 'owner', displayName: 'Owner', role: 'owner',
    passphrase: 'pw',
    exportCapability: { plaintext: grant },
  })
  await db.close()
  const db2 = await createNoydb({ store: adapter, user: 'owner', secret: 'pw' })
  const vault = await db2.openVault('acme')
  return { vault }
}

describe('as-sql', () => {
  it('emits CREATE TABLE + INSERT INTO for postgres by default', async () => {
    const { vault } = await seed()
    const sql = await toString(vault)
    expect(sql).toContain('CREATE TABLE "invoices"')
    expect(sql).toContain('INSERT INTO "invoices"')
  })

  it('infers column types — integer, text, boolean', async () => {
    const { vault } = await seed()
    const sql = await toString(vault)
    expect(sql).toMatch(/"amount" INTEGER/)
    expect(sql).toMatch(/"client" TEXT/)
    expect(sql).toMatch(/"paid" BOOLEAN/)
  })

  it('escapes single quotes in string literals', async () => {
    const { vault } = await seed()
    const sql = await toString(vault)
    expect(sql).toContain("'O''Malley'")
  })

  it('mysql dialect uses backtick identifiers + TINYINT(1) for booleans', async () => {
    const { vault } = await seed()
    const sql = await toString(vault, { dialect: 'mysql' })
    expect(sql).toContain('CREATE TABLE `invoices`')
    expect(sql).toMatch(/`paid` TINYINT\(1\)/)
    // Booleans serialize as 1/0 in mysql.
    expect(sql).toMatch(/VALUES \([^)]*, 1\)/)
  })

  it('sqlite dialect maps booleans to INTEGER', async () => {
    const { vault } = await seed()
    const sql = await toString(vault, { dialect: 'sqlite' })
    expect(sql).toMatch(/"paid" INTEGER/)
  })

  it('schema-only mode emits CREATE TABLE but no INSERT', async () => {
    const { vault } = await seed()
    const sql = await toString(vault, { mode: 'schema-only' })
    expect(sql).toContain('CREATE TABLE')
    expect(sql).not.toContain('INSERT')
  })

  it('data-only mode emits INSERT but no CREATE TABLE', async () => {
    const { vault } = await seed()
    const sql = await toString(vault, { mode: 'data-only' })
    expect(sql).not.toContain('CREATE TABLE')
    expect(sql).toContain('INSERT')
  })

  it('tableNames mapper renames the output table', async () => {
    const { vault } = await seed()
    const sql = await toString(vault, { tableNames: c => `ndb_${c}` })
    expect(sql).toContain('"ndb_invoices"')
  })

  it('throws ExportCapabilityError without sql grant', async () => {
    const { vault } = await seed(['csv'])
    await expect(toString(vault)).rejects.toBeInstanceOf(ExportCapabilityError)
  })
})
