/**
 * Showcase 83 — withOverlayedView (Dim 14 v2)
 *
 * What you'll learn
 * ─────────────────
 * `withOverlayedView` projects a virtual collection that merges a base
 * (typically an MV's output) with an operator-editable overlay. A
 * single-field shadow predicate decides whether a given id reads from
 * the overlay or falls back to the base.
 *
 * The canonical example: a tax-period roll-up MV produces the
 * "computed" answer, but the regulated-domain consumer needs an
 * operator override path for exceptional cases (an accountant marks a
 * row as `dataStatus: 'override'` and edits the amount). The MV stays
 * deterministic; the override path stays explicit and auditable.
 *
 *   1. **No overlay row → returns base** — `vault.collection(name).get(id)`
 *      falls through to the base collection when no overlay row exists.
 *   2. **Overlay row with shadow predicate true → returns overlay** —
 *      `overlay[shadowField] === shadowValue` flips the read to overlay.
 *   3. **Overlay row with shadow predicate false → still returns base**
 *      — an overlay row with `dataStatus: 'computed'` is silently
 *      ignored by the virtual layer (you'd see it only by reading the
 *      overlay collection directly).
 *   4. **`OverlayIdMismatchError`** — writes through the virtual proxy
 *      check that the record's identity matches the requested id.
 *
 * Why it matters
 * ──────────────
 * Without overlays, "operator can edit this MV row" forces consumers
 * into either (a) abandoning the MV (lose determinism) or (b) writing
 * sentinel rows back to the source (lose provenance). Overlay split
 * keeps both paths honest: the MV is always recomputable; the override
 * is always identifiable by `dataStatus`.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 81 (eager MV mechanics).
 *
 * What to read next
 * ─────────────────
 *   - docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md § Composition with operator-editable lifecycle
 *   - docs/subsystems/derivations.md § Overlay views
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → overlay-views
 */

import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  withMaterializedView,
  withOverlayedView,
  OverlayIdMismatchError,
} from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Compensation extends Record<string, unknown> {
  id: string
  clientId: string
  amount: number
}

interface Pnd1Row extends Record<string, unknown> {
  clientId: string
  amount: number
  // Optional shadow field on the merged read shape.
  dataStatus?: 'computed' | 'override'
}

// Base MV: 1-row-per-source projection. The MV's output collection is
// `pnd1-aggregate`; the overlay virtualizes it as `pnd1`.
const pnd1Aggregate = withMaterializedView<Pnd1Row>({
  name: 'pnd1-aggregate',
  query: (db) => db.collection<Compensation>('compensations').query(),
  rowKey: (row) => row.clientId,
  refresh: 'eager',
})

const pnd1Overlay = withOverlayedView({
  name: 'pnd1',
  base: 'pnd1-aggregate',
  overlay: 'pnd1-overlay',
  shadowField: 'dataStatus',
  shadowValue: 'override',
})

async function open(passphrase: string) {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: passphrase,
    materializedViewStrategies: [pnd1Aggregate],
    overlayedViewStrategies: [pnd1Overlay],
  })
  const vault = await db.openVault('books')
  return { db, vault }
}

describe('Showcase 83 — withOverlayedView', () => {
  it('reads through to base when no overlay row exists', async () => {
    const { vault } = await open('showcase-83-base-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('acme', {
      id: 'acme', clientId: 'acme', amount: 100,
    })
    const row = await vault.collection<Pnd1Row>('pnd1').get('acme')
    expect(row?.amount).toBe(100)
  })

  it('returns the overlay row when shadow predicate matches', async () => {
    const { vault } = await open('showcase-83-override-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('acme', {
      id: 'acme', clientId: 'acme', amount: 100,
    })
    // Operator-recorded override: explicit dataStatus + edited amount.
    await vault.collection<Pnd1Row>('pnd1-overlay').put('acme', {
      clientId: 'acme', amount: 99999, dataStatus: 'override',
    })
    const row = await vault.collection<Pnd1Row>('pnd1').get('acme')
    expect(row?.amount).toBe(99999)
    expect(row?.dataStatus).toBe('override')
  })

  it('falls back to base when overlay row has shadow predicate false', async () => {
    const { vault } = await open('showcase-83-orphaned-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('acme', {
      id: 'acme', clientId: 'acme', amount: 100,
    })
    // Overlay row exists but dataStatus is 'computed', not 'override' —
    // virtual layer ignores it. (Useful state for drafts/staging.)
    await vault.collection<Pnd1Row>('pnd1-overlay').put('acme', {
      clientId: 'acme', amount: 99999, dataStatus: 'computed',
    })
    const row = await vault.collection<Pnd1Row>('pnd1').get('acme')
    expect(row?.amount).toBe(100)
  })

  it('writes through the virtual proxy route to the overlay collection', async () => {
    const { vault } = await open('showcase-83-write-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('acme', {
      id: 'acme', clientId: 'acme', amount: 100,
    })
    await vault.collection<Pnd1Row>('pnd1').put('acme', {
      clientId: 'acme', amount: 50000, dataStatus: 'override',
    })
    // The write landed on the overlay collection; the base is untouched.
    expect((await vault.collection<Pnd1Row>('pnd1-overlay').get('acme'))?.amount).toBe(50000)
    expect((await vault.collection<Pnd1Row>('pnd1-aggregate').get('acme'))?.amount).toBe(100)
    // And the merged read reflects the override.
    expect((await vault.collection<Pnd1Row>('pnd1').get('acme'))?.amount).toBe(50000)
  })

  it('throws OverlayIdMismatchError when the put id and rowKey disagree', async () => {
    // Overlay base has a rowKey, so writes through the virtual proxy
    // must agree on identity. Mismatch is caught at the proxy layer.
    const { vault } = await open('showcase-83-mismatch-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('acme', {
      id: 'acme', clientId: 'acme', amount: 100,
    })
    // Force an in-memory load on the MV by reading once, so the rowKey
    // is wired up consistently before we attempt the mismatched write.
    await vault.collection<Pnd1Row>('pnd1').get('acme')
    await expect(
      vault.collection<Pnd1Row>('pnd1').put('acme', {
        clientId: 'globex',  // ← disagrees with id 'acme'
        amount: 1, dataStatus: 'override',
      }),
    ).rejects.toThrow(OverlayIdMismatchError)
  })
})
