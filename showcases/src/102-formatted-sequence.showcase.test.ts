/**
 * Showcase 102 — formatted sequences (fiscal numbering)
 *
 * What you'll learn
 * ─────────────────
 * `vault.sequence(series, { partition, format })` emits a human/fiscal
 * serial STRING (`2026/0001`), not a bare integer. The counter stays
 * gap-free and atomic; the `format` template just renders it. Per-year
 * reset is inherent: partition the counter by year and a new year starts
 * back at `0001`.
 *
 *   - `next()` returns `{ serial, formatted }` when a format is set.
 *   - `{seq:04}` zero-pads; `{partition.i}` injects a partition component.
 *   - partition: [2026] and partition: [2027] are independent counters.
 *
 * Why it matters
 * ──────────────
 * Legal invoice/DDT numbering (e.g. Italian fatture: `2026/0001`,
 * per-year reset) is otherwise hand-formatted in userland — the place
 * where off-by-one and reset bugs hide. Declaring the pattern at the
 * counter keeps the serial gap-free AND correctly shaped in one call.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00.
 *
 * What to read next
 * ─────────────────
 *   - docs/services/ (atomic-sequence) — the underlying counter
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → atomic-sequence
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

describe('Showcase 102 — formatted sequences', () => {
  it('numbers per-year invoices 2026/0001… and resets at 2027/0001', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'formatted-sequence-showcase-2026',
    })
    const vault = await db.openVault('firm')

    const fatture2026 = vault.sequence('fatture', {
      partition: [2026],
      format: '{partition.0}/{seq:04}',
    })

    const a = await fatture2026.next()
    const b = await fatture2026.next()
    expect(a).toEqual({ serial: 1, formatted: '2026/0001' })
    expect(b).toEqual({ serial: 2, formatted: '2026/0002' })

    // New fiscal year — an independent counter, reset to 0001.
    const fatture2027 = vault.sequence('fatture', {
      partition: [2027],
      format: '{partition.0}/{seq:04}',
    })
    expect((await fatture2027.next()).formatted).toBe('2027/0001')

    // 2026 continues unaffected.
    expect((await fatture2026.next()).formatted).toBe('2026/0003')

    db.close()
  })

  it('peek reads the underlying integer; the serial stays gap-free', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'formatted-sequence-showcase-2026',
    })
    const vault = await db.openVault('firm')
    const seq = vault.sequence('ddt', { format: 'DDT-{seq:05}' })

    expect(await seq.peek()).toBe(0)
    expect((await seq.next()).formatted).toBe('DDT-00001')
    expect((await seq.next()).formatted).toBe('DDT-00002')
    expect(await seq.peek()).toBe(2)

    db.close()
  })
})
