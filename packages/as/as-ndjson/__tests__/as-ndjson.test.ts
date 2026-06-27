import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, ExportCapabilityError, createNoydb } from '@noy-db/hub'
import { toString, stream, pipe } from '../src/index.js'

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

async function seed(grantFormats: readonly ('json' | 'ndjson' | 'csv')[] = ['ndjson']) {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner', secret: 'pw' })
  const v1 = await db.openVault('acme')
  await v1.collection<{ id: string; amount: number }>('invoices').put('i1', { id: 'i1', amount: 100 })
  await v1.collection<{ id: string; amount: number }>('invoices').put('i2', { id: 'i2', amount: 250 })
  await v1.collection<{ id: string; invoiceId: string }>('payments').put('p1', { id: 'p1', invoiceId: 'i1' })
  await db.grant('acme', {
    userId: 'owner', displayName: 'Owner', role: 'owner',
    passphrase: 'pw',
    exportCapability: { plaintext: grantFormats },
  })
  await db.close()
  const db2 = await createNoydb({ store: adapter, user: 'owner', secret: 'pw' })
  const vault = await db2.openVault('acme')
  return { db: db2, vault }
}

describe('as-ndjson', () => {
  it('emits one JSON object per line with _schema field', async () => {
    const { vault } = await seed()
    const out = await toString(vault)
    const lines = out.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>
      expect(obj._schema).toMatch(/^(invoices|payments)$/)
    }
  })

  it('custom schemaField name is honoured', async () => {
    const { vault } = await seed()
    const out = await toString(vault, { schemaField: '_kind' })
    const first = JSON.parse(out.split('\n')[0]!) as Record<string, unknown>
    expect(first._kind).toBeDefined()
    expect(first._schema).toBeUndefined()
  })

  it('stream() yields individual lines', async () => {
    const { vault } = await seed()
    const chunks: string[] = []
    for await (const line of stream(vault)) chunks.push(line)
    expect(chunks).toHaveLength(3)
  })

  it('collections allowlist filters output', async () => {
    const { vault } = await seed()
    const out = await toString(vault, { collections: ['payments'] })
    const lines = out.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)._schema).toBe('payments')
  })

  it('throws ExportCapabilityError without ndjson grant', async () => {
    const { vault } = await seed(['csv'])
    await expect(toString(vault)).rejects.toBeInstanceOf(ExportCapabilityError)
  })

  it('pipe() refuses without acknowledgeRisks', async () => {
    const { vault } = await seed()
    const sink = { write(): void {}, end(): void {} }
    await expect(
      pipe(vault, sink, { acknowledgeRisks: false as unknown as true }),
    ).rejects.toThrow(/acknowledgeRisks/)
  })

  it('pipe() streams each line through the sink', async () => {
    const { vault } = await seed()
    const written: string[] = []
    let ended = false
    const sink = {
      write(chunk: string): void { written.push(chunk) },
      end(): void { ended = true },
    }
    await pipe(vault, sink, { acknowledgeRisks: true })
    expect(written).toHaveLength(3)
    expect(written.every(line => line.endsWith('\n'))).toBe(true)
    expect(ended).toBe(true)
  })
})
