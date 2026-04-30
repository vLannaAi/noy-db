/**
 * Showcase 43 — in-zustand (StateCreator factory)
 *
 * What you'll learn
 * ─────────────────
 * `createNoydbStore(() => collection)` returns a Zustand `StateCreator`
 * — pass it to `createStore` (vanilla) or `create` (React). The
 * resulting store carries `records`, `loading`, `error`, plus action
 * thunks `put` and `delete` that go through the encrypted boundary.
 *
 * Why it matters
 * ──────────────
 * Zustand is the third-most-popular React state library after Context
 * and Redux. The vanilla store flavour also makes it framework-free,
 * which suits the Pilot platform's mixed React/Vue surface.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 06-multi-user.
 *
 * What to read next
 * ─────────────────
 *   - showcase 44-in-tanstack-query (server-state library)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-zustand
 */

import { describe, it, expect } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createNoydb } from '@noy-db/hub'
import { createNoydbStore, type NoydbZustandSlice } from '@noy-db/in-zustand'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 43 — in-zustand', () => {
  it('createNoydbStore hydrates and put goes through the collection', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'in-zustand-pass-2026' })
    const vault = await db.openVault('demo')
    const coll = vault.collection<Note>('notes')
    await coll.put('a', { id: 'a', text: 'seed' })

    const zs = createStore<NoydbZustandSlice<Note>>(createNoydbStore(() => coll))

    // Wait for the initial hydration to flip loading off.
    await new Promise<void>((resolve) => {
      if (!zs.getState().loading) return resolve()
      const unsub = zs.subscribe((s) => {
        if (!s.loading) { unsub(); resolve() }
      })
    })

    expect(Object.keys(zs.getState().records)).toEqual(['a'])

    await zs.getState().put('b', { id: 'b', text: 'via store' })
    expect(await coll.get('b')).toEqual({ id: 'b', text: 'via store' })

    db.close()
  })
})
