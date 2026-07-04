/**
 * Gate test for the `lazy` service (#267 Track A tail — lazy-mode promoted
 * out of `routing` into its own opt-in service).
 *
 * `withLazy()` is the explicit opt-in: it supplies the bounded-LRU record
 * cache lazy mode (`prefetch: false`) runs on. The implicit path —
 * `prefetch: false` with NO `lazyStrategy` — keeps working IDENTICALLY
 * (pre-1.0 back-compat delegation) but is deprecated: it emits a one-time
 * console.warn outside test env and will be removed at 1.0.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { withLazy } from '../src/with-store/lazy/index.js'

type Doc = { n: number }

describe('lazy service opt-in (#267)', () => {
  it('withLazy(): prefetch:false works end-to-end with a bounded LRU', async () => {
    const db = await createNoydb({
      store: memoryStore(), user: 'me', secret: 'pw-long-enough',
      lazyStrategy: withLazy(),
    })
    const vault = await db.openVault('L')
    const docs = vault.collection<Doc>('docs', { prefetch: false, cache: { maxRecords: 2 } })
    await docs.put('a', { n: 1 })
    await docs.put('b', { n: 2 })
    await docs.put('c', { n: 3 })
    expect((await docs.get('a'))?.n).toBe(1)
    expect((await docs.get('c'))?.n).toBe(3)
    const stats = await docs.cacheStats()
    expect(stats.lazy).toBe(true)
    expect(stats.size).toBeLessThanOrEqual(2) // LRU bound respected
    await db.close()
  })

  it('implicit path (no lazyStrategy) keeps working identically', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'me', secret: 'pw-long-enough' })
    const vault = await db.openVault('L')
    const docs = vault.collection<Doc>('docs', { prefetch: false, cache: { maxRecords: 2 } })
    await docs.put('a', { n: 1 })
    expect((await docs.get('a'))?.n).toBe(1)
    const stats = await docs.cacheStats()
    expect(stats.lazy).toBe(true)
    await db.close()
  })

  it('both paths reject an unbounded lazy cache with the same error', async () => {
    const explicit = await createNoydb({
      store: memoryStore(), user: 'me', secret: 'pw-long-enough',
      lazyStrategy: withLazy(),
    })
    const implicit = await createNoydb({ store: memoryStore(), user: 'me', secret: 'pw-long-enough' })
    const ev = await explicit.openVault('L')
    const iv = await implicit.openVault('L')
    for (const vault of [ev, iv]) {
      expect(() => vault.collection<Doc>('unbounded', { prefetch: false })).toThrow(
        /lazy mode \(prefetch: false\) requires a cache option/,
      )
    }
    await explicit.close()
    await implicit.close()
  })

  it('withLazy() honours maxBytes string budgets like the implicit path', async () => {
    const db = await createNoydb({
      store: memoryStore(), user: 'me', secret: 'pw-long-enough',
      lazyStrategy: withLazy(),
    })
    const vault = await db.openVault('L')
    const docs = vault.collection<Doc>('docs', { prefetch: false, cache: { maxBytes: '1KB' } })
    await docs.put('a', { n: 1 })
    expect((await docs.get('a'))?.n).toBe(1)
    await db.close()
  })
})
