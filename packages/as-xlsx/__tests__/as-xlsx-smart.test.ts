/**
 * #414 P1 — smart-workbook export. `toBytes(vault, { smart: true })` emits a
 * relational workbook: id-first sheets, a `_manifest` index, and FK→VLOOKUP
 * label columns (auto-detected via dumpSchema) carrying a cached resolved label.
 */
import { describe, expect, it } from 'vitest'
import { createNoydb, ref } from '@noy-db/hub'
import { withI18n, i18nText, dictKey } from '@noy-db/hub/i18n'
import { withTransactions } from '@noy-db/hub/transactions'
import { toMemory } from '@noy-db/to-memory'
import { readZip } from '@noy-db/as-zip'
import { toBytes, readXlsx, formula, fromBytes, writeXlsx, inferSchema, zodSourceFor } from '../src/index.js'
import { withTeam } from '@noy-db/hub/team'

const DEC = new TextDecoder()

interface Client { id: string; name: string }
interface Invoice { id: string; clientId: string; amount: number }

async function setup() {
  const adapter = toMemory()
  const init = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-2026' })
  await init.openVault('firm')
  await init.grant('firm', {
    userId: 'alice', displayName: 'Alice', role: 'owner', secret: 'pw-2026',
    exportCapability: { plaintext: ['xlsx'] },
  })
  init.close()

  const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-2026' })
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

  it('P2: global LANG cell + i18n locale columns with a live display formula', async () => {
    const adapter = toMemory()
    const init = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-i18n' })
    await init.openVault('shop')
    await init.grant('shop', {
      userId: 'alice', displayName: 'Alice', role: 'owner', secret: 'pw-i18n',
      exportCapability: { plaintext: ['xlsx'] },
    })
    init.close()
    const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-i18n', i18nStrategy: withI18n() })
    const vault = await db.openVault('shop') // no active locale → raw i18n maps
    await vault.collection<{ id: string; name: Record<string, string> }>('products', {
      i18nFields: { name: i18nText({ languages: ['en', 'th'], required: 'all' }) },
    }).put('p1', { id: 'p1', name: { en: 'Widget', th: 'วิดเจ็ต' } })

    const bytes = await toBytes(vault, {
      smart: true,
      sheets: [{ name: 'products', collection: 'products', i18nFields: ['name'] }],
    })
    const wb = await readXlsx(bytes)
    expect(wb.sheets.map((s) => s.name)).toContain('_settings')

    const prod = wb.sheets.find((s) => s.name === 'products')!
    const h = headerMap(prod)
    expect(h['name'] && h['name__en'] && h['name__th']).toBeTruthy()
    const row = prod.rows.slice(1).find((r) => r[h['id']!] === 'p1')!
    expect(row[h['name']!]).toBe('Widget') // display cached at default locale (en)
    expect(row[h['name__th']!]).toBe('วิดเจ็ต') // raw per-locale column

    // LANG named range present in the workbook
    const wbxml = (await readZip(bytes)).find((p) => p.path === 'xl/workbook.xml')!
    expect(DEC.decode(wbxml.bytes)).toContain('name="LANG"')
  })

  it('P2 dict: a _Lookups sheet + a LANG-driven VLOOKUP label column', async () => {
    const adapter = toMemory()
    const init = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-dict' })
    await init.openVault('co')
    await init.grant('co', {
      userId: 'alice', displayName: 'Alice', role: 'owner', secret: 'pw-dict',
      exportCapability: { plaintext: ['xlsx'] },
    })
    init.close()
    const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-dict', i18nStrategy: withI18n() })
    const vault = await db.openVault('co')
    await vault.dictionary('status').putAll({
      paid: { en: 'Paid', th: 'ชำระแล้ว' },
      draft: { en: 'Draft', th: 'ฉบับร่าง' },
    } as Record<string, Record<string, string>>)
    await vault.collection<{ id: string; status: string }>('orders', {
      dictKeyFields: { status: dictKey('status', ['paid', 'draft'] as const) },
    }).put('o1', { id: 'o1', status: 'paid' })

    const wb = await readXlsx(await toBytes(vault, {
      smart: true,
      sheets: [{ name: 'orders', collection: 'orders', dictFields: { status: 'status' } }],
    }))
    expect(wb.sheets.map((s) => s.name)).toEqual(expect.arrayContaining(['_settings', '_Lookups_status', 'orders']))

    const orders = wb.sheets.find((s) => s.name === 'orders')!
    const h = headerMap(orders)
    expect(h['status__label']).toBeTruthy()
    expect(orders.rows.slice(1).find((r) => r[h['id']!] === 'o1')![h['status__label']!]).toBe('Paid')

    const lk = wb.sheets.find((s) => s.name === '_Lookups_status')!
    const lh = headerMap(lk)
    expect(lh['Code'] && lh['en'] && lh['th']).toBeTruthy()
    expect(lk.rows.slice(1).find((r) => r[lh['Code']!] === 'paid')![lh['en']!]).toBe('Paid')
  })

  it('P3: groupBy summary sheet with live SUMIFS/COUNTIFS + cached values', async () => {
    const adapter = toMemory()
    const init = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-sum' })
    await init.openVault('firm')
    await init.grant('firm', {
      userId: 'alice', displayName: 'Alice', role: 'owner', secret: 'pw-sum',
      exportCapability: { plaintext: ['xlsx'] },
    })
    init.close()
    const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-sum' })
    const vault = await db.openVault('firm')
    await vault.collection<Client>('clients').put('c1', { id: 'c1', name: 'Acme' })
    const invoices = vault.collection<Invoice>('invoices', { refs: { clientId: ref('clients', 'strict') } })
    await invoices.put('i1', { id: 'i1', clientId: 'c1', amount: 100 })
    await invoices.put('i2', { id: 'i2', clientId: 'c1', amount: 50 })

    const bytes = await toBytes(vault, {
      smart: true,
      sheets: [{ name: 'clients', collection: 'clients' }, { name: 'invoices', collection: 'invoices' }],
      summaries: [
        {
          name: 'byClient',
          from: 'invoices',
          groupBy: 'clientId',
          aggregates: [{ label: 'total', op: 'sum', field: 'amount' }, { label: 'n', op: 'count' }],
        },
      ],
    })
    const wb = await readXlsx(bytes)
    const sum = wb.sheets.find((s) => s.name === 'byClient')!
    expect(sum).toBeTruthy()
    const h = headerMap(sum)
    const row = sum.rows.slice(1).find((r) => r[h['clientId']!] === 'c1')!
    expect(row[h['total']!]).toBe(150) // cached SUMIFS
    expect(row[h['n']!]).toBe(2) // cached COUNTIFS

    const xmls = (await readZip(bytes)).filter((p) => /sheet\d+\.xml/.test(p.path)).map((p) => DEC.decode(p.bytes))
    expect(xmls.some((x) => x.includes('SUMIFS('))).toBe(true)
  })

  it('P4 smart import: reverses the smart layout — rebuilds i18n maps, drops derived columns', async () => {
    const adapter = toMemory()
    const init = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-rt' })
    await init.openVault('shop')
    await init.grant('shop', {
      userId: 'alice', displayName: 'Alice', role: 'owner', secret: 'pw-rt',
      exportCapability: { plaintext: ['xlsx'] }, importCapability: { plaintext: ['xlsx'] },
    })
    init.close()
    const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'alice', secret: 'pw-rt', i18nStrategy: withI18n(), transactionsStrategy: withTransactions() })
    const vault = await db.openVault('shop')
    const products = vault.collection<{ id: string; name: Record<string, string> }>('products', {
      i18nFields: { name: i18nText({ languages: ['en', 'th'], required: 'all' }) },
    })
    await products.put('p1', { id: 'p1', name: { en: 'Widget', th: 'วิดเจ็ต' } })

    const bytes = await toBytes(vault, { smart: true, sheets: [{ name: 'products', collection: 'products', i18nFields: ['name'] }] })

    // Drop then re-import to prove the smart reader rebuilds the record.
    await products.delete('p1')
    const plan = await fromBytes(vault, bytes, { collection: 'products', sheet: 'products', smart: true, policy: 'merge' })
    await plan.apply()

    expect(await products.get('p1')).toEqual({ id: 'p1', name: { en: 'Widget', th: 'วิดเจ็ต' } })
  })

  it('P5 sheets dialect: a summary emits a single Google-Sheets QUERY formula', async () => {
    const { vault } = await setup()
    const bytes = await toBytes(vault, {
      smart: true,
      dialect: 'sheets',
      sheets: [{ name: 'clients', collection: 'clients' }, { name: 'invoices', collection: 'invoices' }],
      summaries: [{
        name: 'byClient',
        from: 'invoices',
        groupBy: 'clientId',
        aggregates: [{ label: 'total', op: 'sum', field: 'amount' }, { label: 'n', op: 'count' }],
      }],
    })
    const xmls = (await readZip(bytes)).filter((p) => /sheet\d+\.xml/.test(p.path)).map((p) => DEC.decode(p.bytes))
    expect(xmls.some((x) => x.includes('QUERY(') && x.includes('SELECT') && x.includes('GROUP BY'))).toBe(true)
    // and NOT a per-row SUMIFS (that's the excel dialect)
    expect(xmls.some((x) => x.includes('SUMIFS('))).toBe(false)
  })

  it('P4 Mode B: infers a schema (types + FK) from an arbitrary workbook', async () => {
    const bytes = await writeXlsx([
      { name: 'clients', header: ['id', 'name'], rows: [['c1', 'Acme'], ['c2', 'Beta']] },
      { name: 'invoices', header: ['id', 'clientId', 'amount', 'paid'], rows: [['i1', 'c1', 100, true]] },
    ])
    const schema = await inferSchema(bytes)
    expect(schema.collections['clients']!.idField).toBe('id')
    expect(schema.collections['clients']!.fields['name']!.type).toBe('string')
    expect(schema.collections['invoices']!.fields['amount']!.type).toBe('number')
    expect(schema.collections['invoices']!.fields['paid']!.type).toBe('boolean')
    expect(schema.collections['invoices']!.fields['clientId']!.references).toBe('clients')
    expect(zodSourceFor(schema)).toContain('z.number()')
  })

  it('formula() emits a live <f> with a cached value (round-trips via readXlsx)', async () => {
    const { writeXlsx } = await import('../src/index.js')
    const bytes = await writeXlsx([{ name: 's', header: ['x'], rows: [[formula('1+2', 3)]] }])
    const wb = await readXlsx(bytes)
    expect(wb.sheets[0]!.rows[1]!['A']).toBe(3) // cached value readable
  })
})
