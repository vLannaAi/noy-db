import { describe, it, expect } from 'vitest'
import { memoryStore } from '../src/kernel/to/memory-store.js'
import type { EncryptedEnvelope } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

const env = (v: number): EncryptedEnvelope =>
  ({ _noydb: 1, _v: v, _ts: '2026-01-01T00:00:00.000Z', _iv: '', _data: `d${v}` }) as unknown as EncryptedEnvelope

describe('memoryStore', () => {
  it('put then get returns the envelope; missing returns null', async () => {
    const s = memoryStore()
    expect(await s.get('v', 'c', '1')).toBeNull()
    await s.put('v', 'c', '1', env(0))
    expect((await s.get('v', 'c', '1'))?._data).toBe('d0')
  })

  it('list returns ids; delete removes', async () => {
    const s = memoryStore()
    await s.put('v', 'c', 'a', env(0))
    await s.put('v', 'c', 'b', env(0))
    expect((await s.list('v', 'c')).sort()).toEqual(['a', 'b'])
    await s.delete('v', 'c', 'a')
    expect(await s.list('v', 'c')).toEqual(['b'])
  })

  it('CAS: put with stale expectedVersion throws ConflictError', async () => {
    const s = memoryStore()
    await s.put('v', 'c', '1', env(5))
    await expect(s.put('v', 'c', '1', env(6), 4)).rejects.toBeInstanceOf(ConflictError)
    await s.put('v', 'c', '1', env(6), 5) // matching version succeeds
    expect((await s.get('v', 'c', '1'))?._v).toBe(6)
  })

  it('loadAll returns a snapshot excluding _system collections; saveAll replaces user collections', async () => {
    const s = memoryStore()
    await s.put('v', 'items', '1', env(0))
    await s.put('v', '_idx', 'x', env(0)) // system collection — excluded from loadAll
    expect(await s.loadAll('v')).toEqual({ items: { '1': env(0) } })

    await s.saveAll('v', { items: { '2': env(0) } })
    expect(await s.list('v', 'items')).toEqual(['2']) // user collection replaced
    expect(await s.list('v', '_idx')).toEqual(['x']) // system collection preserved
  })

  it('declares casAtomic + a monotonic store clock', async () => {
    const s = memoryStore()
    expect(s.capabilities?.casAtomic).toBe(true)
    const t1 = await s.getStoreTime!()
    const t2 = await s.getStoreTime!()
    expect(t2.earliest).toBeGreaterThan(t1.earliest)
  })

  it('listPage returns paginated results with stable sorting (by id) and correct cursor', async () => {
    const s = memoryStore()
    // Seed out of lexicographic order so the sort() guarantee is actually exercised
    // (Map preserves insertion order; without sort, page 1 would be ['c','a']).
    await s.put('v', 'c', 'c', env(0))
    await s.put('v', 'c', 'a', env(0))
    await s.put('v', 'c', 'b', env(0))

    // First page: 2 items (limit 2)
    const page1 = await s.listPage!('v', 'c', undefined, 2)
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0]?.id).toBe('a')
    expect(page1.items[1]?.id).toBe('b')
    expect(page1.nextCursor).toBe('2')

    // Second page: 1 item remaining
    const page2 = await s.listPage!('v', 'c', '2', 2)
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]?.id).toBe('c')
    expect(page2.nextCursor).toBeNull()

    // Empty collection
    const emptyPage = await s.listPage!('v', 'nonexistent', undefined, 10)
    expect(emptyPage.items).toEqual([])
    expect(emptyPage.nextCursor).toBeNull()
  })
})
