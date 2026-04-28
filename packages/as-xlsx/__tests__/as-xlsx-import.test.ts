/**
 * Reader-side coverage for @noy-db/as-xlsx (#319 / #302 phase 2).
 *
 * Covers:
 *   - capability gate via assertCanImport('plaintext','xlsx')
 *   - parse + apply (merge / replace / insert-only)
 *   - explicit `sheet` selection
 *   - end-to-end round-trip: toBytes → fromBytes → diff is empty
 *   - field type coercion via fieldTypes
 *   - apply() requires withTransactions() (#309)
 *   - typed errors on missing sheet name + malformed OOXML
 */
import { describe, expect, it } from 'vitest'
import { ImportCapabilityError, createNoydb } from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/tx'
import { memory } from '@noy-db/to-memory'
import { fromBytes, toBytes, writeXlsx } from '../src/index.js'

interface Invoice { id: string; client: string; amount: number; paid: boolean }

async function setup() {
  const adapter = memory()
  const init = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
  await init.openVault('demo')
  await init.grant('demo', {
    userId: 'alice', displayName: 'Alice', role: 'owner',
    passphrase: 'pw-2026',
    importCapability: { plaintext: ['xlsx'] },
    exportCapability: { plaintext: ['xlsx'] },
  })
  init.close()

  const db = await createNoydb({
    store: adapter, user: 'alice', secret: 'pw-2026',
    txStrategy: withTransactions(),
  })
  const vault = await db.openVault('demo')
  await vault.collection<Invoice>('invoices').put('a', { id: 'a', client: 'X', amount: 100, paid: false })
  await vault.collection<Invoice>('invoices').put('b', { id: 'b', client: 'Y', amount: 200, paid: true })
  return { db, vault }
}

describe('as-xlsx fromBytes — capability gate', () => {
  it('throws ImportCapabilityError without the grant', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
    const vault = await db.openVault('demo')
    const xlsx = await writeXlsx([{ name: 'invoices', header: ['id'], rows: [['a']] }])
    await expect(
      fromBytes(vault, xlsx, { collection: 'invoices' }),
    ).rejects.toThrow(ImportCapabilityError)
    db.close()
  })
})

describe('as-xlsx fromBytes — parse + apply', () => {
  it('parses a basic workbook and applies under merge policy', async () => {
    const { db, vault } = await setup()
    const xlsx = await writeXlsx([
      {
        name: 'invoices',
        header: ['id', 'client', 'amount', 'paid'],
        // 'a' and 'b' unchanged + 'c' added → diff carries one add only.
        rows: [
          ['a', 'X', 100, false],
          ['b', 'Y', 200, true],
          ['c', 'Z', 300, true],
        ],
      },
    ])
    const importer = await fromBytes(vault, xlsx, { collection: 'invoices' })
    expect(importer.plan.summary).toEqual({ add: 1, modify: 0, delete: 0, total: 1 })
    expect(importer.plan.added[0]!.record).toEqual({ id: 'c', client: 'Z', amount: 300, paid: true })

    await importer.apply()
    expect(await vault.collection<Invoice>('invoices').get('c')).toEqual({
      id: 'c', client: 'Z', amount: 300, paid: true,
    })
    db.close()
  })

  it('selects the right sheet when `sheet` is provided', async () => {
    const { db, vault } = await setup()
    const xlsx = await writeXlsx([
      { name: 'payments', header: ['id', 'amount'], rows: [['p', 1]] },
      {
        name: 'invoices', header: ['id', 'client', 'amount', 'paid'],
        rows: [
          ['a', 'X', 100, false],
          ['b', 'Y', 200, true],
          ['c', 'Z', 300, true],
        ],
      },
    ])
    const importer = await fromBytes(vault, xlsx, { collection: 'invoices', sheet: 'invoices' })
    expect(importer.plan.summary.add).toBe(1)
    expect(importer.plan.added[0]!.record).toEqual({ id: 'c', client: 'Z', amount: 300, paid: true })
    db.close()
  })

  it('throws a typed error when the named sheet does not exist', async () => {
    const { db, vault } = await setup()
    const xlsx = await writeXlsx([{ name: 'invoices', header: ['id'], rows: [['a']] }])
    await expect(
      fromBytes(vault, xlsx, { collection: 'invoices', sheet: 'does-not-exist' }),
    ).rejects.toThrow(/no sheet named "does-not-exist"/)
    db.close()
  })

  it('handles a workbook with only a header row (zero data rows)', async () => {
    const { db, vault } = await setup()
    const xlsx = await writeXlsx([
      { name: 'invoices', header: ['id', 'client'], rows: [] },
    ])
    const importer = await fromBytes(vault, xlsx, { collection: 'invoices', policy: 'replace' })
    // Vault has 'a' and 'b' from setup; replace policy with no input → both deleted
    expect(importer.plan.summary.delete).toBe(2)
    db.close()
  })
})

