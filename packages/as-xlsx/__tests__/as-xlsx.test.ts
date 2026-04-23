/**
 * Integration tests for @noy-db/as-xlsx.
 *
 * Covers:
 *   - xlsx writer produces a valid zip archive (PK magic + EOCD)
 *   - OOXML parts present: [Content_Types].xml, _rels/.rels,
 *     xl/workbook.xml, xl/worksheets/sheet1.xml, xl/sharedStrings.xml
 *   - shared-strings table populated with both headers and values
 *   - multi-sheet workbook generates sheet1.xml + sheet2.xml
 *   - numeric / boolean / string cells get correct `t="…"` attribute
 *   - column letter conversion — A..Z..AA..ZZ..AAA
 *   - auth refusal: owner without grant → ExportCapabilityError
 *   - acknowledgeRisks refusal on write()
 *   - disk round-trip
 */
import { describe, expect, it } from 'vitest'
import { ExportCapabilityError, createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { toBytes, write, colLetter, writeXlsx } from '../src/index.js'

interface Invoice { id: string; client: string; amount: number; paid: boolean; date: string }

async function seedVault() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  const vault = await db.openVault('acme')
  const invoices = vault.collection<Invoice>('invoices')
  await invoices.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500, paid: true, date: '2026-01-15' })
  await invoices.put('inv-2', { id: 'inv-2', client: 'Acme, Inc.', amount: 2400, paid: false, date: '2026-02-01' })
  await invoices.put('inv-3', { id: 'inv-3', client: 'สตาร์ค', amount: 999, paid: false, date: '2026-02-20' })
  return { db, adapter }
}

async function grantXlsx(adapter: ReturnType<typeof memory>) {
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  await db.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    passphrase: 'owner-pass',
    exportCapability: { plaintext: ['xlsx'] },
  })
  await db.close()
}

// Helpers that read the minimal zip layout. We wrote this — we can parse it.
function listZipPaths(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdOffset = bytes.length - 22
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  const recordCount = view.getUint16(eocdOffset + 10, true)
  const out: string[] = []
  let pos = cdOffset
  for (let i = 0; i < recordCount; i++) {
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    out.push(new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen)))
    pos += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function readZipFile(bytes: Uint8Array, path: string): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdOffset = bytes.length - 22
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  const recordCount = view.getUint16(eocdOffset + 10, true)
  let pos = cdOffset
  for (let i = 0; i < recordCount; i++) {
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    if (name === path) {
      const lfhOffset = view.getUint32(pos + 42, true)
      const lfhNameLen = view.getUint16(lfhOffset + 26, true)
      const lfhExtraLen = view.getUint16(lfhOffset + 28, true)
      const size = view.getUint32(lfhOffset + 18, true)
      const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen
      return new TextDecoder().decode(bytes.subarray(dataStart, dataStart + size))
    }
    pos += 46 + nameLen + extraLen + commentLen
  }
  return null
}

describe('colLetter', () => {
  it('maps 1-based indices to A1 letters', () => {
    expect(colLetter(1)).toBe('A')
    expect(colLetter(2)).toBe('B')
    expect(colLetter(26)).toBe('Z')
    expect(colLetter(27)).toBe('AA')
    expect(colLetter(52)).toBe('AZ')
    expect(colLetter(702)).toBe('ZZ')
    expect(colLetter(703)).toBe('AAA')
  })
})

