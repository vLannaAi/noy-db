/**
 * Showcase 51 — as-blob / as-xml / as-xlsx readers
 *
 * What you'll learn
 * ─────────────────
 * The reader-family completes the symmetric `as-*` import surface
 * shipped in #302 phase 1 (csv / json / ndjson / zip) with three new
 * readers that landed in #302 phase 2:
 *
 *   - `as-blob.fromBytes`  — single-attachment import (#317)
 *   - `as-xml.fromString`  — XML element-name → field mapping (#318)
 *   - `as-xlsx.fromBytes`  — OOXML workbook → records (#319)
 *
 * Every reader follows the same shape — `assertCanImport('plaintext',
 * <format>)` gate (#308), preview as `ImportPlan`, `apply()` inside
 * `vault.noydb.transaction(...)` for atomic rollback (#309).
 *
 * Why it matters
 * ──────────────
 * The `to-*` taxonomy is for live encrypted storage. The `as-*`
 * taxonomy is for authorized artefact extraction — and now, equally,
 * authorized artefact INGESTION. Plaintext bytes coming back IN need
 * the same explicit grant as plaintext bytes going OUT.
 *
 * Spec mapping
 * ────────────
 * features.yaml → exports → as-blob / as-xml / as-xlsx (#308 #309 #317 #318 #319)
 */

import { describe, it, expect } from 'vitest'
import { ImportCapabilityError, createNoydb, type ExportFormat } from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/tx'
import { withBlobs } from '@noy-db/hub/blobs'
import { fromBytes as blobFromBytes, toBytes as blobToBytes } from '@noy-db/as-blob'
import { fromString as xmlFromString, toString as xmlToString } from '@noy-db/as-xml'
import { fromBytes as xlsxFromBytes, toBytes as xlsxToBytes, writeXlsx } from '@noy-db/as-xlsx'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; client: string; amount: number }

const PASS = 'showcase-51-pw'

async function bootstrap(formats: readonly ExportFormat[], options?: { withBlobs?: boolean }) {
  const store = memory()
  const init = await createNoydb({
    store, user: 'alice', secret: PASS,
    ...(options?.withBlobs ? { blobStrategy: withBlobs() } : {}),
  })
  await init.openVault('demo')
  await init.grant('demo', {
    userId: 'alice', displayName: 'Alice', role: 'owner',
    passphrase: PASS,
    importCapability: { plaintext: formats },
    exportCapability: { plaintext: formats },
  })
  init.close()

  const db = await createNoydb({
    store, user: 'alice', secret: PASS,
    txStrategy: withTransactions(),
    ...(options?.withBlobs ? { blobStrategy: withBlobs() } : {}),
  })
  return { db, vault: await db.openVault('demo'), store }
}

describe('Showcase 51 — capability gate (#308)', () => {
  it('a vault without a positive import grant refuses the reader', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: PASS })
    const vault = await db.openVault('demo')
    await expect(
      xmlFromString(vault, '<Records><Invoice><id>a</id></Invoice></Records>', {
        collection: 'invoices',
      }),
    ).rejects.toThrow(ImportCapabilityError)
    db.close()
  })

  it('owner DEFAULT-CLOSED — must positively grant per format (even for owner)', async () => {
    // No `grant()` call at all on the brand-new vault — the bootstrap
    // owner keyring carries no importCapability and the reader refuses.
    const store = memory()
    const db = await createNoydb({ store, user: 'owner', secret: 'pw' })
    const vault = await db.openVault('acme')
    await expect(
      xmlFromString(vault, '<Records></Records>', { collection: 'x' }),
    ).rejects.toThrow(ImportCapabilityError)
    db.close()
  })
})

describe('Showcase 51 — as-xml round-trip (#318)', () => {
  it('toString → fromString reconstructs the source vault', async () => {
    const { db, vault } = await bootstrap(['xml'])
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', client: 'Acme', amount: 100 })
    await vault.collection<Invoice>('invoices').put('b', { id: 'b', client: 'Globex', amount: 200 })

    const xml = await xmlToString(vault, { collection: 'invoices' })
    const importer = await xmlFromString(vault, xml, {
      collection: 'invoices',
      fieldTypes: { amount: 'number' },
    })
    expect(importer.plan.summary).toEqual({ add: 0, modify: 0, delete: 0, total: 0 })
    db.close()
  })
})

