/**
 * Showcase 15 — withSync()
 *
 * What you'll learn
 * ─────────────────
 * Two independent Noydb instances, each with its own local store,
 * converge on a shared remote store via `noydb.push()` and
 * `noydb.pull()`. Conflict policy at the strategy level decides
 * how concurrent writes resolve (`'version'` = last-write-wins by
 * `_v`, `'local-wins'` = keep the local copy on conflict, etc.).
 *
 * Why it matters
 * ──────────────
 * "Offline-first" is a promise; sync is the mechanic that makes
 * that promise survive when more than one device exists. The hub's
 * sync engine is independent of transport — pair it with cloud,
 * USB, BroadcastChannel (planned), or WebRTC (`@noy-db/p2p`).
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 01.
 *
 * What to read next
 * ─────────────────
 *   - showcase 14-with-crdt (CRDT updates flow through sync)
 *   - docs/subsystems/sync.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → sync
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withSync } from '@noy-db/hub/sync'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 15 — withSync()', () => {
  it('two local stores converge on a shared remote via push + pull', async () => {
    const PASS = 'with-sync-passphrase-2026'

    // Shared remote (think: cloud DynamoDB / S3 / a synced file dir).
    const remote = memory()

    // Office A — its own local store, configured to push/pull against
    // the remote.
    const dbA = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: PASS,
      encrypt: false, // simplifies cross-instance verification in this showcase
      syncStrategy: withSync(),
      sync: { store: remote, role: 'sync-peer' },
    })
    await dbA.openVault('shared')
    const notesA = (await dbA.openVault('shared')).collection<Note>('notes')

    // Office B — same shape against the same remote.
    const dbB = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: PASS,
      encrypt: false,
      syncStrategy: withSync(),
      sync: { store: remote, role: 'sync-peer' },
    })
    const notesB = (await dbB.openVault('shared')).collection<Note>('notes')

    // A writes locally, then pushes to remote. Collection.put dispatches
    // dirty-tracking via a microtask, so let it settle before push.
    await notesA.put('a', { id: 'a', text: 'from office A' })
    await new Promise((r) => setTimeout(r, 0))
    await dbA.push('shared')

    // B pulls from remote, sees A's record.
    await dbB.pull('shared')
    expect(await notesB.get('a')).toEqual({ id: 'a', text: 'from office A' })

    dbA.close()
    dbB.close()
  })
})
