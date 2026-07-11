// Frozen-output rule (#637, #638 Task 5): a dispatch-driven derivation/rollup/MV output
// write that lands in a CLOSED period must SKIP (the historical value stands) and emit a
// structured `'derivation:skipped-frozen'` event — instead of throwing `PeriodClosedError`
// through the legal SOURCE write that triggered the recompute. Covers all four output paths
// named in the spec: live local-write dispatch, `deriveAll()`, `refreshView()`, and the
// sync-applied batched wave (`runGraphDispatchWave`, #621) — the last one per the Task 4
// review mandate: one closed-period target in a wave must not abort the pull or starve a
// co-batched healthy target. A final group pins the wave's per-id isolation choice for
// non-`PeriodClosedError` throws (surfaced via `console.warn`, not silently swallowed).

import { describe, it, expect, vi } from 'vitest'
import { createNoydb, withRollup, withDerivation, withMaterializedView } from '../../src/index.js'
import { withPeriods } from '../../src/with-audit/periods/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { withSync } from '../../src/with-party/sync/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'
import type { DerivationSkippedFrozen } from '../../src/kernel/via-dispatch.js'

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

interface Buyer extends Record<string, unknown> { id: string; companyName?: string; totalSpent?: number; asOf?: string }
interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }

const totalSpentRollup = () =>
  withRollup<Sale, Buyer>({
    from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
    compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
  })

describe('frozen-output rule (#637) — local-write dispatch', () => {
  it('rollup target in a closed period: SOURCE write survives, event fires, aggregate unchanged, audit entry recorded', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'frozen-output-local-passphrase-2026',
      derivationStrategies: [totalSpentRollup()],
      periodsStrategy: withPeriods(),
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    const sales = vault.collection<Sale>('sales')

    await buyers.put('b1', { id: 'b1', companyName: 'Acme', asOf: '2026-01-15' })
    // The parent's own write already self-triggers a (zero-child) rollup recompute — capture
    // that as the historical baseline value the frozen period must preserve verbatim.
    const beforeTotal = (await buyers.get('b1'))?.totalSpent
    await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'asOf' })

    const events: DerivationSkippedFrozen[] = []
    db.on('derivation:skipped-frozen', (e) => events.push(e))

    // The child write is itself perfectly legal — `sales` records carry no `asOf` field, so
    // the closed period never touches the SOURCE write's own gate check.
    await expect(sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })).resolves.toBeUndefined()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      source: { collection: 'sales', id: 's1' },
      target: { collection: 'buyers', id: 'b1' },
      period: 'FY2026-Q1',
      endDate: '2026-03-31',
    })

    // Historical aggregate stands — recompute was skipped, not partially applied (the $100
    // sale never made it into totalSpent).
    expect((await buyers.get('b1'))?.totalSpent).toBe(beforeTotal)

    // with-audit (the with-history ledger) active → one audit-trail entry recorded.
    const entries = await vault.ledger().entries()
    const auditEntries = entries.filter(e => e.op === 'lifecycle' && e.reason?.includes('derivation-skipped-frozen'))
    expect(auditEntries).toHaveLength(1)
  })

  it('no with-history strategy active: skip + event still work, no audit entry (strategy-gated, not hard-required)', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'frozen-output-no-audit-passphrase-2026',
      derivationStrategies: [totalSpentRollup()],
      periodsStrategy: withPeriods(),
      // No historyStrategy — the with-audit ledger is inactive.
    })
    const vault = await db.openVault('firm')
    await vault.collection<Buyer>('buyers').put('b1', { id: 'b1', asOf: '2026-01-15' })
    await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'asOf' })

    const events: DerivationSkippedFrozen[] = []
    db.on('derivation:skipped-frozen', (e) => events.push(e))
    await expect(vault.collection<Sale>('sales').put('s1', { id: 's1', buyerId: 'b1', total: 100 })).resolves.toBeUndefined()
    expect(events).toHaveLength(1)
  })
})

interface Pdf extends Record<string, unknown> { id: string; body: string; date: string }
interface Meta extends Record<string, unknown> { len: number; asOf: string }

describe('frozen-output rule (#637) — vault.deriveAll()', () => {
  it('one frozen output row is skipped; the rest still process; deriveAll does not abort', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'frozen-deriveall-passphrase-2026',
      derivationStrategies: [withDerivation({
        source: 'pdfs',
        deterministic: true,
        outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
        derive: (s: Pdf) => ({ meta: { len: s.body.length, asOf: s.date } }),
        lifecycle: 'eager',
      })],
      periodsStrategy: withPeriods(),
    })
    const vault = await db.openVault('demo')
    const pdfs = vault.collection<Pdf>('pdfs')

    await pdfs.put('p1', { id: 'p1', body: 'a', date: '2026-01-15' })
    await pdfs.put('p2', { id: 'p2', body: 'bb', date: '2026-06-01' })
    // First run establishes the historical output — no period closed yet.
    await vault.deriveAll('pdfs')
    expect(await vault.collection<Meta>('pdf-meta').get('p1')).toMatchObject({ len: 1 })

    await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'asOf' })

    const events: DerivationSkippedFrozen[] = []
    db.on('derivation:skipped-frozen', (e) => events.push(e))

    // A second bulk recompute must NOT throw / abort even though p1's output is now frozen.
    const result = await vault.deriveAll('pdfs')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      source: { collection: 'pdfs', id: 'p1' },
      target: { collection: 'pdf-meta', id: 'p1' },
      period: 'FY2026-Q1',
    })

    // p1's output UNCHANGED despite p1's derive() having re-run this pass.
    expect(await vault.collection<Meta>('pdf-meta').get('p1')).toMatchObject({ len: 1 })
    // p2 (open period) still processed in the SAME bulk call.
    expect(await vault.collection<Meta>('pdf-meta').get('p2')).toMatchObject({ len: 2 })
    expect(result.derived).toBeGreaterThanOrEqual(1)
  })
})

