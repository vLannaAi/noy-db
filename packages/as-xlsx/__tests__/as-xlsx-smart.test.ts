/**
 * #414 P1 — smart-workbook export. `toBytes(vault, { smart: true })` emits a
 * relational workbook: id-first sheets, a `_manifest` index, and FK→VLOOKUP
 * label columns (auto-detected via dumpSchema) carrying a cached resolved label.
 */
import { describe, expect, it } from 'vitest'
import { createNoydb, ref } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { readZip } from '@noy-db/as-zip'
import { toBytes, readXlsx, formula } from '../src/index.js'

const DEC = new TextDecoder()

interface Client { id: string; name: string }
interface Invoice { id: string; clientId: string; amount: number }

async function setup() {
  const adapter = memory()
  const init = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
  await init.openVault('firm')
  await init.grant('firm', {
    userId: 'alice', displayName: 'Alice', role: 'owner', passphrase: 'pw-2026',
    exportCapability: { plaintext: ['xlsx'] },
  })
  init.close()

  const db = await createNoydb({ store: adapter, user: 'alice', secret: 'pw-2026' })
  const vault = await db.openVault('firm')
  await vault.collection<Client>('clients').put('c1', { id: 'c1', name: 'Acme' })
  await vault.collection<Invoice>('invoices', { refs: { clientId: ref('clients', 'strict') } })
    .put('i1', { id: 'i1', clientId: 'c1', amount: 100 })
  return { vault }
}

/** Build a header-name → column-letter map from a readXlsx sheet's first row. */
function headerMap(sheet: { rows: readonly Record<string, unknown>[] }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [letter, name] of Object.entries(sheet.rows[0] ?? {})) out[String(name)] = letter
  return out
}

describe('#414 P1 — smart export', () => {
  it('emits a _manifest sheet listing collections + refs', async () => {
    const { vault } = await setup()
    const wb = await readXlsx(await toBytes(vault, {
      smart: true,
      sheets: [{ name: 'clients', collection: 'clients' }, { name: 'invoices', collection: 'invoices' }],
    }))
    const manifest = wb.sheets.find((s) => s.name === '_manifest')!
    expect(manifest).toBeTruthy()
    const h = headerMap(manifest)
    const invRow = manifest.rows.slice(1).find((r) => r[h['Collection']!] === 'invoices')!
    expect(invRow[h['Refs']!]).toBe('clientId→clients')
  })

  it('FK field gets a VLOOKUP label column with the cached resolved label', async () => {
    const { vault } = await setup()
    const inv = (await readXlsx(await toBytes(vault, {
      smart: true,
      sheets: [{ name: 'clients', collection: 'clients' }, { name: 'invoices', collection: 'invoices' }],
    }))).sheets.find((s) => s.name === 'invoices')!

    const h = headerMap(inv)
    expect(h['id']).toBe('A') // id-first
    expect(h['clientId__label']).toBeTruthy()
    const row = inv.rows.slice(1).find((r) => r[h['id']!] === 'i1')!
    // cached value of the VLOOKUP = the client's first field ('Acme')
    expect(row[h['clientId__label']!]).toBe('Acme')
  })

  it('numberFormats: a money field becomes a numeric cell with a number-format style', async () => {
    const { vault } = await setup()
    const bytes = await toBytes(vault, {
      smart: true,
      sheets: [
        { name: 'clients', collection: 'clients' },
        { name: 'invoices', collection: 'invoices', numberFormats: { amount: '#,##0.00' } },
      ],
    })
    const inv = (await readXlsx(bytes)).sheets.find((s) => s.name === 'invoices')!
    const h = headerMap(inv)
    expect(inv.rows.slice(1).find((r) => r[h['id']!] === 'i1')![h['amount']!]).toBe(100) // numeric, not '100'

    const styles = (await readZip(bytes)).find((p) => p.path === 'xl/styles.xml')
    expect(styles).toBeTruthy()
    expect(DEC.decode(styles!.bytes)).toContain('#,##0.00')
  })

  it('dropdowns: an FK field gets a data-validation list referencing the target sheet', async () => {
    const { vault } = await setup()
    const bytes = await toBytes(vault, {
      smart: true,
      sheets: [{ name: 'clients', collection: 'clients' }, { name: 'invoices', collection: 'invoices' }],
    })
    const sheetXmls = (await readZip(bytes))
      .filter((p) => /xl\/worksheets\/sheet\d+\.xml/.test(p.path))
      .map((p) => DEC.decode(p.bytes))
    expect(sheetXmls.some((x) => x.includes('<dataValidation') && x.includes("clients'!$A$2"))).toBe(true)
  })

  it('formula() emits a live <f> with a cached value (round-trips via readXlsx)', async () => {
    const { writeXlsx } = await import('../src/index.js')
    const bytes = await writeXlsx([{ name: 's', header: ['x'], rows: [[formula('1+2', 3)]] }])
    const wb = await readXlsx(bytes)
    expect(wb.sheets[0]!.rows[1]!['A']).toBe(3) // cached value readable
  })
})
