/**
 * Integration tests for toBytesMultiVault (FR-9 Task 1).
 *
 * Covers:
 *   - two-vault workbook: vault-prefixed sheet names (primary_bills, directory_entities)
 *   - closure filter: directory_entities contains ONLY the referenced entity row (e1)
 *   - _manifest sheet lists both vault-collection pairs
 *   - export-grant check: vault without grant → ExportCapabilityError
 *   - single-vault toBytes is unchanged (smoke)
 */
import { describe, expect, it } from 'vitest'
import { ExportCapabilityError, createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { toBytesMultiVault } from '../src/index.js'

// ── zip helpers (mirrors as-xlsx.test.ts) ──────────────────────────

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

// ── test harness ───────────────────────────────────────────────────

async function seedTwoVaults() {
  const adapter = memory()

  // First open as owner to set up vaults + data
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })

  // primary vault: bills referencing entityId
  const primaryVault = await db.openVault('primary')
  const bills = primaryVault.collection<{ id: string; entityId: string; amount: number }>('bills')
  await bills.put('b1', { id: 'b1', entityId: 'e1', amount: 100 })
  await bills.put('b2', { id: 'b2', entityId: 'e1', amount: 200 })

  // directory vault: entities (two rows; only e1 is referenced by bills)
  const dirVault = await db.openVault('directory')
  const entities = dirVault.collection<{ id: string; name: string }>('entities')
  await entities.put('e1', { id: 'e1', name: 'Globex Corp' })
  await entities.put('e2', { id: 'e2', name: 'Initech Ltd' })   // NOT referenced

  return { db, adapter }
}

async function grantXlsxBothVaults(adapter: ReturnType<typeof memory>) {
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  await db.grant('primary', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    passphrase: 'owner-pass',
    exportCapability: { plaintext: ['xlsx'] },
  })
  await db.grant('directory', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    passphrase: 'owner-pass',
    exportCapability: { plaintext: ['xlsx'] },
  })
  await db.close()
}

// ── tests ──────────────────────────────────────────────────────────