describe('Showcase 51 — as-xlsx round-trip (#319)', () => {
  it('toBytes → fromBytes reconstructs the source vault', async () => {
    const { db, vault } = await bootstrap(['xlsx'])
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', client: 'Acme', amount: 100 })
    await vault.collection<Invoice>('invoices').put('b', { id: 'b', client: 'Globex', amount: 200 })

    const xlsx = await xlsxToBytes(vault, {
      sheets: [{ name: 'invoices', collection: 'invoices' }],
    })
    const importer = await xlsxFromBytes(vault, xlsx, {
      collection: 'invoices', sheet: 'invoices',
    })
    expect(importer.plan.summary).toEqual({ add: 0, modify: 0, delete: 0, total: 0 })
    db.close()
  })

  it('multi-sheet workbook: `sheet` picks the right one', async () => {
    const { db, vault } = await bootstrap(['xlsx'])
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', client: 'A', amount: 1 })
    const xlsx = await writeXlsx([
      { name: 'payments', header: ['id', 'amount'], rows: [['p', 999]] },
      {
        name: 'invoices', header: ['id', 'client', 'amount'],
        rows: [
          ['a', 'A', 1],     // unchanged
          ['b', 'B', 2],     // added
        ],
      },
    ])
    const importer = await xlsxFromBytes(vault, xlsx, {
      collection: 'invoices', sheet: 'invoices',
    })
    expect(importer.plan.summary.add).toBe(1)
    expect(importer.plan.added[0]!.id).toBe('b')
    db.close()
  })
})

describe('Showcase 51 — as-blob round-trip (#317)', () => {
  it('write blob → fromBytes new bytes → toBytes returns new bytes', async () => {
    const { db, vault } = await bootstrap(['blob'], { withBlobs: true })
    await vault.collection('docs').put('d-1', { id: 'd-1', title: 'first' })

    const ORIGINAL = new Uint8Array([0x01, 0x02, 0x03])
    const REPLACEMENT = new Uint8Array([0xaa, 0xbb, 0xcc])

    const first = await blobFromBytes(vault, ORIGINAL, { collection: 'docs', id: 'd-1' })
    expect(first.status).toBe('added')
    await first.apply()

    const second = await blobFromBytes(vault, REPLACEMENT, { collection: 'docs', id: 'd-1' })
    expect(second.status).toBe('modified')
    await second.apply()

    const round = await blobToBytes(vault, { collection: 'docs', id: 'd-1' })
    expect(round.bytes).toEqual(REPLACEMENT)
    db.close()
  })

  it('insert-only refuses to overwrite', async () => {
    const { db, vault } = await bootstrap(['blob'], { withBlobs: true })
    await vault.collection('docs').put('d-1', { id: 'd-1' })
    const first = await blobFromBytes(vault, new Uint8Array([1]), { collection: 'docs', id: 'd-1' })
    await first.apply()
    await expect(
      blobFromBytes(vault, new Uint8Array([2]), {
        collection: 'docs', id: 'd-1', policy: 'insert-only',
      }),
    ).rejects.toThrow(/insert-only refused/)
    db.close()
  })
})

describe('Showcase 51 — transactional apply (#309)', () => {
  it('apply() requires withTransactions() — clear error pointing at the strategy', async () => {
    // Bootstrap WITHOUT txStrategy — apply() must reject with a clear
    // pointer at withTransactions().
    const store = memory()
    const init = await createNoydb({ store, user: 'alice', secret: PASS })
    await init.openVault('demo')
    await init.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: PASS,
      importCapability: { plaintext: ['xml'] },
    })
    init.close()
    const db = await createNoydb({ store, user: 'alice', secret: PASS })
    const vault = await db.openVault('demo')

    const importer = await xmlFromString(vault,
      '<Records><Invoice><id>x</id></Invoice></Records>',
      { collection: 'invoices' })
    await expect(importer.apply()).rejects.toThrow(/withTransactions/)
    db.close()
  })
})
