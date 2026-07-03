/**
 * as-xlsx `redact` option (#489) — classified/sensitivity-aware sheets via
 * `applyListProjection`.
 *
 * Mirrors `as-csv`'s `redact.test.ts` (776fd56a), swapped onto the xlsx
 * flat-export path. Reads the produced workbook back with `readXlsx` (the
 * same helper `as-xlsx-smart.test.ts` uses) rather than parsing raw XML.
 */
import { describe, expect, it } from 'vitest'
import { createNoydb, classified } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { toBytes, readXlsx } from '../src/index.js'

/**
 * Builds a fresh vault whose owner already holds the `plaintext: ['xlsx']`
 * export grant (mirrors this suite's `seedVault()`/`grantXlsx()` dance: the
 * grant must be persisted and the vault reopened before the new capability
 * is visible on the session).
 */
async function makeVault() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  await db.openVault('acme')
  await db.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    passphrase: 'owner-pass',
    exportCapability: { plaintext: ['xlsx'] },
  })
  await db.close()

  const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  return db2.openVault('acme')
}

/** Build a header-name → column-letter map from a readXlsx sheet's first row. */
function headerMap(sheet: { rows: readonly Record<string, unknown>[] }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [letter, name] of Object.entries(sheet.rows[0] ?? {})) out[String(name)] = letter
  return out
}

describe('as-xlsx redact (#489)', () => {
  it('redact: true masks classified fields and keeps riders', async () => {
    const v = await makeVault()
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await c.put('r1', { pan: '4242424242424242', total: 9 })

    const bytes = await toBytes(v, {
      sheets: [{ name: 'cards', collection: 'cards' }],
      redact: true,
    })
    const sheet = (await readXlsx(bytes)).sheets.find((s) => s.name === 'cards')!
    const h = headerMap(sheet)
    const row = sheet.rows.slice(1).find((r) => r[h['total']!] === 9)!
    expect(row[h['pan']!]).toBe('•••• 4242')
    expect(Object.values(row)).not.toContain('4242424242424242')
  })

  it('redact: { sensitivity: "omit" } drops plain pii-tagged columns', async () => {
    const v = await makeVault()
    const c = v.collection('people', { fieldMeta: { note: { label: 'N', sensitivity: 'pii' } } })
    await c.put('p1', { name: 'x', note: 'private' })

    const bytes = await toBytes(v, {
      sheets: [{ name: 'people', collection: 'people' }],
      redact: { sensitivity: 'omit' },
    })
    const sheet = (await readXlsx(bytes)).sheets.find((s) => s.name === 'people')!
    const h = headerMap(sheet)
    expect(h['note']).toBeUndefined()
    expect(sheet.rows.some((r) => Object.values(r).includes('x'))).toBe(true)
    expect(sheet.rows.some((r) => Object.values(r).includes('private'))).toBe(false)
  })

  it('smart path: redact: true masks classified fields on the id-first sheet', async () => {
    const v = await makeVault()
    const c = v.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await c.put('r1', { id: 'r1', pan: '4242424242424242', total: 9 })

    const bytes = await toBytes(v, {
      smart: true,
      sheets: [{ name: 'cards', collection: 'cards' }],
      redact: true,
    })
    const sheet = (await readXlsx(bytes)).sheets.find((s) => s.name === 'cards')!
    const h = headerMap(sheet)
    const row = sheet.rows.slice(1).find((r) => r[h['id']!] === 'r1')!
    expect(row[h['pan']!]).toBe('•••• 4242')
    expect(Object.values(row)).not.toContain('4242424242424242')
  })
})
