/**
 * Showcase 55 — Storage: meter (drop-in metrics wrapper)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-meter` wraps any `NoydbStore` and times every call,
 * counting hits, errors, and CAS conflicts per method (`get`, `put`,
 * `delete`, `list`, `loadAll`, `saveAll`). The wrapped store is a
 * drop-in for the inner one — same six methods, same semantics on
 * success and failure — and the `meter.snapshot()` handle gives you
 * latency percentiles plus a `degraded | restored` event stream.
 *
 * Why it matters
 * ──────────────
 * NOYDB never sees the network — encryption happens *before* a store
 * is touched. That makes per-store telemetry the only signal an
 * adopter has for "is the backend slow?" or "did writes start
 * failing at 14:00?". `to-meter` is the sanctioned way to capture
 * that signal without forking the store.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 01 (`to-memory` baseline).
 *
 * What to read next
 * ─────────────────
 *   - showcase 56-storage-probe (capacity / suitability check)
 *   - docs/packages/stores.md → "to-meter" entry
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-meter
 */

import { describe, expect, it } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { toMeter } from '@noy-db/to-meter'

interface Note { id: string; text: string }

describe('Showcase 55 — Storage: meter (drop-in metrics wrapper)', () => {
  it('counts every method call without changing semantics', async () => {
    const inner = memory()
    const { store, meter } = toMeter(inner)
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-meter-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'first' })
    await notes.put('b', { id: 'b', text: 'second' })
    await notes.get('a')
    await notes.list()

    const snapshot = meter.snapshot()
    expect(snapshot.byMethod.put.count).toBeGreaterThanOrEqual(2)
    expect(snapshot.byMethod.get.count).toBeGreaterThanOrEqual(1)
    expect(snapshot.byMethod.list.count).toBeGreaterThanOrEqual(1)

    // Behaviour identical to the unwrapped store.
    expect(await notes.get('a')).toEqual({ id: 'a', text: 'first' })

    db.close()
    meter.close()
  })

  it('snapshots expose latency percentiles per method', async () => {
    const { store, meter } = toMeter(memory())
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-meter-perf-2026',
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    // 50 puts gives the meter enough samples to compute non-zero p50/p99.
    for (let i = 0; i < 50; i++) {
      await notes.put(`r-${i}`, { id: `r-${i}`, text: `record ${i}` })
    }

    const snap = meter.snapshot()
    expect(snap.byMethod.put.count).toBeGreaterThanOrEqual(50)
    // Memory store is fast but never quite zero — assert the structure exists.
    expect(snap.byMethod.put.p50).toBeTypeOf('number')
    expect(snap.byMethod.put.p99).toBeTypeOf('number')

    db.close()
    meter.close()
  })

  it('reset() clears counters without disturbing the wrapped store', async () => {
    const { store, meter } = toMeter(memory())
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-meter-reset-2026',
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    await notes.put('keep', { id: 'keep', text: 'preserved' })
    expect(meter.snapshot().byMethod.put.count).toBeGreaterThanOrEqual(1)

    meter.reset()
    // Counters are zero after reset, but the underlying record is still there.
    expect(meter.snapshot().byMethod.put.count).toBe(0)
    expect(await notes.get('keep')).toEqual({ id: 'keep', text: 'preserved' })

    db.close()
    meter.close()
  })
})
