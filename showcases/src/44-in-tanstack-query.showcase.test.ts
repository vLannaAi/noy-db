/**
 * Showcase 44 — in-tanstack-query (collectionListOptions etc.)
 *
 * What you'll learn
 * ─────────────────
 * `collectionListOptions<T>(vault, name, getCollection)` returns a
 * TanStack-compatible `{ queryKey, queryFn }` pair. The query key is
 * a canonical 4-tuple `['noy-db', vault, collection, 'list']` so cache
 * invalidation lines up across files. `bindInvalidation()` wires
 * collection writes to `queryClient.invalidateQueries()` automatically.
 *
 * Why it matters
 * ──────────────
 * TanStack Query is the cross-framework server-state standard. Pairing
 * it with noy-db means the encrypted vault behaves like any cached
 * server source — without ever leaking ciphertext to the browser cache.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 06-multi-user.
 *
 * What to read next
 * ─────────────────
 *   - showcase 45-in-tanstack-table (table-state ↔ Query DSL)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-tanstack-query
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { collectionQueryKey, collectionListOptions, collectionGetOptions } from '@noy-db/in-tanstack-query'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 44 — in-tanstack-query', () => {
  it('queryKey is canonical and queryFn returns the decrypted records', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'in-tquery-pass-2026' })
    const vault = await db.openVault('demo')
    const coll = vault.collection<Note>('notes')
    await coll.put('a', { id: 'a', text: 'one' })
    await coll.put('b', { id: 'b', text: 'two' })

    expect(collectionQueryKey('demo', 'notes', 'list')).toEqual(['noy-db', 'demo', 'notes', 'list'])

    const list = collectionListOptions<Note>('demo', 'notes', () => coll)
    expect(list.queryKey).toEqual(['noy-db', 'demo', 'notes', 'list'])
    const records = await list.queryFn()
    expect(records.map((r) => r.id).sort()).toEqual(['a', 'b'])

    const one = collectionGetOptions<Note>('demo', 'notes', 'a', () => coll)
    expect(one.queryKey).toEqual(['noy-db', 'demo', 'notes', 'get', 'a'])
    expect(await one.queryFn()).toEqual({ id: 'a', text: 'one' })

    db.close()
  })
})
