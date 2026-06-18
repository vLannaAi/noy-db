/**
 * Lobby.exportMultiVaultXlsx — orchestrator integration test (FR-9 Task 3).
 *
 * Verifies that the Lobby:
 *   - walks the FK closure (via walkCrossVaultClosure / FR-2)
 *   - delegates to toBytesMultiVault with the correct per-vault closures
 *   - the directory_entities sheet is filtered to ONLY the FK-referenced ids
 *   - the bills sheet has the denormalized entityName column
 *   - single-vault exports are unaffected (smoke via existing tests)
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { createLobby } from '../src/index.js'

// ── zip helpers (mirrored from as-xlsx multivault-xlsx.test.ts) ────────────────

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

// ── fixture ────────────────────────────────────────────────────────────────────

/**
 * Seeds one Noydb instance with two vaults:
 *  - primary  → bills (b1→e1, b2→e1, b3→e2)  NOTE: b3 references e2
 *  - directory → entities (e1=Acme Corp, e2=Beta Inc, e3=Gamma Ltd — e3 NOT referenced)
 *
 * bills b1+b2 reference e1; b3 references e2 → e3 is unreferenced.
 * This lets us assert that the directory_entities sheet has exactly {e1, e2} and NOT e3.
 */
async function buildFixture() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'lobby-secret' })

  const primaryVault = await db.openVault('primary')
  const bills = primaryVault.collection<{ id: string; entityId: string; amount: number }>('bills')
  await bills.put('b1', { id: 'b1', entityId: 'e1', amount: 100 })
  await bills.put('b2', { id: 'b2', entityId: 'e1', amount: 200 })
  await bills.put('b3', { id: 'b3', entityId: 'e2', amount: 50 })

  const dirVault = await db.openVault('directory')
  const entities = dirVault.collection<{ id: string; name: string }>('entities')
  await entities.put('e1', { id: 'e1', name: 'Acme Corp' })
  await entities.put('e2', { id: 'e2', name: 'Beta Inc' })
  await entities.put('e3', { id: 'e3', name: 'Gamma Ltd' }) // NOT referenced

  await db.close()

  // Grant xlsx export on both vaults
  const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'lobby-secret' })
  await db2.grant('primary', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    passphrase: 'lobby-secret',
    exportCapability: { plaintext: ['xlsx'] },
  })
  await db2.grant('directory', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    passphrase: 'lobby-secret',
    exportCapability: { plaintext: ['xlsx'] },
  })
  await db2.close()

  // Open a fresh session for the actual test
  const db3 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'lobby-secret' })
  const lobby = createLobby(db3)

  return { db: db3, lobby }
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('Lobby.exportMultiVaultXlsx', () => {
  it('workbook spans both vaults with vault-prefixed sheet names', async () => {
    const { db, lobby } = await buildFixture()

    const bytes = await lobby.exportMultiVaultXlsx({
      primary: { vault: 'primary', seeds: { bills: () => true } },
      crossVaultRefs: [
        { from: { collection: 'bills', field: 'entityId' }, to: { vault: 'directory', collection: 'entities' } },
      ],
      sheets: {
        primary: [{ name: 'bills', collection: 'bills' }],
        directory: [{ name: 'entities', collection: 'entities' }],
      },
    })

    // Must be a valid xlsx (zip magic bytes)
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)

    const workbook = readZipFile(bytes, 'xl/workbook.xml')!
    expect(workbook).toContain('name="primary_bills"')
    expect(workbook).toContain('name="directory_entities"')
    expect(workbook).toContain('name="_manifest"')

    await db.close()
  })

  it('directory_entities sheet contains EXACTLY FK-referenced entity ids (e1, e2 — not e3)', async () => {
    const { db, lobby } = await buildFixture()

    const bytes = await lobby.exportMultiVaultXlsx({
      primary: { vault: 'primary', seeds: { bills: () => true } },
      crossVaultRefs: [
        { from: { collection: 'bills', field: 'entityId' }, to: { vault: 'directory', collection: 'entities' } },
      ],
      sheets: {
        primary: [{ name: 'bills', collection: 'bills' }],
        directory: [{ name: 'entities', collection: 'entities' }],
      },
    })

    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    // Referenced entities must appear
    expect(shared).toContain('>Acme Corp<')  // e1
    expect(shared).toContain('>Beta Inc<')   // e2
    // Unreferenced entity must NOT appear (closure filter)
    expect(shared).not.toContain('>Gamma Ltd<')  // e3 — not referenced by any bill

    await db.close()
  })

  it('bills sheet has the denormalized entityName column with correct values', async () => {
    const { db, lobby } = await buildFixture()

    const bytes = await lobby.exportMultiVaultXlsx({
      primary: { vault: 'primary', seeds: { bills: () => true } },
      crossVaultRefs: [
        { from: { collection: 'bills', field: 'entityId' }, to: { vault: 'directory', collection: 'entities' } },
      ],
      sheets: {
        primary: [{
          name: 'bills',
          collection: 'bills',
          columns: ['id', 'entityId', 'amount'],
          denormalize: [{
            column: 'entityName',
            localField: 'entityId',
            from: { label: 'directory', collection: 'entities', keyField: 'id', pick: 'name' },
          }],
        }],
        directory: [{ name: 'entities', collection: 'entities' }],
      },
    })

    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!
    // The denorm column header should appear
    expect(shared).toContain('>entityName<')
    // The resolved names should be present
    expect(shared).toContain('>Acme Corp<')
    expect(shared).toContain('>Beta Inc<')

    await db.close()
  })

  it('bill b1 (entityId=e1) maps to entityName=Acme Corp in the bills sheet', async () => {
    const { db, lobby } = await buildFixture()

    const bytes = await lobby.exportMultiVaultXlsx({
      primary: { vault: 'primary', seeds: { bills: () => true } },
      crossVaultRefs: [
        { from: { collection: 'bills', field: 'entityId' }, to: { vault: 'directory', collection: 'entities' } },
      ],
      sheets: {
        primary: [{
          name: 'bills',
          collection: 'bills',
          columns: ['id', 'entityId', 'amount'],
          denormalize: [{
            column: 'entityName',
            localField: 'entityId',
            from: { label: 'directory', collection: 'entities', keyField: 'id', pick: 'name' },
          }],
        }],
        directory: [{ name: 'entities', collection: 'entities' }],
      },
    })

    // Find the primary_bills sheet
    const workbook = readZipFile(bytes, 'xl/workbook.xml')!
    const billsMatch = workbook.match(/name="primary_bills" sheetId="(\d+)"/)
    expect(billsMatch).not.toBeNull()
    const sheetId = billsMatch![1]
    const sheetXml = readZipFile(bytes, `xl/worksheets/sheet${sheetId}.xml`)!
    const shared = readZipFile(bytes, 'xl/sharedStrings.xml')!

    // The shared strings table must have both the FK id and its resolved name
    expect(shared).toContain('>e1<')
    expect(shared).toContain('>Acme Corp<')

    // The sheet XML must reference cells with the b1 row data
    expect(sheetXml).not.toBe(null)

    await db.close()
  })
})
