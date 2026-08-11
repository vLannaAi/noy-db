import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { EncryptedEnvelope } from '@noy-db/hub'

// Simulates a write that dies partway through — the exact failure the
// atomic-write fix exists for (Wi-Fi drop on a mounted share, USB stick
// pulled mid-flush). When armed, `writeFile` lands TRUNCATED bytes and
// then rejects, so the file it touched is left unparseable.
let tearNextWrite = false

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    async writeFile(path: never, data: never, encoding: never) {
      if (!tearNextWrite) return actual.writeFile(path, data, encoding)
      tearNextWrite = false
      await actual.writeFile(path, String(data).slice(0, 12), encoding)
      throw new Error('EIO: simulated interruption')
    },
  }
})

const { toFile } = await import('../src/index.js')

function makeEnvelope(v: number): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: '2026-08-11T00:00:00Z', _iv: 'iv', _data: `data-${v}` }
}

describe('@noy-db/to-file — atomic writes (#1040)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noydb-file-atomic-'))
    tearNextWrite = false
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('1. an interrupted put leaves the previous record intact and parseable', async () => {
    const store = toFile({ dir })
    await store.put('C1', 'invoices', 'inv-1', makeEnvelope(1))

    tearNextWrite = true
    await expect(store.put('C1', 'invoices', 'inv-1', makeEnvelope(2))).rejects.toThrow(/EIO/)

    // The pre-existing envelope must survive untouched — a torn write
    // must never be reachable under the record's own name.
    expect(await store.get('C1', 'invoices', 'inv-1')).toEqual(makeEnvelope(1))
    const raw = await readFile(join(dir, 'C1', 'invoices', 'inv-1.json'), 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('2. an interrupted put on a NEW record leaves no unparseable file behind', async () => {
    const store = toFile({ dir })

    tearNextWrite = true
    await expect(store.put('C1', 'invoices', 'inv-9', makeEnvelope(1))).rejects.toThrow(/EIO/)

    expect(await store.get('C1', 'invoices', 'inv-9')).toBeNull()
    expect(await store.list('C1', 'invoices')).toEqual([])
    await expect(store.loadAll('C1')).resolves.toEqual({ invoices: {} })
  })

  it('3. a successful put leaves no .tmp residue', async () => {
    const store = toFile({ dir })
    await store.put('C1', 'invoices', 'inv-1', makeEnvelope(1))

    const files = await readdir(join(dir, 'C1', 'invoices'))
    expect(files).toEqual(['inv-1.json'])
  })

  it('4. an interrupted put cleans up its own temp file', async () => {
    const store = toFile({ dir })

    tearNextWrite = true
    await expect(store.put('C1', 'invoices', 'inv-1', makeEnvelope(1))).rejects.toThrow(/EIO/)

    const files = await readdir(join(dir, 'C1', 'invoices'))
    expect(files).toEqual([])
  })

  it('5. saveAll writes atomically too', async () => {
    const store = toFile({ dir })
    await store.saveAll('C1', { invoices: { 'inv-1': makeEnvelope(1) } })

    tearNextWrite = true
    await expect(
      store.saveAll('C1', { invoices: { 'inv-1': makeEnvelope(2) } }),
    ).rejects.toThrow(/EIO/)

    expect(await store.get('C1', 'invoices', 'inv-1')).toEqual(makeEnvelope(1))
    expect(await readdir(join(dir, 'C1', 'invoices'))).toEqual(['inv-1.json'])
  })

  it('6. an orphaned .tmp file from a dead process is invisible to every read path', async () => {
    const store = toFile({ dir })
    await store.put('C1', 'invoices', 'inv-1', makeEnvelope(1))

    // A crashed process on another machine left this behind.
    await writeFile(join(dir, 'C1', 'invoices', 'inv-2.json.9999.0.tmp'), '{"trunc', 'utf-8')

    expect(await store.list('C1', 'invoices')).toEqual(['inv-1'])
    const page = await store.listPage!('C1', 'invoices')
    expect(page.items.map(i => i.id)).toEqual(['inv-1'])
    await expect(store.loadAll('C1')).resolves.toEqual({
      invoices: { 'inv-1': makeEnvelope(1) },
    })
  })

  it('7. concurrent puts to different records do not share a temp path', async () => {
    const store = toFile({ dir })
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.put('C1', 'invoices', `inv-${i}`, makeEnvelope(i)),
      ),
    )

    const files = await readdir(join(dir, 'C1', 'invoices'))
    expect(files.filter(f => f.endsWith('.tmp'))).toEqual([])
    expect(files).toHaveLength(20)
  })
})
