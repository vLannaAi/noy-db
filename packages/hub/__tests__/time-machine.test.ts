/**
 * Tests for `vault.at(timestamp)` — v0.16 time-machine queries.
 *
 * Strategy: write three versions of a record separated by short
 * sleeps so each envelope gets a distinct `_ts`; then query at
 * timestamps between each write and verify the returned record
 * matches the expected version.
 *
 * Covers:
 *   - read at a time before any put → null
 *   - read between v1 and v2 → v1 content
 *   - read between v2 and v3 → v2 content
 *   - read after v3 → v3 content
 *   - read after delete → null (ledger cross-check)
 *   - list() excludes records deleted before target ts
 *   - writes on VaultInstant throw ReadOnlyAtInstantError
 *   - plaintext (encrypt: false) vault round-trips correctly
 */
import { describe, expect, it, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, ReadOnlyAtInstantError, createNoydb } from '../src/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import type { Noydb } from '../src/index.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        if (cn.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, data2) {
      for (const [cn, recs] of Object.entries(data2)) {
        const coll = getColl(v, cn)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { amount: number; status: string }

async function tick(ms = 15): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('vault.at(ts) — time-machine queries', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memoryStore(),
      user: 'owner', historyStrategy: withHistory(),
      encrypt: false,
      history: { enabled: true },
    })
  })

  describe('get() — version resolution at a point in time', () => {
    it('returns null when queried before any put', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      // Capture a timestamp before any write
      const beforeAll = new Date(Date.now() - 1000).toISOString()
      await invoices.put('inv-1', { amount: 100, status: 'draft' })

      const past = await vault.at(beforeAll).collection<Invoice>('invoices').get('inv-1')
      expect(past).toBeNull()
    })

    it('returns the v1 record for a timestamp between v1 and v2', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await tick()
      const tBetween = new Date().toISOString()
      await tick()
      await invoices.put('inv-1', { amount: 100, status: 'sent' })

      const at = await vault.at(tBetween).collection<Invoice>('invoices').get('inv-1')
      expect(at).toEqual({ amount: 100, status: 'draft' })
    })

    it('walks through three versions and returns the right one at each midpoint', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await tick()
      const t1 = new Date().toISOString()    // between v1 and v2
      await tick()

      await invoices.put('inv-1', { amount: 100, status: 'sent' })
      await tick()
      const t2 = new Date().toISOString()    // between v2 and v3
      await tick()

      await invoices.put('inv-1', { amount: 100, status: 'paid' })
      await tick()
      const t3 = new Date().toISOString()    // after v3

      expect(await vault.at(t1).collection<Invoice>('invoices').get('inv-1'))
        .toEqual({ amount: 100, status: 'draft' })
      expect(await vault.at(t2).collection<Invoice>('invoices').get('inv-1'))
        .toEqual({ amount: 100, status: 'sent' })
      expect(await vault.at(t3).collection<Invoice>('invoices').get('inv-1'))
        .toEqual({ amount: 100, status: 'paid' })
    })

    it('accepts a Date object as well as an ISO string', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 42, status: 'draft' })
      await tick()

      const now = new Date()
      const viaDate = await vault.at(now).collection<Invoice>('invoices').get('inv-1')
      const viaIso = await vault.at(now.toISOString()).collection<Invoice>('invoices').get('inv-1')
      expect(viaDate).toEqual(viaIso)
      expect(viaDate).toEqual({ amount: 42, status: 'draft' })
    })
  })

  describe('delete semantics', () => {
    it('returns null for a record deleted before the query timestamp', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await tick()
      await invoices.delete('inv-1')
      await tick()
      const afterDelete = new Date().toISOString()

      const result = await vault.at(afterDelete).collection<Invoice>('invoices').get('inv-1')
      expect(result).toBeNull()
    })

    it('still returns the record when queried between put and delete', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await tick()
      const betweenPutAndDelete = new Date().toISOString()
      await tick()
      await invoices.delete('inv-1')

      const result = await vault.at(betweenPutAndDelete).collection<Invoice>('invoices').get('inv-1')
      expect(result).toEqual({ amount: 100, status: 'draft' })
    })
  })

  describe('list() — IDs alive at a given instant', () => {
    it('returns only records that existed and were not deleted by the target time', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('a', { amount: 1, status: 'x' })
      await invoices.put('b', { amount: 2, status: 'x' })
      await tick()
      await invoices.delete('a')
      await tick()
      await invoices.put('c', { amount: 3, status: 'x' })

      const now = new Date().toISOString()
      const ids = await vault.at(now).collection<Invoice>('invoices').list()
      // a was deleted; b and c survived
      expect(ids.sort()).toEqual(['b', 'c'])
    })
  })

  describe('read-only contract', () => {
    it('put() throws ReadOnlyAtInstantError', async () => {
      const vault = await db.openVault('acme')
      const past = vault.at('2020-01-01T00:00:00Z').collection<Invoice>('invoices')
      await expect(past.put('inv-1', { amount: 1, status: 'x' })).rejects.toBeInstanceOf(ReadOnlyAtInstantError)
    })

    it('delete() throws ReadOnlyAtInstantError', async () => {
      const vault = await db.openVault('acme')
      const past = vault.at('2020-01-01T00:00:00Z').collection<Invoice>('invoices')
      await expect(past.delete('inv-1')).rejects.toBeInstanceOf(ReadOnlyAtInstantError)
    })

    it('error carries the timestamp for diagnostic display', async () => {
      const vault = await db.openVault('acme')
      const past = vault.at('2020-01-01T00:00:00Z').collection<Invoice>('invoices')
      try {
        await past.put('inv-1', { amount: 1, status: 'x' })
      } catch (err) {
        expect((err as Error).message).toContain('2020-01-01T00:00:00Z')
      }
    })
  })
})