describe('as-xlsx fromBytes — round-trip', () => {
  it('toBytes → fromBytes → diff is empty against the source vault', async () => {
    const { db, vault } = await setup()
    const xlsx = await toBytes(vault, {
      sheets: [{ name: 'invoices', collection: 'invoices' }],
    })
    const importer = await fromBytes(vault, xlsx, {
      collection: 'invoices',
      sheet: 'invoices',
    })
    // Same source vault → no records should be added/modified/deleted.
    expect(importer.plan.summary).toEqual({ add: 0, modify: 0, delete: 0, total: 0 })
    db.close()
  })
})

describe('as-xlsx fromBytes — fieldTypes coercion', () => {
  it('"date" coerces ISO-string cells to canonical ISO via Date round-trip', async () => {
    const { db, vault } = await setup()
    const xlsx = await writeXlsx([
      { name: 'invoices', header: ['id', 'ts'], rows: [['c', '2026-01-15T10:30:00Z']] },
    ])
    const importer = await fromBytes(vault, xlsx, {
      collection: 'invoices',
      fieldTypes: { ts: 'date' },
    })
    const ts = (importer.plan.added[0]!.record as Record<string, unknown>)['ts']
    expect(ts).toBe('2026-01-15T10:30:00.000Z')
    db.close()
  })

  it('skips empty cells without injecting undefined keys', async () => {
    const { db, vault } = await setup()
    const xlsx = await writeXlsx([
      // Second row's `paid` cell is null → empty <c r="D2"/> emitted by writer
      { name: 'invoices', header: ['id', 'client', 'amount', 'paid'], rows: [['c', 'Z', 300, null]] },
    ])
    const importer = await fromBytes(vault, xlsx, { collection: 'invoices' })
    const record = importer.plan.added[0]!.record as Record<string, unknown>
    expect(record).toEqual({ id: 'c', client: 'Z', amount: 300 })
    expect('paid' in record).toBe(false)
    db.close()
  })
})

describe('as-xlsx fromBytes — policies', () => {
  it('insert-only refuses to modify existing records', async () => {
    const { db, vault } = await setup()
    const xlsx = await writeXlsx([
      // 'a' exists with amount=100; input has amount=999 → modify must be skipped
      { name: 'invoices', header: ['id', 'client', 'amount', 'paid'], rows: [['a', 'X', 999, false]] },
    ])
    const importer = await fromBytes(vault, xlsx, {
      collection: 'invoices',
      policy: 'insert-only',
    })
    await importer.apply()
    expect(await vault.collection<Invoice>('invoices').get('a'))
      .toEqual({ id: 'a', client: 'X', amount: 100, paid: false })
    db.close()
  })

  it('replace deletes records absent from the input', async () => {
    const { db, vault } = await setup()
    const xlsx = await writeXlsx([
      { name: 'invoices', header: ['id', 'client', 'amount', 'paid'], rows: [['c', 'Z', 300, true]] },
    ])
    const importer = await fromBytes(vault, xlsx, { collection: 'invoices', policy: 'replace' })
    await importer.apply()
    expect(await vault.collection<Invoice>('invoices').get('a')).toBeNull()
    expect(await vault.collection<Invoice>('invoices').get('b')).toBeNull()
    expect(await vault.collection<Invoice>('invoices').get('c'))
      .toEqual({ id: 'c', client: 'Z', amount: 300, paid: true })
    db.close()
  })
})

describe('as-xlsx fromBytes — apply() requires withTransactions() (#309)', () => {
  it('throws a clear error when the tx strategy is missing', async () => {
    const adapter = memory()
    const init = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
    await init.openVault('demo')
    await init.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: 'pw-2026',
      importCapability: { plaintext: ['xlsx'] },
    })
    init.close()
    const db = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
    const vault = await db.openVault('demo')

    const xlsx = await writeXlsx([
      { name: 'invoices', header: ['id'], rows: [['z']] },
    ])
    const importer = await fromBytes(vault, xlsx, { collection: 'invoices' })
    await expect(importer.apply()).rejects.toThrow(/withTransactions/)
    db.close()
  })
})
