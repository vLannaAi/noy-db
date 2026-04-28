import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/tx'
import { fromString } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const comp = store.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; client: string; amount: number }

async function setup() {
  const adapter = memory()
  const init = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
  await init.openVault('demo')
  await init.grant('demo', {
    userId: 'alice', displayName: 'Alice', role: 'owner',
    passphrase: 'pw-2026',
    importCapability: { plaintext: ['csv'] },
  })
  init.close()
  const db = await createNoydb({
    store: adapter, user: 'alice', secret: 'pw-2026',
    txStrategy: withTransactions(),
  })
  const vault = await db.openVault('demo')
  await vault.collection<Invoice>('invoices').put('a', { id: 'a', client: 'X', amount: 100 })
  return { db, vault }
}

describe('as-csv fromString', () => {
  it('parses a basic CSV and applies under merge policy', async () => {
    const { db, vault } = await setup()
    const csv = [
      'id,client,amount',
      'a,X,100',                    // unchanged
      'b,"Acme, Inc.",250',         // added (note quoted comma)
    ].join('\n')

    const importer = await fromString(vault, csv, {
      collection: 'invoices',
      columnTypes: { amount: 'number' },
    })
    expect(importer.plan.summary).toEqual({ add: 1, modify: 0, delete: 0, total: 1 })
    expect(importer.plan.added[0]!.record).toEqual({
      id: 'b', client: 'Acme, Inc.', amount: 250,
    })

    await importer.apply()
    expect(await vault.collection<Invoice>('invoices').get('b')).toEqual({
      id: 'b', client: 'Acme, Inc.', amount: 250,
    })
    db.close()
  })

  it('handles embedded double quotes via doubling', async () => {
    const { db, vault } = await setup()
    const csv = [
      'id,client,amount',
      'b,"Stark ""Industries""",999',
    ].join('\n')

    const importer = await fromString(vault, csv, {
      collection: 'invoices',
      columnTypes: { amount: 'number' },
    })
    expect(importer.plan.added[0]!.record).toEqual({
      id: 'b', client: 'Stark "Industries"', amount: 999,
    })
    db.close()
  })

  it('round-trips against as-csv.toString() for the same vault', async () => {
    // toString → fromString → apply on a fresh vault should produce
    // the same records as the source.
    const { default: as } = await import('../src/index.js') as any
    void as

    const { db: src, vault: srcVault } = await setup()
    await src.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: 'pw-2026',
      exportCapability: { plaintext: ['csv'] },
    })
    src.close()

    const re = await createNoydb({ store: (srcVault as any).adapter, user: 'alice', secret: 'pw-2026' })
    const reVault = await re.openVault('demo')
    const { toString } = await import('../src/index.js')
    const csv = await toString(reVault, { collection: 'invoices' })

    // Empty fresh vault — every CSV row is "added".
    const dstAdapter = memory()
    const dstInit = await createNoydb({ store: dstAdapter, user: 'alice', secret: 'pw-2026' })
    await dstInit.openVault('demo')
    await dstInit.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: 'pw-2026',
      importCapability: { plaintext: ['csv'] },
    })
    dstInit.close()
    const dst = await createNoydb({
      store: dstAdapter, user: 'alice', secret: 'pw-2026',
      txStrategy: withTransactions(),
    })
    const dstVault = await dst.openVault('demo')
    const importer = await fromString(dstVault, csv, {
      collection: 'invoices',
      columnTypes: { amount: 'number' },
    })
    await importer.apply()
    expect(await dstVault.collection<Invoice>('invoices').get('a'))
      .toEqual({ id: 'a', client: 'X', amount: 100 })

    re.close()
    dst.close()
  })
})

describe('as-csv fromString — apply() requires withTransactions() (#309)', () => {
  it('throws a clear error when the tx strategy is missing', async () => {
    // setup() above grants importCapability; here we recreate the vault
    // explicitly WITHOUT withTransactions() so apply() hits the strategy
    // gate before any record write reaches the store.
    const adapter = memory()
    const init = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
    await init.openVault('demo')
    await init.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: 'pw-2026',
      importCapability: { plaintext: ['csv'] },
    })
    init.close()

    const db = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
    const vault = await db.openVault('demo')

    const importer = await fromString(vault, 'id,client,amount\na,X,100', {
      collection: 'invoices',
      columnTypes: { amount: 'number' },
    })
    // The plan builds fine — diffVault doesn't need transactions. Only
    // apply() crosses the gate.
    expect(importer.plan.summary.total).toBe(1)
    await expect(importer.apply()).rejects.toThrow(/withTransactions/)

    // Vault state untouched — no record persisted because the gate
    // throws before the runTransaction body executes.
    expect(await vault.collection<Invoice>('invoices').get('a')).toBeNull()
    db.close()
  })
})
