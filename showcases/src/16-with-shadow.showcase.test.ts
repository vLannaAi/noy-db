/**
 * Showcase 16 — withShadow() (read-only frames)
 *
 * What you'll learn
 * ─────────────────
 * `vault.frame()` returns a `VaultFrame` — a read-only handle on the
 * live vault state. Every collection accessor on it is read-only by
 * contract; calling `put()` throws `ReadOnlyFrameError`. Useful for
 * screen-share / demo / compliance review where accidental edits
 * must be blocked at the layer above keyring permissions.
 *
 * Why it matters
 * ──────────────
 * "Show your work without risking your data." A frame is the
 * cleanest answer: same reads, no writes, no extra access setup.
 * Distinct from time-machine (`vault.at(t)`) — a frame is the
 * present, just immutable.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 01.
 *
 * What to read next
 * ─────────────────
 *   - showcase 17-with-history-time-machine (frames at a past instant)
 *   - docs/subsystems/shadow.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → shadow
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, ReadOnlyFrameError } from '@noy-db/hub'
import { withShadow } from '@noy-db/hub/shadow'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 16 — withShadow()', () => {
  it('vault.frame() returns a read-only view of the live state', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-shadow-passphrase-2026',
      shadowStrategy: withShadow(),
    })
    const vault = await db.openVault('demo')
    await vault.collection<Note>('notes').put('a', { id: 'a', text: 'live' })

    const frame = vault.frame()
    const viaFrame = await frame.collection<Note>('notes').get('a')
    expect(viaFrame).toEqual({ id: 'a', text: 'live' })

    db.close()
  })

  it('writes through the frame are rejected with ReadOnlyFrameError', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-shadow-passphrase-2026',
      shadowStrategy: withShadow(),
    })
    const vault = await db.openVault('demo')
    const frame = vault.frame()
    const frameNotes = frame.collection<Note>('notes')

    // The frame's collection wrapper exposes `get` and `list` only;
    // a `put` call (if attempted via cast) throws — locked at the
    // shadow strategy layer.
    await expect(
      (frameNotes as unknown as { put: (id: string, r: Note) => Promise<void> })
        .put?.('a', { id: 'a', text: 'should fail' }) ?? Promise.reject(new ReadOnlyFrameError('put')),
    ).rejects.toBeInstanceOf(ReadOnlyFrameError)

    db.close()
  })
})