describe('vault.at(ts) — encrypted mode round-trip', () => {
  it('decrypts historical snapshots with the collection DEK', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner', historyStrategy: withHistory(),
      secret: 'test-passphrase-12345678',
      history: { enabled: true },
    })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<Invoice>('invoices')

    await invoices.put('inv-1', { amount: 100, status: 'draft' })
    await tick()
    const t1 = new Date().toISOString()
    await tick()
    await invoices.put('inv-1', { amount: 100, status: 'sent' })

    const past = await vault.at(t1).collection<Invoice>('invoices').get('inv-1')
    expect(past).toEqual({ amount: 100, status: 'draft' })
  })
})

/**
 * #730 — time-machine reads must honor the same tier-0 invisibility law as
 * `history()`/`getVersion()` (the #712 read-gate): an elevated live record's
 * point-in-time view is invisible through `vault.at(ts)`, not an opaque
 * AES-GCM throw. Also locks the pre-existing perRecordKeys bug: `get()` must
 * route through the `_cek`-aware envelope-open helper so a perRecordKeys
 * snapshot decrypts correctly even with no tiers involved.
 */
describe('vault.at(ts) — #730 tier gate', () => {
  interface Doc { name: string }

  it('elevated record: get() returns null (not an opaque decrypt throw), list() omits the id', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, user: 'owner', secret: 'pw-730-elevated',
      tiersStrategy: withTiers(), historyStrategy: withHistory(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    // v1 is archived to `_history` once v2 overwrites it, so a query at `ts`
    // (between v1 and v2) resolves to a REAL `_history` envelope — one whose
    // `_cek` gets rewrapped to the tier-1 DEK by elevate()'s syncHistory.
    // Pre-#730 this is exactly the case that decrypted-under-the-wrong-key
    // and threw an opaque AES-GCM error instead of returning null.
    await docs.put('d1', { name: 'v1' })
    await tick()
    const ts = new Date().toISOString()
    await tick()
    await docs.put('d1', { name: 'v2' })
    await docs.elevate('d1', 1)

    expect(await vault.at(ts).collection<Doc>('docs').get('d1')).toBeNull()
    expect(await vault.at(ts).collection<Doc>('docs').list()).not.toContain('d1')
  })

  it('demoted back to tier 0: time-machine reads of an archived version work again', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, user: 'owner', secret: 'pw-730-demote',
      tiersStrategy: withTiers(), historyStrategy: withHistory(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    // v1 is archived to `_history` once v2 overwrites it. elevate() rewraps
    // that `_history` snapshot's `_cek` to the tier-1 DEK (invisible while
    // elevated); demote() rewraps it back to tier-0 — the archived version
    // must decrypt again afterward.
    await docs.put('d2', { name: 'a' })
    await tick()
    const ts = new Date().toISOString()
    await tick()
    await docs.put('d2', { name: 'b' })
    await docs.elevate('d2', 1)
    await docs.demote('d2', 0)

    expect(await vault.at(ts).collection<Doc>('docs').get('d2')).toEqual({ name: 'a' })
    expect(await vault.at(ts).collection<Doc>('docs').list()).toContain('d2')
  })

  it('perRecordKeys collection, no tiers: at(ts).get() decrypts the historical body via the record CEK', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, user: 'owner', secret: 'pw-730-cek', historyStrategy: withHistory(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { perRecordKeys: true })

    await docs.put('d3', { name: 'v1' })
    await tick()
    const ts = new Date().toISOString()
    await tick()
    await docs.put('d3', { name: 'v2' })

    // Pre-#730: get() ignored `_cek` and decrypted directly under the
    // collection DEK, which throws on a per-record-CEK-encrypted body.
    expect(await vault.at(ts).collection<Doc>('docs').get('d3')).toEqual({ name: 'v1' })
  })

  it('a tier-0 (never-elevated) record is unaffected', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, user: 'owner', secret: 'pw-730-t0',
      tiersStrategy: withTiers(), historyStrategy: withHistory(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    await docs.put('d4', { name: 'v1' })
    await tick()
    const ts = new Date().toISOString()
    await tick()
    await docs.put('d4', { name: 'v2' })

    expect(await vault.at(ts).collection<Doc>('docs').get('d4')).toEqual({ name: 'v1' })
    expect(await vault.at(ts).collection<Doc>('docs').list()).toContain('d4')
  })
})
