/**
 * Showcase 13 — Live queries (always-core today)
 *
 * What you'll learn
 * ─────────────────
 * `query.live()` returns a `LiveQuery<T>` that re-runs whenever any
 * upstream collection (left or any joined right) mutates. Subscribers
 * read `live.value` and listen via `live.subscribe(cb)`. Errors land
 * in `live.error` instead of throwing out of the source's emitter.
 *
 * Why it matters
 * ──────────────
 * Reactive UI bindings (Vue's `useBlobURL`, Pinia's `liveQuery`,
 * React/Solid/Svelte adapters) all build on this primitive. The
 * runtime cost is one re-run per upstream change; for v1 that's
 * acceptable, and the framework adapters debounce as needed.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 01 + 12.
 *
 * What to read next
 * ─────────────────
 *   - the @noy-db/in-pinia liveQuery composable
 *   - docs/subsystems/live.md (`(planned: @noy-db/hub/live)`)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → live
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 13 — Live queries', () => {
  it('re-runs on every upstream put and notifies subscribers', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-live-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    const live = notes.query().live()
    let notifications = 0
    const unsubscribe = live.subscribe(() => { notifications++ })

    expect(live.value).toEqual([])

    await notes.put('a', { id: 'a', text: 'one' })
    await notes.put('b', { id: 'b', text: 'two' })

    // Two writes → two notifications. Each notification reflects the
    // latest snapshot in `live.value`.
    expect(notifications).toBe(2)
    expect(live.value.map((r) => r.id).sort()).toEqual(['a', 'b'])
    expect(live.error).toBeNull()

    unsubscribe()
    live.stop()
    db.close()
  })

  it('stop() tears down upstream subscriptions; later writes do nothing', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-live-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    const live = notes.query().live()
    let notifications = 0
    live.subscribe(() => { notifications++ })

    await notes.put('a', { id: 'a', text: 'one' })
    expect(notifications).toBe(1)

    live.stop()
    await notes.put('b', { id: 'b', text: 'two' })
    expect(notifications).toBe(1) // stop() removed our handler

    db.close()
  })
})
