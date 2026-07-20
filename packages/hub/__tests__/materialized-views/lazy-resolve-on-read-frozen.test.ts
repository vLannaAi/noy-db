/**
 * #641 — lazy-MV resolve-on-read must respect the frozen-output rule (#637, #638 Task 5).
 *
 * `stale.ts#resolveStaleMVOnRead` (the `refresh: 'lazy'` materialize-on-read path) used to
 * write refreshed rows via a raw `outputColl.put()`, unwired from `putDerivedOutput`'s
 * frozen-period skip+audit. A lazy MV whose stale output row fell inside a CLOSED period
 * threw `PeriodClosedError` straight out of a READ (`.get()`/`.list()`) instead of skipping
 * the write and standing on the historical row — exactly what `dispatchMaterializedViews`,
 * `dispatchMaterializedViewsOnDelete`, and `refreshView()` already do for the other three
 * dispatch paths.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView } from '../../src/index.js'
import { withPeriods } from '../../src/with-audit/periods/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'
import type { DerivationSkippedFrozen } from '../../src/kernel/via/dispatch.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) { out[cname] = out[cname] ?? {}; out[cname]![id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
      }
    },
  }
}

interface Item extends Record<string, unknown> { id: string; tag: string; asOf: string }

describe('lazy-MV resolve-on-read respects the frozen-output rule (#641)', () => {
  it('.get(): stale output row in a closed+frozen period — no PeriodClosedError, historical row stands, skip event fires', async () => {
    const lazyMV = withMaterializedView<Item>({
      name: 'red-items',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'lazy',
      // strict: true makes a per-row write failure re-throw out of the executor instead of
      // being logged-and-skipped — this is what actually surfaces PeriodClosedError THROUGH
      // the read in the pre-fix bug (#641); non-strict mode merely swallows it as a silent
      // `failed` count, which is its own problem but not what the issue reports.
      strict: true,
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-resolve-on-read-frozen-passphrase-2026',
      materializedViewStrategies: [lazyMV],
      periodsStrategy: withPeriods(),
    })
    const vault = await db.openVault('demo')
    const items = vault.collection<Item>('items')
    const redItems = vault.collection<Item>('red-items')

    // Establish the historical output row — no period closed yet.
    await items.put('a', { id: 'a', tag: 'red', asOf: '2026-01-15' })
    const before = await redItems.get('a')
    expect(before).not.toBeNull()

    // Close + freeze the period covering the output row's `asOf`.
    await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'asOf' })
    await vault.freezePeriod('FY2026-Q1')

    // Mutate the SOURCE post-freeze — marks the lazy MV stale again. 'b's own `asOf` falls
    // AFTER the closed period's end date, so this write itself is legal (not gated).
    await items.put('b', { id: 'b', tag: 'red', asOf: '2026-06-01' })

    const events: DerivationSkippedFrozen[] = []
    db.on('derivation:skipped-frozen', (e) => events.push(e))

    // The read must NOT throw PeriodClosedError even though resolving the stale flag tries
    // (and fails-closed) to re-materialize 'a's frozen row.
    await expect(redItems.get('a')).resolves.not.toBeNull()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      target: { collection: 'red-items', id: 'a' },
      period: 'FY2026-Q1',
    })

    // Historical row stands, byte-identical to the pre-freeze materialize.
    expect(await redItems.get('a')).toEqual(before)
    // The open-period row ('b') still materializes normally in the same resolve pass.
    expect(await redItems.get('b')).not.toBeNull()
  })

  it('.list(): same guarantee via the list() resolve-on-read path', async () => {
    const lazyMV = withMaterializedView<Item>({
      name: 'red-items',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'lazy',
      // strict: true makes a per-row write failure re-throw out of the executor instead of
      // being logged-and-skipped — this is what actually surfaces PeriodClosedError THROUGH
      // the read in the pre-fix bug (#641); non-strict mode merely swallows it as a silent
      // `failed` count, which is its own problem but not what the issue reports.
      strict: true,
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-resolve-on-read-frozen-list-passphrase-2026',
      materializedViewStrategies: [lazyMV],
      periodsStrategy: withPeriods(),
    })
    const vault = await db.openVault('demo')
    const items = vault.collection<Item>('items')
    const redItems = vault.collection<Item>('red-items')

    await items.put('a', { id: 'a', tag: 'red', asOf: '2026-01-15' })
    await redItems.get('a') // baseline materialize

    await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'asOf' })
    await vault.freezePeriod('FY2026-Q1')

    await items.put('c', { id: 'c', tag: 'red', asOf: '2026-06-01' })

    const events: DerivationSkippedFrozen[] = []
    db.on('derivation:skipped-frozen', (e) => events.push(e))

    const rows = await redItems.list() // must not throw
    expect(rows.map(r => r.id).sort()).toEqual(['a', 'c'])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ target: { collection: 'red-items', id: 'a' }, period: 'FY2026-Q1' })
  })
})