interface Item extends Record<string, unknown> { id: string; tag: string; asOf: string }

describe('frozen-output rule (#637) — vault.refreshView()', () => {
  it('one frozen row is skipped; the rest still write; refreshView does not abort', async () => {
    const mv = withMaterializedView<Item>({
      name: 'all-items',
      query: (db) => db.collection<Item>('items').query(),
      rowKey: (r) => r.id,
      refresh: 'manual',
    })
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'frozen-refreshview-passphrase-2026',
      materializedViewStrategies: [mv],
      periodsStrategy: withPeriods(),
    })
    const vault = await db.openVault('demo')
    const items = vault.collection<Item>('items')
    await items.put('a', { id: 'a', tag: 'red', asOf: '2026-01-15' })
    await items.put('b', { id: 'b', tag: 'blue', asOf: '2026-06-01' })

    await vault.refreshView('all-items') // baseline materialize — no closed period yet
    const beforeA = await vault.collection<Item>('all-items').get('a')
    expect(beforeA).not.toBeNull()

    await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'asOf' })

    const events: DerivationSkippedFrozen[] = []
    db.on('derivation:skipped-frozen', (e) => events.push(e))

    const result = await vault.refreshView('all-items') // must not throw
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ target: { collection: 'all-items', id: 'a' }, period: 'FY2026-Q1' })
    expect(result.written).toBe(1) // only 'b' actually written this pass
    expect(result.failed).toBe(0) // a deliberate skip is not a failure
    expect(await vault.collection<Item>('all-items').get('a')).toEqual(beforeA) // unchanged
    expect(await vault.collection<Item>('all-items').get('b')).not.toBeNull()
  })
})

describe('frozen-output rule (#637) — the sync dispatch wave (#638 Task 5 review mandate)', () => {
  it('one frozen rollup target + one healthy derivation target in the SAME pull: pull succeeds, healthy target recomputes, frozen target skipped + event emitted', async () => {
    const derivation = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s: Pdf) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    })
    const remote = memory()
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), encrypt: false })
    const dbB = await createNoydb({
      store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), encrypt: false,
      derivationStrategies: [totalSpentRollup(), derivation],
      periodsStrategy: withPeriods(),
    })

    const vA = await dbA.openVault('demo')
    await vA.collection<Buyer>('buyers').put('b1', { id: 'b1', asOf: '2026-01-15' })
    await dbA.push('demo')

    const vB = await dbB.openVault('demo')
    vB.collection<Buyer>('buyers'); vB.collection<Sale>('sales'); vB.collection<Pdf>('pdfs')
    await dbB.pull('demo') // seed b1 locally on dbB

    await vB.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'asOf' })

    const events: DerivationSkippedFrozen[] = []
    dbB.on('derivation:skipped-frozen', (e) => events.push(e))

    // Same push batch: a rollup child (its recompute target is frozen) + an unrelated,
    // perfectly healthy derivation source.
    await vA.collection<Sale>('sales').put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await vA.collection<Pdf>('pdfs').put('doc1', { id: 'doc1', body: 'hello', date: '' })
    await dbA.push('demo')

    await expect(dbB.pull('demo')).resolves.toBeTruthy() // must not throw / abort the pull

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      source: { collection: 'sales', id: 's1' },
      target: { collection: 'buyers', id: 'b1' },
      period: 'FY2026-Q1',
    })

    // Frozen target unchanged (recompute skipped).
    expect((await vB.collection<Buyer>('buyers').get('b1'))?.totalSpent).toBeUndefined()
    // Co-batched healthy target still recomputed — not starved by the frozen one.
    expect(await vB.collection<{ len: number } & Record<string, unknown>>('pdf-meta').get('doc1')).toMatchObject({ len: 5 })

    dbA.close(); dbB.close()
  })

  it('a non-PeriodClosedError throw from one touched record is isolated per-id, not aborting the wave — surfaced via console.warn, not silently swallowed', async () => {
    const flaky = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s: Pdf) => { if (s.id === 'bad') throw new Error('boom — synthetic derive() failure'); return { meta: { len: s.body.length } } },
      lifecycle: 'eager',
      strict: true, // makes the failure propagate OUT of dispatchDerivations instead of being logged-and-skipped internally
    })
    const remote = memory()
    const dbA = await createNoydb({ store: memory(), sync: remote, user: 'user-a', syncStrategy: withSync(), encrypt: false })
    const dbB = await createNoydb({
      store: memory(), sync: remote, user: 'user-b', syncStrategy: withSync(), encrypt: false,
      derivationStrategies: [flaky],
    })

    const vA = await dbA.openVault('demo')
    const vB = await dbB.openVault('demo')
    vB.collection<Pdf>('pdfs')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await vA.collection<Pdf>('pdfs').put('bad', { id: 'bad', body: 'x', date: '' })
    await vA.collection<Pdf>('pdfs').put('good', { id: 'good', body: 'hello', date: '' })
    await dbA.push('demo')

    await expect(dbB.pull('demo')).resolves.toBeTruthy() // must not throw despite 'bad' failing

    expect(await vB.collection<{ len: number } & Record<string, unknown>>('pdf-meta').get('good')).toMatchObject({ len: 5 })
    expect(await vB.collection<{ len: number } & Record<string, unknown>>('pdf-meta').get('bad')).toBeNull()
    expect(warnSpy).toHaveBeenCalled() // surfaced — not silently swallowed

    warnSpy.mockRestore()
    dbA.close(); dbB.close()
  })
})
