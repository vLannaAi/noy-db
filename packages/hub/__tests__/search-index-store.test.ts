import { describe, it, expect } from 'vitest'
import { MemoryIndexStore } from '../src/with-lookup/search/index-store.js'
import type { IndexDoc } from '../src/with-lookup/search/inverted-index.js'

const docs: IndexDoc[] = [{ id: 'a', fields: [{ field: 'desc', text: 'invoice' }] }]

describe('MemoryIndexStore (#308 L1.5 async)', () => {
  it('builds once and caches', async () => {
    const store = new MemoryIndexStore()
    let calls = 0
    const build = () => { calls++; return docs }
    const i1 = await store.ensureBuilt(build)
    const i2 = await store.ensureBuilt(build)
    expect(calls).toBe(1); expect(i1).toBe(i2); expect(store.built).toBe(true)
    await store.flush() // no-op, resolves
  })
  it('markDirty forces a rebuild', async () => {
    const store = new MemoryIndexStore()
    let calls = 0
    const build = () => { calls++; return docs }
    await store.ensureBuilt(build); store.markDirty()
    expect(store.built).toBe(false)
    await store.ensureBuilt(build); expect(calls).toBe(2)
  })
})
