/**
 * Forget fan-out through satellite pairs (#591, Task 8).
 *
 * Spec: docs/superpowers/specs/2026-07-05-satellite-collections-design.md
 *
 * A satellite record is never itself present in the encrypted subject index
 * (its writes only ever flow through `joinedPut`, which the forget
 * subject-index write hook never observes — see `noydb.ts#registerForgetHooks`).
 * `vault.forget()` must still shred it: `expandRefsWithSatellites`
 * (`with-shape/satellites/forget.ts`) synthesizes a same-id ref for every
 * base ref whose collection has a declared satellite, and that ref rides the
 * SAME per-ref purge suite a base ref does (tombstone, history, `_idx`
 * purge, blobs, `_sealed`/`_sealed_cek`, vectors) — not a parallel path.
 *
 * Test 2 (full-purge-suite traversal) uses `_idx` side-car purge rather than
 * wiring `withSearch` onto the satellite: proving the synthesized ref is
 * subject to `_purgePersistedIndexes` (a mid-loop stage, not the tombstone
 * write itself, nor the last stage) is sufficient evidence the ref traverses
 * the whole loop body, and it reuses the exact pattern already proven for
 * base refs in `forget.test.ts` group 10.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import { memory } from '../../to-memory/src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

const SECRET = 'satellites-forget-test-1234'

interface Msg extends Record<string, unknown> {
  from?: string
  subject?: string
  body?: string
}

/** Wraps a real `to-memory` store with a one-shot per-collection put-failure spy. */
function spyStore(raw: NoydbStore): { store: NoydbStore; failNextPutFor: (coll: string) => void } {
  let failNextFor: string | null = null
  const store: NoydbStore = {
    ...raw,
    async put(vault, coll, id, env, expectedVersion) {
      if (failNextFor === coll) {
        failNextFor = null
        throw new Error(`spy: injected failure for put("${coll}")`)
      }
      return raw.put(vault, coll, id, env, expectedVersion)
    },
  }
  return { store, failNextPutFor: (coll: string) => { failNextFor = coll } }
}

async function openForgetPair(opts: { indexed?: boolean } = {}) {
  const rawStore = memory()
  const { store, failNextPutFor } = spyStore(rawStore)
  const db = await createNoydb({
    store,
    user: 'alice',
    secret: SECRET,
    historyStrategy: withHistory(),
    ...(opts.indexed ? { indexStrategy: withIndexing() } : {}),
    forgetStrategy: withForgetCascade({ subjects: { msgs: 'from' } }),
  })
  const vault = await db.openVault('v1')
  // R-S7: both pair members declare perRecordKeys explicitly (the base's is
  // also force-derived from `forgetStrategy.subjects`, but spelling it out
  // here keeps the fixture's forget-coverage intent legible).
  vault.collection<Msg>('msgs', { perRecordKeys: true })
  vault.collection<Msg>('msgs_text', {
    satelliteOf: 'msgs',
    fields: ['subject', 'body'],
    joined: 'msgs_full',
    perRecordKeys: true,
    ...(opts.indexed ? { indexes: ['subject'], prefetch: false, cache: { maxRecords: 100 } } : {}),
  })
  return { vault, rawStore, spy: { failNextPutFor } }
}

async function stripCek(rawStore: NoydbStore, vault: string, collection: string, id: string): Promise<void> {
  const live = await rawStore.get(vault, collection, id)
  if (!live) throw new Error('stripCek: no live envelope to forge')
  await rawStore.put(vault, collection, id, { ...live, _cek: undefined } as unknown as EncryptedEnvelope)
}

describe('forget fan-out through the full purge suite (#591, Task 8)', () => {
  it('shreds the satellite via a synthesized ref (never in the subject index)', async () => {
    const { vault, rawStore } = await openForgetPair()
    await vault.joined('msgs_full').put('x', { from: 'alice@x', subject: 's', body: 'SECRET' })

    const result = await vault.forget('alice@x')

    expect(result.recordsShredded).toBe(2) // base + satellite
    const satEnv = await rawStore.get('v1', 'msgs_text', 'x')
    expect(satEnv?._data).toBe('') // tombstoned, not merely deleted
    expect(satEnv?._cek).toBeUndefined()
    const baseEnv = await rawStore.get('v1', 'msgs', 'x')
    expect(baseEnv?._data).toBe('')
  })

  it('purges the satellite\'s persisted _idx side-cars (same per-ref suite as base)', async () => {
    const { vault, rawStore } = await openForgetPair({ indexed: true })
    await vault.joined('msgs_full').put('x', { from: 'alice@x', subject: 'zebra unique', body: 'b' })

    const idxIds = () => rawStore.list('v1', 'msgs_text')
    expect((await idxIds()).some((k) => k.startsWith('_idx/') && k.endsWith('/x'))).toBe(true)

    const result = await vault.forget('alice@x')

    expect(result.indexResidue).toEqual([])
    expect((await idxIds()).some((k) => k.startsWith('_idx/') && k.endsWith('/x'))).toBe(false)
  })

  it('classification inheritance: an unmigrated (no-_cek) satellite record is REPORTED in unmigratedRecords', async () => {
    const { vault, rawStore } = await openForgetPair()
    await vault.joined('msgs_full').put('x', { from: 'alice@x', body: 'B' })
    await stripCek(rawStore, 'v1', 'msgs_text', 'x') // forge a legacy shared-DEK record

    const result = await vault.forget('alice@x')

    expect(result.unmigratedRecords).toContain('msgs_text:x')
  })

  it('R-S4: a satellite ref that cannot be processed fails the forget loudly', async () => {
    const { vault, spy } = await openForgetPair()
    await vault.joined('msgs_full').put('x', { from: 'alice@x', body: 'B' })
    spy.failNextPutFor('msgs_text') // tombstone write fails

    await expect(vault.forget('alice@x')).rejects.toThrowError(/R-S4/)
  })

  it('R-S4 retry: an aborted forget can be retried to completion — the base\'s subject-index anchor must survive an abort mid-satellite-ref (no retry black hole, review C1)', async () => {
    const { vault, rawStore, spy } = await openForgetPair()
    await vault.joined('msgs_full').put('x', { from: 'alice@x', subject: 's', body: 'SECRET' })

    spy.failNextPutFor('msgs_text') // satellite tombstone write fails ONCE
    await expect(vault.forget('alice@x')).rejects.toThrowError(/R-S4/)

    // Retry (the spy already disarmed itself after firing once) must still
    // find the subject and shred BOTH the satellite and the base — if the
    // satellite ref ran after (instead of before) its base ref, the base's
    // subject-index entry would already be gone and this retry would return
    // a clean, empty result while the satellite stays un-shredded forever.
    const result = await vault.forget('alice@x')

    expect(result.recordsShredded).toBe(2) // base + satellite, both shredded on retry
    const satEnv = await rawStore.get('v1', 'msgs_text', 'x')
    expect(satEnv?._data).toBe('')
    const baseEnv = await rawStore.get('v1', 'msgs', 'x')
    expect(baseEnv?._data).toBe('')
  })
})
