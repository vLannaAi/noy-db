/**
 * Showcase 07 — withHistory()
 *
 * What you'll learn
 * ─────────────────
 * Opt into the history strategy and every put/delete writes an
 * entry to a hash-chained ledger. `vault.ledger().verify()` walks
 * the chain and detects any tampering between entries.
 *
 * Why it matters
 * ──────────────
 * Audit trails are the difference between "we think nothing changed"
 * and "we can prove it." The ledger is also the seat of multi-writer
 * correctness (optimistic-CAS retry on the chain head) and of
 * tamper detection on backup restores.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 01.
 *
 * What to read next
 * ─────────────────
 *   - showcase 17-with-history-time-machine (`vault.at(t)`)
 *   - showcase 21-with-bundle (`.noydb` archive embedding ledger head)
 *   - docs/subsystems/history.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → history
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withHistory } from '@noy-db/hub/history'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 07 — withHistory()', () => {
  it('records every put on the ledger and the chain verifies', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-history-passphrase-2026',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    await notes.put('n1', { id: 'n1', text: 'first version' })
    await notes.put('n1', { id: 'n1', text: 'second version' })
    await notes.put('n1', { id: 'n1', text: 'third version' })

    const ledger = vault.ledger()
    const entries = await ledger.entries()
    expect(entries).toHaveLength(3)
    expect(entries.every((e) => e.op === 'put')).toBe(true)
    expect(entries.every((e) => e.collection === 'notes' && e.id === 'n1')).toBe(true)

    const result = await ledger.verify()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.length).toBe(3)
    db.close()
  })

  it('without withHistory() opted in, vault.ledger() throws', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-history-passphrase-2026',
      // No historyStrategy.
    })
    const vault = await db.openVault('demo')
    expect(() => vault.ledger()).toThrow(/history/)
    db.close()
  })

  // ── Per-collection scoping (#361) ────────────────────────────────────
  // History is all-or-nothing vault-wide by default. When tamper-evidence
  // only matters on a few collections (e.g. filed legal records), confine
  // snapshots + ledger to those, and let high-churn operational collections
  // opt out — no per-record snapshot, no ledger entry per write.
  it('confines snapshots + tamper-ledger to the collections that need them', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-history-passphrase-2026',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('firm')

    // Filed receipts: full audit (default — snapshots + ledger).
    const receipts = vault.collection<Note>('receipts')
    // Scratchpad: no snapshots, no ledger entries.
    const scratch = vault.collection<Note>('scratch', {
      historyConfig: { enabled: false, ledger: false },
    })

    await receipts.put('r1', { id: 'r1', text: 'v1' })
    await receipts.put('r1', { id: 'r1', text: 'v2' })
    await scratch.put('s1', { id: 's1', text: 'draft' })
    await scratch.put('s1', { id: 's1', text: 'draft 2' })

    // Only the receipts collection appears on the tamper chain…
    const entries = await vault.ledger().entries()
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.collection === 'receipts')).toBe(true)

    // …and the chain still verifies end-to-end.
    const result = await vault.ledger().verify()
    expect(result.ok).toBe(true)
    db.close()
  })
})
