/**
 * Bundle export dead-satellite filter (#591 Task 10): `.noydb` bundle
 * export excludes satellite-collection records whose base row is dead
 * (absent or tombstoned) — the base is the sole existence authority
 * (existence.ts rule 1), so a satellite envelope surviving past its base
 * is dead ciphertext (plus its wrapped keys) that must never leave the
 * vault in a backup.
 *
 * Fixture pattern (spy-free in-memory store, `db.openVault`, `historyStrategy`
 * required by `writeNoydbBundle` → `vault.dump()`) copied from
 * satellites-joined.test.ts / bundle-slice.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { writeNoydbBundle, readNoydbBundle } from '../src/with-pod/bundle.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

const SECRET = 'satellite-bundle-filter-test-1234'

interface Msg extends Record<string, unknown> {
  from?: string
  body?: string
}

interface Invoice extends Record<string, unknown> {
  id: string
  amount: number
}

function memory(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let comp = data.get(v); if (!comp) { comp = new Map(); data.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env) { gc(v, c).set(id, env) },
    async delete(v, c, id) { gc(v, c).delete(id) },
    async list(v, c) { const coll = data.get(v)?.get(c); return coll ? [...coll.keys()] : [] },
    async loadAll(v) {
      const comp = data.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(v, recs) {
      for (const [n, byId] of Object.entries(recs)) { const coll = gc(v, n); for (const [id, e] of Object.entries(byId)) coll.set(id, e) }
    },
  }
}

async function openPair() {
  const rawStore = memory()
  const db = await createNoydb({ store: rawStore, user: 'alice', secret: SECRET, historyStrategy: withHistory() })
  const vault = await db.openVault('v1')
  vault.collection<Msg>('msgs')
  vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['body'], joined: 'msgs_full' })
  // declareSatellite's postRegister (persists the `_schemas` pairing marker
  // this filter reads) is fire-and-forget from `vault.collection()` — let it
  // settle before the test proceeds, mirroring satellites-fanout.test.ts's
  // "let ... async hydration settle" pattern.
  await new Promise((r) => setTimeout(r, 20))
  return { db, vault, rawStore }
}

async function exportDump(vault: Awaited<ReturnType<Awaited<ReturnType<typeof createNoydb>>['openVault']>>): Promise<string> {
  const bytes = await writeNoydbBundle(vault)
  const { dumpJson } = await readNoydbBundle(bytes)
  return dumpJson
}

function collRecords(dumpJson: string, collName: string): Record<string, unknown> {
  const parsed = JSON.parse(dumpJson) as { collections?: Record<string, Record<string, unknown>> }
  return parsed.collections?.[collName] ?? {}
}

describe('writeNoydbBundle — satellite existence-authority filter (#591 Task 10)', () => {
  it('excludes a satellite record whose base was raw-deleted (absent); live pair exports both', async () => {
    const { db, vault, rawStore } = await openPair()
    await vault.joined<Msg>('msgs_full').put('x', { from: 'a', body: 'B' })
    await vault.joined<Msg>('msgs_full').put('y', { from: 'b', body: 'C' })
    await rawStore.delete('v1', 'msgs', 'x')

    const dumpJson = await exportDump(vault)
    expect(Object.keys(collRecords(dumpJson, 'msgs_text'))).toEqual(['y'])
    expect(Object.keys(collRecords(dumpJson, 'msgs'))).toEqual(['y'])
    db.close()
  })

  it('excludes a satellite record whose base is tombstoned (not merely absent)', async () => {
    const { db, vault, rawStore } = await openPair()
    await vault.joined<Msg>('msgs_full').put('x', { from: 'a', body: 'B' })
    await vault.joined<Msg>('msgs_full').put('y', { from: 'b', body: 'C' })
    // buildTombstone() shape: _iv === '' && _data === '' — written directly via the raw store.
    await rawStore.put('v1', 'msgs', 'x', { _noydb: 1, _v: 2, _ts: 't', _iv: '', _data: '' })

    const dumpJson = await exportDump(vault)
    expect(Object.keys(collRecords(dumpJson, 'msgs_text'))).toEqual(['y'])
    db.close()
  })

  it('control: a non-satellite collection is untouched even when the satellite filter is active', async () => {
    const { db, vault } = await openPair()
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', amount: 100 })
    await vault.collection<Invoice>('invoices').put('b', { id: 'b', amount: 200 })
    const withoutSatelliteRows = await exportDump(vault)

    // Now populate the declared satellite pair too, so the (always-on)
    // satellite filter is active for this export — `invoices` must not move.
    await vault.joined<Msg>('msgs_full').put('x', { from: 'a', body: 'B' })

    const dumpJson = await exportDump(vault)
    expect(collRecords(dumpJson, 'invoices')).toEqual(collRecords(withoutSatelliteRows, 'invoices'))
    expect(Object.keys(collRecords(dumpJson, 'invoices')).sort()).toEqual(['a', 'b'])
    db.close()
  })

  it('a satellite pair declared with zero dead rows exports with no behavior change', async () => {
    const { db, vault } = await openPair()
    await vault.joined<Msg>('msgs_full').put('x', { from: 'a', body: 'B' })
    await vault.joined<Msg>('msgs_full').put('y', { from: 'b', body: 'C' })

    const dumpJson = await exportDump(vault)
    expect(Object.keys(collRecords(dumpJson, 'msgs_text')).sort()).toEqual(['x', 'y'])
    expect(Object.keys(collRecords(dumpJson, 'msgs')).sort()).toEqual(['x', 'y'])
    db.close()
  })
})
