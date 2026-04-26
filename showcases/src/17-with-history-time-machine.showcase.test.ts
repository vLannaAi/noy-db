/**
 * Showcase 17 — withHistory() time-machine reads (`vault.at(t)`)
 *
 * What you'll learn
 * ─────────────────
 * Once history is opted in, every put is recorded with a timestamp
 * on the ledger. `vault.at(timestamp)` returns a `VaultInstant`
 * whose collections read state-as-of that instant. Reads are async
 * because the engine walks the ledger to reconstruct the past.
 *
 * Why it matters
 * ──────────────
 * "What did the data look like on Jan 15 at 09:00?" is the
 * accountant's, the auditor's, and the lawyer's question. Time-
 * machine reads answer it directly without the cost of full version
 * snapshots — the ledger's deltas are the recipe.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 07 (history basics + ledger).
 *
 * What to read next
 * ─────────────────
 *   - showcase 18-with-periods (close a period, reads pinned to it)
 *   - docs/subsystems/history.md (`vault.at` section)
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Showcase 17 — withHistory() time-machine reads', () => {
  it('vault.at(timestamp) returns the prior state of a record', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'time-machine-passphrase-2026',
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'first' })
    await sleep(10)
    const tFirst = new Date()
    await sleep(10)
    await notes.put('a', { id: 'a', text: 'second' })
    await sleep(10)
    await notes.put('a', { id: 'a', text: 'third' })

    // Live reads see the latest version.
    expect(await notes.get('a')).toEqual({ id: 'a', text: 'third' })

    // Time-machine read at tFirst sees the version that was current
    // at that instant — "first".
    const past = vault.at(tFirst)
    const pastNotes = past.collection<Note>('notes')
    expect(await pastNotes.get('a')).toEqual({ id: 'a', text: 'first' })

    db.close()
  })
})
