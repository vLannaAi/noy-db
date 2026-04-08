import { describe, it, expect } from 'vitest'
import { memory } from '../src/index.js'
import type { EncryptedEnvelope } from '@noy-db/core'

function makeEnvelope(v: number): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: '2026-04-06T00:00:00Z', _iv: 'iv', _data: 'data' }
}

describe('@noy-db/memory — listPage', () => {
  it('1. has a name field', () => {
    const a = memory()
    expect(a.name).toBe('memory')
  })

  it('2. exposes listPage as an optional method', () => {
    const a = memory()
    expect(typeof a.listPage).toBe('function')
  })

  it('3. returns empty page for empty collection', async () => {
    const a = memory()
    const page = await a.listPage!('C1', 'invoices')
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('4. returns sorted items across pages', async () => {
    const a = memory()
    for (let i = 9; i >= 0; i--) {
      // Insert in REVERSE order to verify sorting in listPage
      await a.put('C1', 'invoices', `inv-${i}`, makeEnvelope(1))
    }
    const all: string[] = []
    let cursor: string | undefined
    while (true) {
      const opts: { cursor?: string; limit: number } = { limit: 3 }
      if (cursor !== undefined) opts.cursor = cursor
      // Reproduce the (compartment, collection, cursor?, limit?) signature
      const page = await a.listPage!('C1', 'invoices', cursor, 3)
      for (const { id } of page.items) all.push(id)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(all).toHaveLength(10)
    // String-sorted: inv-0, inv-1, ..., inv-9 (single-digit suffixes)
    expect(all).toEqual([...all].sort())
  })

  it('5. final page returns nextCursor: null', async () => {
    const a = memory()
    for (let i = 0; i < 5; i++) {
      await a.put('C1', 'invoices', `id-${i}`, makeEnvelope(1))
    }
    const page = await a.listPage!('C1', 'invoices', undefined, 100)
    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).toBeNull()
  })

  it('6. cursor at exact boundary returns empty next page', async () => {
    const a = memory()
    for (let i = 0; i < 10; i++) {
      await a.put('C1', 'invoices', `id-${i}`, makeEnvelope(1))
    }
    const page = await a.listPage!('C1', 'invoices', '10', 5)
    expect(page.items).toHaveLength(0)
    expect(page.nextCursor).toBeNull()
  })
})
