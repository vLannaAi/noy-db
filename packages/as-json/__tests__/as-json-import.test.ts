/**
 * Import-side coverage for @noy-db/as-json.
 *
 * fromString / fromObject parse a JSON document, build a VaultDiff
 * preview via the hub's diffVault helper, and expose an apply()
 * method that writes the changes through the normal collection API.
 */

import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { withFormats } from '@noy-db/hub/as'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/transactions'
import { withHistory } from '@noy-db/hub/history'
import { asJson } from '../src/index.js'
import { withTeam } from '@noy-db/hub/team'

function toMemory(): NoydbStore {
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

interface Invoice { id: string; amount: number; status: string }

async function setup() {
  const adapter = toMemory()
  const init = await createNoydb({ formatsStrategy: withFormats(), teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-2026' })
  await init.openVault('demo')
  await init.grant('demo', {
    userId: 'alice', displayName: 'Alice', role: 'owner',
    secret: 'pw-2026',
    importCapability: { plaintext: ['json'] },
  })
  init.close()
  const db = await createNoydb({ formatsStrategy: withFormats(), teamStrategy: withTeam(),
    store: adapter, user: 'alice', secret: 'pw-2026',
    transactionsStrategy: withTransactions(),
  })
  const vault = await db.openVault('demo')
  const inv = vault.collection<Invoice>('invoices')
  await inv.put('a', { id: 'a', amount: 100, status: 'draft' })
  await inv.put('b', { id: 'b', amount: 200, status: 'paid' })
  return { db, vault }
}

describe('as-json fromString — preview', () => {
  it('produces a plan with added / modified / deleted buckets', async () => {
    const { db, vault } = await setup()
    const json = JSON.stringify({
      invoices: [
        { id: 'a', amount: 100, status: 'draft' },                // unchanged
        { id: 'b', amount: 200, status: 'paid (modified)' },      // modified
        { id: 'c', amount: 300, status: 'paid' },                 // added
        // 'b' would be 'deleted' if not present — but it is, so just modified.
      ],
    })

    const { plan } = await vault.import(asJson(), json, {})
    expect(plan.summary).toEqual({ add: 1, modify: 1, delete: 0, total: 2 })
    expect(plan.added.map((e) => e.id)).toEqual(['c'])
    expect(plan.modified.map((e) => e.id)).toEqual(['b'])
    db.close()
  })
})

describe('as-json fromString — apply with merge policy (default)', () => {
  it('inserts added + updates modified, never deletes', async () => {
    const { db, vault } = await setup()
    const json = JSON.stringify({
      invoices: [
        { id: 'b', amount: 200, status: 'paid (updated)' },
        { id: 'c', amount: 300, status: 'paid' },
      ],
    })

    const importer = await vault.import(asJson(), json, {})
    await importer.apply()

    const inv = vault.collection<Invoice>('invoices')
    expect(await inv.get('a')).toEqual({ id: 'a', amount: 100, status: 'draft' })   // untouched
    expect(await inv.get('b')).toEqual({ id: 'b', amount: 200, status: 'paid (updated)' })
    expect(await inv.get('c')).toEqual({ id: 'c', amount: 300, status: 'paid' })
    db.close()
  })
})

describe('as-json fromString — apply with replace policy', () => {
  it('mirrors candidate exactly, deleting records absent from the file', async () => {
    const { db, vault } = await setup()
    const json = JSON.stringify({
      invoices: [
        { id: 'a', amount: 100, status: 'draft' },
        { id: 'c', amount: 300, status: 'paid' },
        // 'b' missing — should be deleted under 'replace'
      ],
    })

    const importer = await vault.import(asJson(), json, { policy: 'replace' })
    await importer.apply()

    const inv = vault.collection<Invoice>('invoices')
    expect(await inv.get('a')).toBeDefined()
    expect(await inv.get('b')).toBeNull()    // deleted
    expect(await inv.get('c')).toBeDefined()
    db.close()
  })
})

describe('as-json fromString — apply with insert-only policy', () => {
  it('inserts only new records; modifications are skipped', async () => {
    const { db, vault } = await setup()
    const json = JSON.stringify({
      invoices: [
        { id: 'b', amount: 999, status: 'WOULD_OVERWRITE' },   // skipped under insert-only
        { id: 'c', amount: 300, status: 'paid' },              // inserted
      ],
    })

    const importer = await vault.import(asJson(), json, { policy: 'insert-only' })
    await importer.apply()

    const inv = vault.collection<Invoice>('invoices')
    // 'b' kept its original values — modification was skipped.
    expect(await inv.get('b')).toEqual({ id: 'b', amount: 200, status: 'paid' })
    expect(await inv.get('c')).toEqual({ id: 'c', amount: 300, status: 'paid' })
    db.close()
  })
})

describe('as-json fromObject — direct-object input', () => {
  it('skips the JSON.parse step', async () => {
    const { db, vault } = await setup()
    const importer = await vault.import(asJson(), JSON.stringify({
      invoices: [{ id: 'c', amount: 300, status: 'paid' }],
    }), {})
    expect(importer.plan.added.map((e) => e.id)).toEqual(['c'])
    db.close()
  })
})

describe('as-json fromString — apply stamps `reason: "import:json"` on every ledger entry (#1)', () => {
  it('imported rows are filterable from manual edits via ledger.reason', async () => {
    const adapter = toMemory()
    // Init: grant + seed an existing record manually (no reason — counts as manual edit).
    const init = await createNoydb({ formatsStrategy: withFormats(), teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-2026', historyStrategy: withHistory() })
    await init.openVault('demo')
    await init.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      secret: 'pw-2026',
      importCapability: { plaintext: ['json'] },
    })
    init.close()

    const db = await createNoydb({ formatsStrategy: withFormats(), teamStrategy: withTeam(),
      store: adapter, user: 'alice', secret: 'pw-2026',
      historyStrategy: withHistory(),
      transactionsStrategy: withTransactions(),
    })
    const vault = await db.openVault('demo')
    const inv = vault.collection<Invoice>('invoices')
    await inv.put('manual', { id: 'manual', amount: 99, status: 'draft' })

    // Import via apply() — every put inside is tagged 'import:json'
    const importer = await vault.import(asJson(), JSON.stringify({
      invoices: [
        { id: 'imp-1', amount: 100, status: 'paid' },
        { id: 'imp-2', amount: 200, status: 'paid' },
      ],
    }), {})
    await importer.apply()

    const entries = await vault.ledger().entries()
    const reasonByOrder = entries.map((e) => ({ id: e.id, reason: e.reason }))
    expect(reasonByOrder).toEqual([
      { id: 'manual', reason: undefined },
      { id: 'imp-1', reason: 'import:json' },
      { id: 'imp-2', reason: 'import:json' },
    ])

    // Audit filter — the documented use case.
    const imports = entries.filter((e) => e.reason?.startsWith('import:'))
    expect(imports.map((e) => e.id)).toEqual(['imp-1', 'imp-2'])
    db.close()
  })
})

describe('as-json fromString — error surfaces', () => {
  it('rejects malformed JSON with a clear message', async () => {
    const { db, vault } = await setup()
    await expect(vault.import(asJson(), '{ not valid json'), {}).rejects.toThrow(/not valid JSON/)
    db.close()
  })

  it('rejects non-object top-level values', async () => {
    const { db, vault } = await setup()
    await expect(vault.import(asJson(), '[1, 2, 3]', {})).rejects.toThrow(/object mapping/)
    db.close()
  })
})