describe('writeXlsx — low-level', () => {
  it('produces a valid zip with the expected OOXML parts', () => {
    const bytes = writeXlsx([
      {
        name: 'Test',
        header: ['col1', 'col2'],
        rows: [[1, 'a'], [2, 'b']],
      },
    ])
    // PK signature.
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    const paths = listZipPaths(bytes)
    expect(paths).toContain('[Content_Types].xml')
    expect(paths).toContain('_rels/.rels')
    expect(paths).toContain('xl/workbook.xml')
    expect(paths).toContain('xl/_rels/workbook.xml.rels')
    expect(paths).toContain('xl/sharedStrings.xml')
    expect(paths).toContain('xl/worksheets/sheet1.xml')
  })

  it('emits numeric, boolean, and string cells with correct type attrs', () => {
    const bytes = writeXlsx([
      {
        name: 'Typed',
        rows: [[42, true, 'hello']],
      },
    ])
    const sheet = readZipFile(bytes, 'xl/worksheets/sheet1.xml')!
    // Number: no `t` attr.
    expect(sheet).toMatch(/<c r="A1"><v>42<\/v><\/c>/)
    // Boolean: t="b".
    expect(sheet).toMatch(/<c r="B1" t="b"><v>1<\/v><\/c>/)
    // String: t="s" routed through shared strings.
    expect(sheet).toMatch(/<c r="C1" t="s"><v>0<\/v><\/c>/)
    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    expect(shared).toContain('>hello<')
  })

  it('preserves Unicode (Thai) in shared strings with XML escaping', () => {
    const bytes = writeXlsx([
      {
        name: 'Unicode',
        rows: [['สตาร์ค & Sons'], ['<escape>']],
      },
    ])
    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    expect(shared).toContain('สตาร์ค &amp; Sons')
    expect(shared).toContain('&lt;escape&gt;')
  })

  it('builds multi-sheet workbooks', () => {
    const bytes = writeXlsx([
      { name: 'First', rows: [[1]] },
      { name: 'Second', rows: [[2]] },
    ])
    const paths = listZipPaths(bytes)
    expect(paths).toContain('xl/worksheets/sheet1.xml')
    expect(paths).toContain('xl/worksheets/sheet2.xml')
    const workbook = readZipFile(bytes, 'xl/workbook.xml')!
    expect(workbook).toContain('name="First"')
    expect(workbook).toContain('name="Second"')
  })

  it('truncates sheet names > 31 chars and dedupes duplicates', () => {
    const bytes = writeXlsx([
      { name: 'A very long sheet name that exceeds the Excel limit', rows: [[1]] },
      { name: 'A very long sheet name that exceeds the Excel limit', rows: [[2]] },
    ])
    const workbook = readZipFile(bytes, 'xl/workbook.xml')!
    // Look for the truncation marker + the dedup suffix.
    expect(workbook).toMatch(/name="A very long sheet name that ex…"/)
    expect(workbook).toMatch(/\(1\)/)
  })

  it('throws on empty sheet list', () => {
    expect(() => writeXlsx([])).toThrow(/at least one sheet/)
  })
})

describe('as-xlsx — vault integration', () => {
  it('owner with grant exports a collection to xlsx', async () => {
    const { adapter } = await seedVault()
    await grantXlsx(adapter)

    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db.openVault('acme')
    const bytes = await toBytes(vault, {
      sheets: [
        {
          name: 'Invoices',
          collection: 'invoices',
          columns: ['id', 'client', 'amount', 'paid', 'date'],
        },
      ],
    })

    const paths = listZipPaths(bytes)
    expect(paths).toContain('xl/worksheets/sheet1.xml')
    const sheet = readZipFile(bytes, 'xl/worksheets/sheet1.xml')!
    // Header row: 5 string cells — `<c r="A1" t="s">` through E1.
    for (const col of ['A1', 'B1', 'C1', 'D1', 'E1']) {
      expect(sheet).toContain(`r="${col}" t="s"`)
    }
    // At least one numeric cell for amount (column C from row 2+).
    expect(sheet).toMatch(/r="C2"><v>\d+<\/v>/)
    await db.close()
  })

  it('infers columns from the first-record-wins order when omitted', async () => {
    const { adapter } = await seedVault()
    await grantXlsx(adapter)

    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db.openVault('acme')
    const bytes = await toBytes(vault, {
      sheets: [{ name: 'Invoices', collection: 'invoices' }],
    })
    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    // Inferred columns → first record keys in order.
    expect(shared).toContain('>id<')
    expect(shared).toContain('>client<')
    expect(shared).toContain('>amount<')
    await db.close()
  })

  it('refuses owner without xlsx grant', async () => {
    const { db } = await seedVault()
    const vault = await db.openVault('acme')
    await expect(
      toBytes(vault, {
        sheets: [{ name: 'Invoices', collection: 'invoices' }],
      }),
    ).rejects.toThrow(ExportCapabilityError)
    await db.close()
  })

  it('refuses write() without acknowledgeRisks', async () => {
    const { adapter } = await seedVault()
    await grantXlsx(adapter)
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db.openVault('acme')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      write(vault, '/tmp/x.xlsx', { sheets: [{ name: 'X', collection: 'invoices' }] } as any),
    ).rejects.toThrow(/acknowledgeRisks/)
    await db.close()
  })

  it('write() persists a valid xlsx to disk', async () => {
    const { adapter } = await seedVault()
    await grantXlsx(adapter)
    const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db.openVault('acme')

    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'noy-db-as-xlsx-'))
    const out = path.join(dir, 'invoices.xlsx')
    try {
      await write(vault, out, {
        sheets: [{ name: 'Invoices', collection: 'invoices' }],
        acknowledgeRisks: true,
      })
      const disk = new Uint8Array(await readFile(out))
      expect(disk[0]).toBe(0x50)
      expect(disk[1]).toBe(0x4b)
      const paths = listZipPaths(disk)
      expect(paths).toContain('xl/worksheets/sheet1.xml')
      expect(paths).toContain('[Content_Types].xml')
    } finally {
      await rm(dir, { recursive: true, force: true })
      await db.close()
    }
  })
})
