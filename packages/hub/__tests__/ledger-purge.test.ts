/**
 * #729 — `LedgerStore.purgeRecordDeltas` deletes a record's plaintext
 * `_ledger_deltas` rows while leaving the tamper-chain valid.
 *
 * `verify()` recomputes the chain from each entry's canonical fields
 * (including the `deltaHash` field, which lives on the `_ledger`
 * entry, not on the `_ledger_deltas` row) and never re-reads
 * `_ledger_deltas` — so deleting a delta row cannot break `verify()`.
 * `reconstruct()` already treats a missing delta as a pruned stop.
 *
 * Coverage:
 *   - purges a record's delta rows, keeps the chain valid, leaves a
 *     sibling record's deltas intact, and retains the entry metadata
 *   - is idempotent — purging already-purged deltas is a no-op
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import type { Noydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { paddedIndex } from '../src/with-commit/history/ledger/entry.js'

// Inline memory adapter (same shape as other ledger test files).
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
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
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Doc {
  id: string
  body: string
}

describe('LedgerStore.purgeRecordDeltas (#729)', () => {
  let adapter: NoydbStore
  let db: Noydb

  beforeEach(async () => {
    adapter = toMemory()
    db = await createNoydb({
      store: adapter,
      user: 'alice', historyStrategy: withHistory(),
      secret: 'test-secret-1234',
    })
  })

  it('purges a record’s delta rows, keeps the chain valid, leaves siblings intact', async () => {
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs')
    const ledger = company.ledger()

    // 'a' is updated (put twice) → produces a delta on its 2nd put.
    await docs.put('a', { id: 'a', body: 'a-v1' })
    await docs.put('a', { id: 'a', body: 'a-v2' })
    // 'b' is also updated → its own delta, must survive a's purge.
    await docs.put('b', { id: 'b', body: 'b-v1' })
    await docs.put('b', { id: 'b', body: 'b-v2' })

    expect((await ledger.verify()).ok).toBe(true)

    const entries = await ledger.entries()
    const aDeltaEntry = entries.find((e) => e.collection === 'docs' && e.id === 'a' && e.deltaHash !== undefined)
    const bDeltaEntry = entries.find((e) => e.collection === 'docs' && e.id === 'b' && e.deltaHash !== undefined)
    expect(aDeltaEntry).toBeDefined()
    expect(bDeltaEntry).toBeDefined()

    // a's delta row exists at rest before the purge.
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(aDeltaEntry!.index))).not.toBeNull()

    const purged = await ledger.purgeRecordDeltas('docs', 'a')
    expect(purged).toBeGreaterThan(0)

    // a's delta row is gone; b's remains.
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(aDeltaEntry!.index))).toBeNull()
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(bDeltaEntry!.index))).not.toBeNull()

    // THE INVARIANT: the tamper-chain is untouched by the purge.
    expect((await ledger.verify()).ok).toBe(true)

    // Entry metadata (the audit record that 'a' was mutated) survives.
    expect((await ledger.entries()).some((e) => e.id === 'a')).toBe(true)
  })

  it('scopes the purge to (collection, id) — a same-id record in a DIFFERENT collection is untouched', async () => {
    // The ledger is vault-wide; the filter must match the (collection, id)
    // pair, not id alone — else purging docs/x would wrongly delete notes/x.
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs')
    const notes = company.collection<Doc>('notes')
    const ledger = company.ledger()

    await docs.put('x', { id: 'x', body: 'docs-x-v1' })
    await docs.put('x', { id: 'x', body: 'docs-x-v2' })      // docs/x delta
    await notes.put('x', { id: 'x', body: 'notes-x-v1' })
    await notes.put('x', { id: 'x', body: 'notes-x-v2' })    // notes/x delta — same id, other collection

    const entries = await ledger.entries()
    const docsX = entries.find((e) => e.collection === 'docs' && e.id === 'x' && e.deltaHash !== undefined)!
    const notesX = entries.find((e) => e.collection === 'notes' && e.id === 'x' && e.deltaHash !== undefined)!

    const purged = await ledger.purgeRecordDeltas('docs', 'x')
    expect(purged).toBe(1)

    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(docsX.index))).toBeNull()      // purged
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(notesX.index))).not.toBeNull() // NOT purged — different collection
    expect((await ledger.verify()).ok).toBe(true)
  })

  it('is idempotent — purging already-purged deltas is a no-op that keeps verify() ok', async () => {
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs')
    const ledger = company.ledger()

    await docs.put('a', { id: 'a', body: 'a-v1' })
    await docs.put('a', { id: 'a', body: 'a-v2' })

    const first = await ledger.purgeRecordDeltas('docs', 'a')
    expect(first).toBeGreaterThan(0)

    const second = await ledger.purgeRecordDeltas('docs', 'a')
    expect(second).toBe(0)

    expect((await ledger.verify()).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// #729 integration: TiersContext.syncLedger wired into elevate/putAtTier.
// ---------------------------------------------------------------------------

interface TieredDoc {
  id: string
  body: string
}

/** withHistory() (⇒ ledger) + withTiers([0,1]) — the fixture for the
 * elevate/putAtTier integration tests below. */
