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
import { toMemory } from '@noy-db/to-memory'
import { toBytes, toBytesMultiVault, readXlsx } from '../src/index.js'
import { withTeam } from '@noy-db/hub/team'

/**
 * Builds a fresh vault whose owner already holds the `plaintext: ['xlsx']`
 * export grant (mirrors this suite's `seedVault()`/`grantXlsx()` dance: the
 * grant must be persisted and the vault reopened before the new capability
 * is visible on the session).
 */
async function makeVault() {
  const adapter = toMemory()
  const db = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
  await db.openVault('acme')
  await db.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    secret: 'owner-pass',
    exportCapability: { plaintext: ['xlsx'] },
  })
  await db.close()

  const db2 = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass' })
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

  it('multi-vault: entry-level redact only masks the sheet whose entry opted in', async () => {
    const vRedacted = await makeVault()
    const cRedacted = vRedacted.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await cRedacted.put('r1', { pan: '4242424242424242', total: 9 })

    const vPlain = await makeVault()
    const cPlain = vPlain.collection('cards', {
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
    })
    await cPlain.put('r1', { pan: '4111111111111111', total: 5 })

    const bytes = await toBytesMultiVault([
      {
        vault: vRedacted, label: 'redacted',
        sheets: [{ name: 'cards', collection: 'cards' }],
        redact: true,
      },
      {
        vault: vPlain, label: 'plain',
        sheets: [{ name: 'cards', collection: 'cards' }],
      },
    ])

    const wb = await readXlsx(bytes)
    const redactedSheet = wb.sheets.find((s) => s.name === 'redacted_cards')!
    const hR = headerMap(redactedSheet)
    const rowR = redactedSheet.rows.slice(1).find((r) => r[hR['total']!] === 9)!
    expect(rowR[hR['pan']!]).toBe('•••• 4242')
    expect(Object.values(rowR)).not.toContain('4242424242424242')

    // The non-redacted entry is untouched: `pan` is a classified 'recoverable'
    // field, so unprojected it stays a SealedHandle — never the raw PAN, and
    // never masked either. It serializes via its non-leaking `toJSON()`.
    const plainSheet = wb.sheets.find((s) => s.name === 'plain_cards')!
    const hP = headerMap(plainSheet)
    const rowP = plainSheet.rows.slice(1).find((r) => r[hP['total']!] === 5)!
    expect(rowP[hP['pan']!]).toBe('"[sealed]"')
    expect(Object.values(rowP)).not.toContain('4111111111111111')
    expect(Object.values(rowP)).not.toContain('•••• 1111')
  })
})
