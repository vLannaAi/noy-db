/**
 * Showcase 40 — in-svelte (zero-dep Svelte stores)
 *
 * What you'll learn
 * ─────────────────
 * `collectionStore(vault, name)` returns a `Readable<{ records, loading,
 * error }>` that satisfies Svelte's store contract — `subscribe`,
 * stable cleanup. Zero dependency on Svelte runtime: the contract is
 * just the `subscribe(fn) => unsub` shape, so the package works in
 * SvelteKit, plain Svelte, and any consumer that follows the contract.
 *
 * Why it matters
 * ──────────────
 * Svelte's store pattern is its primary state primitive. Adapting the
 * noy-db subscribe surface to it keeps the integration tiny — the
 * package ships zero deps.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 06-multi-user (collection put/delete).
 *
 * What to read next
 * ─────────────────
 *   - showcase 41-in-react (same shape via React hooks)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-svelte
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { collectionStore } from '@noy-db/in-svelte'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 40 — in-svelte', () => {
  it('collectionStore hydrates and re-emits on put', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'in-svelte-pass-2026' })
    const vault = await db.openVault('demo')
    const coll = vault.collection<Note>('notes')
    await coll.put('a', { id: 'a', text: 'seed' })

    const store = collectionStore<Note>(vault, 'notes')
    const snapshots: Array<readonly Note[]> = []
    const unsub = store.subscribe((s) => snapshots.push(s.records))

    // Drain microtasks so the initial hydration lands.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    await coll.put('b', { id: 'b', text: 'second' })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    unsub()
    store.stop()

    const finalIds = snapshots[snapshots.length - 1]!.map((r) => r.id).sort()
    expect(finalIds).toEqual(['a', 'b'])
    db.close()
  })
})
