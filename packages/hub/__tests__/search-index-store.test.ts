import { describe, it, expect } from 'vitest'
import { MemoryIndexStore } from '../src/search/index-store.js'
import type { IndexDoc } from '../src/search/inverted-index.js'

const docs: IndexDoc[] = [{ id: 'a', fields: [{ field: 'desc', text: 'invoice' }] }]

describe('MemoryIndexStore (#308 L1)', () => {
  it('builds once and caches (build fn not called again)', () => {
    const store = new MemoryIndexStore()
    let calls = 0
    const build = () => { calls++; return docs }
    const i1 = store.getOrBuild(build)
    const i2 = store.getOrBuild(build)
    expect(calls).toBe(1)
    expect(i1).toBe(i2)
    expect(store.built).toBe(true)
  })

  it('markDirty forces a rebuild', () => {
    const store = new MemoryIndexStore()
    let calls = 0
    const build = () => { calls++; return docs }
    store.getOrBuild(build)
    store.markDirty()
    expect(store.built).toBe(false)
    store.getOrBuild(build)
    expect(calls).toBe(2)
  })
})
