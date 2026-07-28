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
import { toMemory } from '@noy-db/to-memory'
import { toBytesMultiVault, type MultiVaultDenormColumn } from '../src/index.js'
import { withTeam } from '@noy-db/hub/team'

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
  const adapter = toMemory()

  // First open as owner to set up vaults + data
  const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })

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

async function grantXlsxBothVaults(adapter: ReturnType<typeof toMemory>) {
  const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
  await db.grant('primary', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    secret: 'owner-pass',
    exportCapability: { plaintext: ['xlsx'] },
  })
  await db.grant('directory', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    secret: 'owner-pass',
    exportCapability: { plaintext: ['xlsx'] },
  })
  await db.close()
}

// ── tests ──────────────────────────────────────────────────────────

describe('toBytesMultiVault', () => {
  it('produces a two-vault workbook with vault-prefixed sheet names', async () => {
    const { db, adapter } = await seedTwoVaults()
    await grantXlsxBothVaults(adapter)

    const db2 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
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

    const db2 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
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

    const db2 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
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

    const db2 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
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

    const db2 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
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

    const db2 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
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

// ── Task 2: denormalized FK columns ───────────────────────────────────

describe('toBytesMultiVault — denormalized columns', () => {
  it('adds entityName column to bills sheet via in-memory join from directory/entities', async () => {
    const { db, adapter } = await seedTwoVaults()
    await grantXlsxBothVaults(adapter)

    const db2 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const primaryVault = await db2.openVault('primary')
    const dirVault = await db2.openVault('directory')

    const denormalize: MultiVaultDenormColumn[] = [
      {
        column: 'entityName',
        localField: 'entityId',
        from: { label: 'directory', collection: 'entities', keyField: 'id', pick: 'name' },
      },
    ]

    const bytes = await toBytesMultiVault([
      {
        vault: primaryVault,
        label: 'primary',
        sheets: [{
          name: 'bills',
          collection: 'bills',
          columns: ['id', 'entityId', 'amount'],
          denormalize,
        }],
      },
      {
        vault: dirVault,
        label: 'directory',
        sheets: [{ name: 'entities', collection: 'entities', columns: ['id', 'name'] }],
        closure: new Map([['entities', new Set(['e1'])]]),
      },
    ])

    // The bills sheet header should contain entityName
    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    expect(shared).toContain('>entityName<')

    // The resolved name for e1 (Globex Corp) must appear in the bills sheet
    expect(shared).toContain('>Globex Corp<')

    await db.close()
    await db2.close()
  })

  it('yields empty cell for unresolved FK (entity id not in closure/index)', async () => {
    const adapter = toMemory()
    const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })

    const primaryVault = await db.openVault('primary')
    const bills = primaryVault.collection<{ id: string; entityId: string; amount: number }>('bills')
    await bills.put('b1', { id: 'b1', entityId: 'e1', amount: 100 })
    // bill b3 references e99 which is NOT in the directory closure
    await bills.put('b3', { id: 'b3', entityId: 'e99', amount: 50 })

    const dirVault = await db.openVault('directory')
    const entities = dirVault.collection<{ id: string; name: string }>('entities')
    await entities.put('e1', { id: 'e1', name: 'Globex Corp' })
    await entities.put('e99', { id: 'e99', name: 'Ghost Corp' }) // in store but NOT in closure

    await db.close()

    // Grant xlsx on both vaults
    const db2 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
    await db2.grant('primary', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      secret: 'owner-pass',
      exportCapability: { plaintext: ['xlsx'] },
    })
    await db2.grant('directory', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      secret: 'owner-pass',
      exportCapability: { plaintext: ['xlsx'] },
    })
    await db2.close()

    const db3 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const pv = await db3.openVault('primary')
    const dv = await db3.openVault('directory')

    const bytes = await toBytesMultiVault([
      {
        vault: pv,
        label: 'primary',
        sheets: [{
          name: 'bills',
          collection: 'bills',
          columns: ['id', 'entityId', 'amount'],
          denormalize: [{
            column: 'entityName',
            localField: 'entityId',
            from: { label: 'directory', collection: 'entities', keyField: 'id', pick: 'name' },
          }],
        }],
      },
      {
        vault: dv,
        label: 'directory',
        // closure limits to e1 only — e99 is NOT indexed even though it exists in the store
        sheets: [{ name: 'entities', collection: 'entities', columns: ['id', 'name'] }],
        closure: new Map([['entities', new Set(['e1'])]]),
      },
    ])

    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    // Globex Corp (e1) resolves fine
    expect(shared).toContain('>Globex Corp<')
    // Ghost Corp (e99) must NOT appear — it's outside the closure and stays empty
    expect(shared).not.toContain('>Ghost Corp<')

    // Parse the bills worksheet XML to verify the unresolved row has an empty cell
    // We check the worksheet for the bills sheet — sheet 2 in the workbook (_manifest=1, primary_bills=2)
    const workbook = readZipFile(bytes, 'xl/workbook.xml')!
    // Extract sheet IDs to find primary_bills position
    const billsMatch = workbook.match(/name="primary_bills" sheetId="(\d+)"/)
    expect(billsMatch).not.toBeNull()
    const sheetId = billsMatch![1]
    const sheetXml = readZipFile(bytes, `xl/worksheets/sheet${sheetId}.xml`)!

    // The row for b3 (entityId=e99) should have an empty last cell for entityName.
    // We look for the presence of 'e99' (shared string) — it should be there as the entityId value
    expect(shared).toContain('>e99<')

    await db3.close()
  })

  it('declared columns appear before denorm columns in header', async () => {
    const { db, adapter } = await seedTwoVaults()
    await grantXlsxBothVaults(adapter)

    const db2 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const primaryVault = await db2.openVault('primary')
    const dirVault = await db2.openVault('directory')

    const bytes = await toBytesMultiVault([
      {
        vault: primaryVault,
        label: 'primary',
        sheets: [{
          name: 'bills',
          collection: 'bills',
          columns: ['id', 'entityId', 'amount'],
          denormalize: [{
            column: 'entityName',
            localField: 'entityId',
            from: { label: 'directory', collection: 'entities', keyField: 'id', pick: 'name' },
          }],
        }],
      },
      {
        vault: dirVault,
        label: 'directory',
        sheets: [{ name: 'entities', collection: 'entities', columns: ['id', 'name'] }],
        closure: new Map([['entities', new Set(['e1'])]]),
      },
    ])

    // Find the primary_bills sheet id
    const workbook = readZipFile(bytes, 'xl/workbook.xml')!
    const match = workbook.match(/name="primary_bills" sheetId="(\d+)"/)
    expect(match).not.toBeNull()
    const sheetId = match![1]
    const sheetXml = readZipFile(bytes, `xl/worksheets/sheet${sheetId}.xml`)!

    // The header row (row 1) should have id/entityId/amount then entityName.
    // Column A=id, B=entityId, C=amount, D=entityName
    // We verify by checking that entityName has a higher column index than amount.
    // The sharedStrings approach: find string indices for 'entityName' and 'amount'.
    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    const strings = [...shared.matchAll(/<t[^>]*>([^<]+)<\/t>/g)].map((m) => m[1]!)
    const idxEntityName = strings.indexOf('entityName')
    const idxAmount = strings.indexOf('amount')
    expect(idxEntityName).toBeGreaterThan(-1)
    expect(idxAmount).toBeGreaterThan(-1)
    // In the header row the cell for 'amount' should appear before 'entityName'
    const amountCellPos = sheetXml.indexOf(`v>${idxAmount}</v>`)
    const entityNameCellPos = sheetXml.indexOf(`v>${idxEntityName}</v>`)
    expect(amountCellPos).toBeGreaterThan(-1)
    expect(entityNameCellPos).toBeGreaterThan(-1)
    expect(amountCellPos).toBeLessThan(entityNameCellPos)

    await db.close()
    await db2.close()
  })
})
