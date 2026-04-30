/**
 * Showcase 38 — in-pinia (defineNoydbStore)
 *
 * What you'll learn
 * ─────────────────
 * `defineNoydbStore('id', { vault, collection })` returns a Pinia store
 * factory whose state mirrors the noy-db collection. The store exposes
 * `items` (reactive list), `add(id, record)`, `update`, `remove`, plus
 * the live `query()` / `liveQuery()` shortcuts. External
 * `collection.put()` calls flow back into the store's reactive state
 * via subscribe.
 *
 * Why it matters
 * ──────────────
 * Pinia is the de-facto Vue state manager. Pairing it with noy-db means
 * encrypted persistence is one `defineNoydbStore` call away — no
 * manual hydration, no manual sync.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 37-in-vue.
 *
 * What to read next
 * ─────────────────
 *   - showcase 41-in-react (same idea for React)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-pinia
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { createNoydb } from '@noy-db/hub'
import { defineNoydbStore, setActiveNoydb } from '@noy-db/in-pinia'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 38 — in-pinia', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('defineNoydbStore hydrates from the collection and put round-trips', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'in-pinia-pass-2026' })
    setActiveNoydb(db)
    const vault = await db.openVault('demo')
    await vault.collection<Note>('notes').put('a', { id: 'a', text: 'seed' })

    const useNotes = defineNoydbStore<Note>('notes', { vault: 'demo', collection: 'notes' })
    const store = useNotes()

    // Wait for the store's hydration promise.
    await store.$ready

    expect(store.items.map((r: Note) => r.id)).toEqual(['a'])

    // The store action persists through the encrypted boundary.
    await store.add('b', { id: 'b', text: 'via store' })

    expect(await vault.collection<Note>('notes').get('b')).toEqual({ id: 'b', text: 'via store' })

    db.close()
  })
})