async function openTieredLedger() {
  const adapter = toMemory()
  const db = await createNoydb({
    store: adapter,
    user: 'owner', historyStrategy: withHistory(), tiersStrategy: withTiers(),
    secret: 'test-secret-1234',
  })
  const company = await db.openVault('demo-co')
  const docs = company.collection<TieredDoc>('docs', { tiers: [0, 1] })
  const ledger = company.ledger()
  return { company, docs, ledger, adapter }
}

describe('#729 tier ops purge the record’s ledger deltas at rest', () => {
  it('elevate purges d1’s _ledger_deltas row; verify() stays ok; reconstruct can no longer recover the pre-elevation plaintext; a sibling’s delta is untouched', async () => {
    const { docs, ledger, adapter } = await openTieredLedger()

    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' }) // → a delta capturing v1's fields
    await docs.put('sib', { id: 'sib', body: 's1' })
    await docs.put('sib', { id: 'sib', body: 's2' }) // sibling's own delta, must survive d1's purge

    const entries = await ledger.entries()
    const d1Delta = entries.find((e) => e.collection === 'docs' && e.id === 'd1' && e.deltaHash !== undefined)
    const sibDelta = entries.find((e) => e.collection === 'docs' && e.id === 'sib' && e.deltaHash !== undefined)
    expect(d1Delta).toBeDefined()
    expect(sibDelta).toBeDefined()

    // PRE-elevate: the raw delta row exists and reconstruct recovers v1's plaintext.
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(d1Delta!.index))).not.toBeNull()
    const current = await docs.get('d1')
    expect(current).not.toBeNull()
    const preElevate = await ledger.reconstruct<TieredDoc>('docs', 'd1', current!, 1)
    expect(preElevate).toEqual({ id: 'd1', body: 'v1' })

    await docs.elevate('d1', 1)

    // POST-elevate: the raw delta row is gone.
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(d1Delta!.index))).toBeNull()
    // THE INVARIANT: the tamper-chain is untouched by the purge.
    expect((await ledger.verify()).ok).toBe(true)
    // reconstruct can no longer walk back to v1 — the delta it needs is gone.
    const postElevate = await ledger.reconstruct<TieredDoc>('docs', 'd1', current!, 1)
    expect(postElevate).not.toEqual({ id: 'd1', body: 'v1' })
    expect(postElevate).toBeNull()
    // A sibling record's delta is untouched by d1's elevate.
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(sibDelta!.index))).not.toBeNull()
  })

  it('putAtTier(id, record, tier > 0) over a record with deltas also purges them', async () => {
    const { docs, ledger, adapter } = await openTieredLedger()

    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    const entries = await ledger.entries()
    const delta = entries.find((e) => e.collection === 'docs' && e.id === 'd1' && e.deltaHash !== undefined)
    expect(delta).toBeDefined()
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(delta!.index))).not.toBeNull()

    await docs.putAtTier('d1', { id: 'd1', body: 'v3' }, 1)

    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(delta!.index))).toBeNull()
    expect((await ledger.verify()).ok).toBe(true)
  })

  it('a non-elevated (tier-0) record keeps its deltas — a plain putAtTier(..., 0) does not purge', async () => {
    const { docs, ledger, adapter } = await openTieredLedger()

    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    const entries = await ledger.entries()
    const delta = entries.find((e) => e.collection === 'docs' && e.id === 'd1' && e.deltaHash !== undefined)
    expect(delta).toBeDefined()

    await docs.putAtTier('d1', { id: 'd1', body: 'v3' }, 0)

    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(delta!.index))).not.toBeNull()
    expect((await ledger.verify()).ok).toBe(true)
  })

  it('entries() still lists d1’s mutation metadata after elevate — the audit record of the change survives', async () => {
    const { docs, ledger } = await openTieredLedger()

    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    await docs.elevate('d1', 1)

    const entries = await ledger.entries()
    const d1Entries = entries.filter((e) => e.collection === 'docs' && e.id === 'd1')
    // Both the genesis put and the update put are still recorded.
    expect(d1Entries.length).toBe(2)
    expect(d1Entries.some((e) => e.deltaHash !== undefined)).toBe(true)
  })

  it('elevate → demote keeps the tamper-chain valid (demote does not touch the ledger; the purge is irreversible)', async () => {
    const { docs, ledger, adapter } = await openTieredLedger()

    await docs.put('d1', { id: 'd1', body: 'v1' })
    await docs.put('d1', { id: 'd1', body: 'v2' })
    const delta = (await ledger.entries()).find((e) => e.collection === 'docs' && e.id === 'd1' && e.deltaHash !== undefined)!

    await docs.elevate('d1', 1)                                                  // purges the delta
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(delta.index))).toBeNull()
    expect((await ledger.verify()).ok).toBe(true)

    await docs.demote('d1', 0)                                                   // demote touches no ledger code
    expect((await ledger.verify()).ok).toBe(true)                               // chain still valid after the round trip
    // Irreversible: the purged delta is NOT restored by demote.
    expect(await adapter.get('demo-co', '_ledger_deltas', paddedIndex(delta.index))).toBeNull()
  })
})
