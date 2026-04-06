import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { jsonFile } from '../src/index.js'
import type { EncryptedEnvelope } from '@noy-db/core'

function makeEnvelope(v: number): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: '2026-04-06T00:00:00Z', _iv: 'iv', _data: 'data' }
}

describe('@noy-db/file — listPage', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noydb-file-listpage-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('1. has a name field', () => {
    const a = jsonFile({ dir })
    expect(a.name).toBe('file')
  })

  it('2. exposes listPage as an optional method', () => {
    const a = jsonFile({ dir })
    expect(typeof a.listPage).toBe('function')
  })

  it('3. returns empty page when collection directory does not exist', async () => {
    const a = jsonFile({ dir })
    const page = await a.listPage!('C1', 'invoices')
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('4. paginates over .json files in sorted order', async () => {
    const a = jsonFile({ dir })
    // Insert in scrambled order to verify sorted output.
    for (const i of [3, 0, 1, 2, 4]) {
      await a.put('C1', 'invoices', `inv-${i}`, makeEnvelope(1))
    }

    const all: string[] = []
    let cursor: string | undefined
    while (true) {
      const page = await a.listPage!('C1', 'invoices', cursor, 2)
      for (const { id } of page.items) all.push(id)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(all).toEqual(['inv-0', 'inv-1', 'inv-2', 'inv-3', 'inv-4'])
  })

  it('5. each page item carries a parsed envelope', async () => {
    const a = jsonFile({ dir })
    await a.put('C1', 'invoices', 'inv-001', makeEnvelope(7))

    const page = await a.listPage!('C1', 'invoices')
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.id).toBe('inv-001')
    expect(page.items[0]?.envelope._v).toBe(7)
    expect(page.items[0]?.envelope._iv).toBe('iv')
    expect(page.items[0]?.envelope._data).toBe('data')
  })

  it('6. final page returns nextCursor: null', async () => {
    const a = jsonFile({ dir })
    for (let i = 0; i < 3; i++) {
      await a.put('C1', 'invoices', `id-${i}`, makeEnvelope(1))
    }
    const page = await a.listPage!('C1', 'invoices', undefined, 100)
    expect(page.items).toHaveLength(3)
    expect(page.nextCursor).toBeNull()
  })

  it('7. survives a 100-record collection across multiple pages', async () => {
    const a = jsonFile({ dir })
    for (let i = 0; i < 100; i++) {
      await a.put('C1', 'invoices', `id-${String(i).padStart(3, '0')}`, makeEnvelope(1))
    }

    let total = 0
    let pages = 0
    let cursor: string | undefined
    while (true) {
      const page = await a.listPage!('C1', 'invoices', cursor, 25)
      total += page.items.length
      pages++
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(total).toBe(100)
    expect(pages).toBe(4) // exactly 4 pages of 25
  })
})