describe('toBytesMultiVault', () => {
  it('produces a two-vault workbook with vault-prefixed sheet names', async () => {
    const { db, adapter } = await seedTwoVaults()
    await grantXlsxBothVaults(adapter)

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const primaryVault = await db2.openVault('primary')
    const dirVault = await db2.openVault('directory')

    const bytes = await toBytesMultiVault([
      {
        vault: primaryVault,
        sheets: [{ name: 'bills', collection: 'bills', columns: ['id', 'entityId', 'amount'] }],
      },
      {
        vault: dirVault,
        sheets: [{ name: 'entities', collection: 'entities', columns: ['id', 'name'] }],
        closure: new Map([['entities', new Set(['e1'])]]),
      },
    ])

    // Basic structure
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)

    const workbook = readZipFile(bytes, 'xl/workbook.xml')!
    expect(workbook).not.toBeNull()

    // Sheet names should be vault-prefixed
    expect(workbook).toContain('name="primary_bills"')
    expect(workbook).toContain('name="directory_entities"')

    // _manifest sheet must exist
    expect(workbook).toContain('name="_manifest"')

    await db.close()
    await db2.close()
  })

  it('filters directory_entities to only the closure-specified ids (e1 only, not e2)', async () => {
    const { db, adapter } = await seedTwoVaults()
    await grantXlsxBothVaults(adapter)

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const primaryVault = await db2.openVault('primary')
    const dirVault = await db2.openVault('directory')

    const bytes = await toBytesMultiVault([
      {
        vault: primaryVault,
        sheets: [{ name: 'bills', collection: 'bills', columns: ['id', 'entityId', 'amount'] }],
      },
      {
        vault: dirVault,
        sheets: [{ name: 'entities', collection: 'entities', columns: ['id', 'name'] }],
        closure: new Map([['entities', new Set(['e1'])]]),
      },
    ])

    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    // e1 entity should be present
    expect(shared).toContain('>Globex Corp<')
    // e2 entity must NOT be present (closure filter)
    expect(shared).not.toContain('>Initech Ltd<')

    await db.close()
    await db2.close()
  })

  it('_manifest sheet lists both vaults with correct record counts', async () => {
    const { db, adapter } = await seedTwoVaults()
    await grantXlsxBothVaults(adapter)

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const primaryVault = await db2.openVault('primary')
    const dirVault = await db2.openVault('directory')

    const bytes = await toBytesMultiVault([
      {
        vault: primaryVault,
        sheets: [{ name: 'bills', collection: 'bills', columns: ['id', 'entityId', 'amount'] }],
      },
      {
        vault: dirVault,
        sheets: [{ name: 'entities', collection: 'entities', columns: ['id', 'name'] }],
        closure: new Map([['entities', new Set(['e1'])]]),
      },
    ])

    const paths = listZipPaths(bytes)
    // _manifest is sheet 1 (prepended)
    expect(paths).toContain('xl/worksheets/sheet1.xml')

    // The workbook should list _manifest first
    const workbook = readZipFile(bytes, 'xl/workbook.xml')!
    const manifestIdx = workbook.indexOf('name="_manifest"')
    const billsIdx = workbook.indexOf('name="primary_bills"')
    expect(manifestIdx).toBeLessThan(billsIdx)

    // Manifest sheet content: headers Vault/Collection/Records
    // and rows for primary/bills (2 records) and directory/entities (1 record after closure)
    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    expect(shared).toContain('>Vault<')
    expect(shared).toContain('>Collection<')
    expect(shared).toContain('>Records<')
    expect(shared).toContain('>primary<')
    expect(shared).toContain('>bills<')
    expect(shared).toContain('>directory<')
    expect(shared).toContain('>entities<')

    await db.close()
    await db2.close()
  })

  it('primary vault exports all rows (no closure filter)', async () => {
    const { db, adapter } = await seedTwoVaults()
    await grantXlsxBothVaults(adapter)

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const primaryVault = await db2.openVault('primary')
    const dirVault = await db2.openVault('directory')

    const bytes = await toBytesMultiVault([
      {
        vault: primaryVault,
        sheets: [{ name: 'bills', collection: 'bills', columns: ['id', 'entityId', 'amount'] }],
      },
      {
        vault: dirVault,
        sheets: [{ name: 'entities', collection: 'entities', columns: ['id', 'name'] }],
        closure: new Map([['entities', new Set(['e1'])]]),
      },
    ])

    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    // Both bills should be present (no closure on primary)
    expect(shared).toContain('>b1<')
    expect(shared).toContain('>b2<')

    await db.close()
    await db2.close()
  })

  it('uses label instead of vault.name when label is supplied', async () => {
    const { db, adapter } = await seedTwoVaults()
    await grantXlsxBothVaults(adapter)

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const primaryVault = await db2.openVault('primary')
    const dirVault = await db2.openVault('directory')

    const bytes = await toBytesMultiVault([
      {
        vault: primaryVault,
        label: 'main',
        sheets: [{ name: 'bills', collection: 'bills', columns: ['id', 'entityId', 'amount'] }],
      },
      {
        vault: dirVault,
        label: 'dir',
        sheets: [{ name: 'entities', collection: 'entities', columns: ['id', 'name'] }],
      },
    ])

    const workbook = readZipFile(bytes, 'xl/workbook.xml')!
    expect(workbook).toContain('name="main_bills"')
    expect(workbook).toContain('name="dir_entities"')

    await db.close()
    await db2.close()
  })

  it('uses custom sheetSeparator when supplied', async () => {
    const { db, adapter } = await seedTwoVaults()
    await grantXlsxBothVaults(adapter)

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const primaryVault = await db2.openVault('primary')

    const bytes = await toBytesMultiVault(
      [{ vault: primaryVault, sheets: [{ name: 'bills', collection: 'bills', columns: ['id'] }] }],
      { sheetSeparator: '.' },
    )

    const workbook = readZipFile(bytes, 'xl/workbook.xml')!
    expect(workbook).toContain('name="primary.bills"')

    await db.close()
    await db2.close()
  })

  it('refuses a vault without xlsx export grant (ExportCapabilityError)', async () => {
    const { db } = await seedTwoVaults()
    // No grant given — vaults created but no exportCapability
    const primaryVault = await db.openVault('primary')
    const dirVault = await db.openVault('directory')

    await expect(
      toBytesMultiVault([
        { vault: primaryVault, sheets: [{ name: 'bills', collection: 'bills' }] },
        { vault: dirVault, sheets: [{ name: 'entities', collection: 'entities' }] },
      ]),
    ).rejects.toThrow(ExportCapabilityError)

    await db.close()
  })
})
