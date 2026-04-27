/**
 * Showcase 37 — in-vue (Vue 3 composables)
 *
 * What you'll learn
 * ─────────────────
 * `useCollection(vault, name)` returns reactive Vue refs (`records`,
 * `loading`, `error`) that re-render on every put/delete/CRDT update.
 * The composable wires `vault.collection().subscribe()` into a Vue
 * `effectScope`, so unmounted components clean up automatically.
 *
 * Why it matters
 * ──────────────
 * The first consumer (a Pilot accounting platform) is Vue 3 + Pinia.
 * Reactive collections without writing manual `.subscribe()` plumbing
 * is the primary developer ergonomic.
 *
 * Prerequisites
 * ─────────────
 * - Showcases 00-06.
 *
 * What to read next
 * ─────────────────
 *   - showcase 38-in-pinia (defineNoydbStore — same data through a Pinia store)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-vue
 */

import { describe, it, expect } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { createNoydb } from '@noy-db/hub'
import { useCollection } from '@noy-db/in-vue'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 37 — in-vue', () => {
  it('useCollection emits records after put and updates reactively', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'in-vue-pass-2026' })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')
    await notes.put('a', { id: 'a', text: 'hello' })

    // Wrap the composable in an effectScope so cleanup is deterministic.
    const scope = effectScope()
    let snapshot: { data: readonly Note[]; loading: boolean } = { data: [], loading: true }
    scope.run(() => {
      const { data, loading } = useCollection<Note>(db, 'demo', 'notes')
      // Track each tick.
      Object.defineProperty(snapshot, 'data', { get: () => data.value })
      Object.defineProperty(snapshot, 'loading', { get: () => loading.value })
    })

    await nextTick()
    await new Promise((r) => setTimeout(r, 30))

    expect(snapshot.loading).toBe(false)
    expect(snapshot.data.map((r) => r.id)).toEqual(['a'])

    // Reactivity: a put propagates without manual refetch.
    await notes.put('b', { id: 'b', text: 'world' })
    await new Promise((r) => setTimeout(r, 30))

    expect(snapshot.data.map((r) => r.id).sort()).toEqual(['a', 'b'])

    scope.stop()
    db.close()
  })
})
