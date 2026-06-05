/**
 * Showcase 92 — Cross-join query primitive
 *
 * What you'll learn
 * ─────────────────
 * `.crossJoin(target, { as })` produces a cartesian product between two
 * collections in the same vault. Combined with lateral `on:`, `.groupBy()`,
 * and `.aggregate()`, it closes the DERIV-SSO-001 pattern: "for every
 * period, how many workers were active?"
 *
 * Why it matters
 * ──────────────
 * Cross-join is the foundation of period × entity analytics. Without it,
 * a multi-period payroll or coverage report requires N separate queries
 * (one per period) and manual stitching. Cross-join expresses it as a
 * single declarative query that the hub executes after decryption —
 * zero-knowledge to the backend.
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → cross-join
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, CrossJoinTooLargeError } from '@noy-db/hub'
import { withAggregate, count } from '@noy-db/hub/aggregate'
import { memory } from '@noy-db/to-memory'

interface Period {
  id: string
  label: string
  start: string // 'YYYY-MM'
  end: string   // 'YYYY-MM'
}

interface Worker {
  id: string
  name: string
  since: string       // 'YYYY-MM' — first active month
  until: string | null  // 'YYYY-MM' or null (still active)
}

describe('Showcase 92 — Cross-join', () => {
  it('DERIV-SSO-001: for each period, counts active workers via lateral on:', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'cross-join-showcase-2026',
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('payroll')
    const periods = vault.collection<Period>('periods')
    const workers = vault.collection<Worker>('workers')

    await periods.put('q1', { id: 'q1', label: 'Q1 2026', start: '2026-01', end: '2026-03' })
    await periods.put('q2', { id: 'q2', label: 'Q2 2026', start: '2026-04', end: '2026-06' })
    await periods.put('q3', { id: 'q3', label: 'Q3 2026', start: '2026-07', end: '2026-09' })

    // Alice: active the whole year
    await workers.put('alice', { id: 'alice', name: 'Alice', since: '2026-01', until: null })
    // Bob: joined Q1, left end of Q2 (until='2026-06' covers Q2 end)
    await workers.put('bob',   { id: 'bob',   name: 'Bob',   since: '2026-01', until: '2026-06' })
    // Carol: started Q3 only
    await workers.put('carol', { id: 'carol', name: 'Carol', since: '2026-07', until: null })

    // Worker is "active in period" if: worker.since <= period.start AND
    // (worker.until === null OR worker.until >= period.end)
    const result = await periods.query()
      .crossJoin<Worker, 'worker'>('workers', {
        as: 'worker',
        on: (period) => (worker) =>
          worker.since <= period.start &&
          (worker.until === null || worker.until >= period.end),
      })
      .groupBy('id')
      .aggregate({ workerCount: count() })
      .run()

    // Sort by id for determinism
    result.sort((a: any, b: any) => a.id.localeCompare(b.id))

    // Q1 start='2026-01' end='2026-03': Alice (since 01 <= 01, until null ✓); Bob (since 01 <= 01, until 06 >= 03 ✓) → 2
    // Q2 start='2026-04' end='2026-06': Alice ✓; Bob (since 01 <= 04, until 06 >= 06 ✓); Carol (since 07 > 04 ✗) → 2
    // Q3 start='2026-07' end='2026-09': Alice ✓; Bob (until 06 < 09 ✗); Carol (since 07 <= 07, until null ✓) → 2
    expect(result).toHaveLength(3)
    const byId = Object.fromEntries((result as any[]).map((r: any) => [r.id, r.workerCount]))
    expect(byId['q1']).toBe(2)
    expect(byId['q2']).toBe(2)
    expect(byId['q3']).toBe(2)
  })

  it('full cartesian: every period × every worker (no lateral filter)', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'cross-join-full-cartesian-2026',
    })
    const vault = await db.openVault('demo')
    const periods = vault.collection<Period>('periods')
    const workers = vault.collection<Worker>('workers')

    await periods.put('p1', { id: 'p1', label: 'Jan', start: '2026-01', end: '2026-01' })
    await periods.put('p2', { id: 'p2', label: 'Feb', start: '2026-02', end: '2026-02' })
    await workers.put('w1', { id: 'w1', name: 'Alice', since: '2026-01', until: null })
    await workers.put('w2', { id: 'w2', name: 'Bob',   since: '2026-01', until: null })

    const rows = await periods.query()
      .crossJoin<Worker, 'worker'>('workers', { as: 'worker' })
      .toArray()

    expect(rows).toHaveLength(4) // 2 × 2
    expect(rows.every((r: any) => r.worker !== undefined)).toBe(true)
  })

  it('where() before crossJoin filters left side (cheaper than post-filter)', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'cross-join-pre-filter-2026',
    })
    const vault = await db.openVault('demo')
    const periods = vault.collection<Period>('periods')
    const workers = vault.collection<Worker>('workers')

    await periods.put('p1', { id: 'p1', label: 'Q1', start: '2026-01', end: '2026-03' })
    await periods.put('p2', { id: 'p2', label: 'Q2', start: '2026-04', end: '2026-06' })
    await workers.put('w1', { id: 'w1', name: 'Alice', since: '2026-01', until: null })
    await workers.put('w2', { id: 'w2', name: 'Bob',   since: '2026-01', until: null })

    const rows = await periods.query()
      .where('id', '==', 'p1')
      .crossJoin<Worker, 'worker'>('workers', { as: 'worker' })
      .toArray()

    expect(rows).toHaveLength(2) // 1 period × 2 workers
    expect(rows.every((r: any) => r.id === 'p1')).toBe(true)
  })

  it('CrossJoinTooLargeError fires when product exceeds ceiling', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'cross-join-ceiling-2026',
    })
    const vault = await db.openVault('demo')
    const periods = vault.collection<Period>('periods')
    const workers = vault.collection<Worker>('workers')

    // 260 × 200 = 52,000 > 50,000 default ceiling
    const periodPuts = Array.from({ length: 260 }, (_, i) =>
      periods.put(`p${i}`, { id: `p${i}`, label: `P${i}`, start: '2026-01', end: '2026-01' })
    )
    const workerPuts = Array.from({ length: 200 }, (_, i) =>
      workers.put(`w${i}`, { id: `w${i}`, name: `W${i}`, since: '2026-01', until: null })
    )
    await Promise.all([...periodPuts, ...workerPuts])

    const q = periods.query().crossJoin('workers', { as: 'worker' })
    expect(() => q.toArray()).toThrow(CrossJoinTooLargeError)
  })
})
