/**
 * Reader-side coverage for @noy-db/as-xml (#318 / #302 phase 2).
 *
 * Covers:
 *   - capability gate via assertCanImport('plaintext','xml')
 *   - parse + apply for merge / replace / insert-only policies
 *   - field type coercion (number / boolean) via fieldTypes
 *   - namespace prefix stripping (`<ns:Invoice>` round-trips)
 *   - explicit recordElement override
 *   - malformed XML → typed parse error
 *   - round-trip: toString → fromString → diff is empty
 *   - apply() requires withTransactions() (#309)
 */
import { describe, expect, it } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, ImportCapabilityError, createNoydb } from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/tx'
import { fromString, toString } from '../src/index.js'

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

interface Invoice { id: string; client: string; amount: number }

async function setup() {
  const adapter = memory()
  const init = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
  await init.openVault('demo')
  await init.grant('demo', {
    userId: 'alice', displayName: 'Alice', role: 'owner',
    passphrase: 'pw-2026',
    importCapability: { plaintext: ['xml'] },
    exportCapability: { plaintext: ['xml'] },  // round-trip needs export too
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

describe('as-xml fromString — capability gate', () => {
  it('throws ImportCapabilityError without the grant', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
    const vault = await db.openVault('demo')
    await expect(
      fromString(vault, '<Records><Invoice><id>a</id></Invoice></Records>', { collection: 'invoices' }),
    ).rejects.toThrow(ImportCapabilityError)
    db.close()
  })
})

describe('as-xml fromString — parse + apply', () => {
  it('parses a basic XML document and applies under merge policy', async () => {
    const { db, vault } = await setup()
    const xml = `<?xml version="1.0"?>
      <Records>
        <Invoice><id>a</id><client>X</client><amount>100</amount></Invoice>
        <Invoice><id>b</id><client>Acme &amp; Co.</client><amount>250</amount></Invoice>
      </Records>`
    const importer = await fromString(vault, xml, {
      collection: 'invoices',
      fieldTypes: { amount: 'number' },
    })
    expect(importer.plan.summary).toEqual({ add: 1, modify: 0, delete: 0, total: 1 })
    expect(importer.plan.added[0]!.record).toEqual({ id: 'b', client: 'Acme & Co.', amount: 250 })

    await importer.apply()
    expect(await vault.collection<Invoice>('invoices').get('b')).toEqual({
      id: 'b', client: 'Acme & Co.', amount: 250,
    })
    db.close()
  })

  it('coerces booleans via fieldTypes', async () => {
    const { db, vault } = await setup()
    const xml = `<Records><Invoice><id>x</id><paid>true</paid></Invoice></Records>`
    const importer = await fromString(vault, xml, {
      collection: 'invoices',
      fieldTypes: { paid: 'boolean' },
    })
    expect((importer.plan.added[0]!.record as Record<string, unknown>)['paid']).toBe(true)
    db.close()
  })

  it('strips namespace prefixes on the root and record elements', async () => {
    const { db, vault } = await setup()
    const xml = `<?xml version="1.0"?>
      <ns:Records xmlns:ns="http://example.com/inv">
        <ns:Invoice><id>z</id><client>Zed</client><amount>9</amount></ns:Invoice>
      </ns:Records>`
    const importer = await fromString(vault, xml, {
      collection: 'invoices',
      fieldTypes: { amount: 'number' },
    })
    expect(importer.plan.added[0]!.record).toEqual({ id: 'z', client: 'Zed', amount: 9 })
    db.close()
  })

  it('honors explicit recordElement override', async () => {
    const { db, vault } = await setup()
    const xml = `<Wrapper><Row><id>q</id><client>Q</client><amount>1</amount></Row></Wrapper>`
    const importer = await fromString(vault, xml, {
      collection: 'invoices',
      recordElement: 'Row',
      fieldTypes: { amount: 'number' },
    })
    expect(importer.plan.added[0]!.record).toEqual({ id: 'q', client: 'Q', amount: 1 })
    db.close()
  })

  it('handles a single-record document (parser non-array case)', async () => {
    const { db, vault } = await setup()
    const xml = `<Records><Invoice><id>solo</id><client>Solo</client><amount>1</amount></Invoice></Records>`
    const importer = await fromString(vault, xml, {
      collection: 'invoices',
      fieldTypes: { amount: 'number' },
    })
    expect(importer.plan.summary.add).toBe(1)
    expect(importer.plan.added[0]!.record).toEqual({ id: 'solo', client: 'Solo', amount: 1 })
    db.close()
  })

  it('rejects malformed XML with a clear message', async () => {
    const { db, vault } = await setup()
    await expect(
      fromString(vault, '<Records><Invoice><id>a</id></Records>', { collection: 'invoices' }),
    ).rejects.toThrow(/not valid XML/)
    db.close()
  })
})

describe('as-xml fromString — policies', () => {
  it('replace deletes records absent from the input', async () => {
    const { db, vault } = await setup()
    // Vault has 'a'. Input has only 'b' → 'a' should be deleted on replace.
    const xml = `<Records><Invoice><id>b</id><client>B</client><amount>2</amount></Invoice></Records>`
    const importer = await fromString(vault, xml, {
      collection: 'invoices',
      policy: 'replace',
      fieldTypes: { amount: 'number' },
    })
    await importer.apply()
    expect(await vault.collection<Invoice>('invoices').get('a')).toBeNull()
    expect(await vault.collection<Invoice>('invoices').get('b')).toEqual({ id: 'b', client: 'B', amount: 2 })
    db.close()
  })

  it('insert-only refuses to modify existing records', async () => {
    const { db, vault } = await setup()
    // 'a' exists with amount=100. Input has 'a' with amount=999 → modify should be skipped.
    const xml = `<Records><Invoice><id>a</id><client>X</client><amount>999</amount></Invoice></Records>`
    const importer = await fromString(vault, xml, {
      collection: 'invoices',
      policy: 'insert-only',
      fieldTypes: { amount: 'number' },
    })
    await importer.apply()
    expect(await vault.collection<Invoice>('invoices').get('a')).toEqual({ id: 'a', client: 'X', amount: 100 })
    db.close()
  })
})

describe('as-xml fromString — round-trip', () => {
  it('toString → fromString → diff is empty against the source vault', async () => {
    const { db, vault } = await setup()
    const xml = await toString(vault, { collection: 'invoices' })

    const importer = await fromString(vault, xml, {
      collection: 'invoices',
      fieldTypes: { amount: 'number' },
    })
    // Same source vault → no records should be added/modified/deleted.
    expect(importer.plan.summary).toEqual({ add: 0, modify: 0, delete: 0, total: 0 })
    db.close()
  })
})

describe('as-xml fromString — apply() requires withTransactions() (#309)', () => {
  it('throws a clear error when the tx strategy is missing', async () => {
    const adapter = memory()
    const init = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
    await init.openVault('demo')
    await init.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: 'pw-2026',
      importCapability: { plaintext: ['xml'] },
    })
    init.close()
    const db = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
    const vault = await db.openVault('demo')

    const importer = await fromString(vault,
      '<Records><Invoice><id>z</id></Invoice></Records>',
      { collection: 'invoices' })
    await expect(importer.apply()).rejects.toThrow(/withTransactions/)
    db.close()
  })
})
