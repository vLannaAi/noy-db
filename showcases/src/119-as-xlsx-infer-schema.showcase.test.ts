/**
 * Showcase 119 — as-xlsx schema inference (#414 P4 Mode B)
 *
 * What you'll learn
 * ─────────────────
 * Point `inferSchema(bytes)` at an ARBITRARY workbook (not one we exported) and
 * it bootstraps a noy-db schema: column types from sampled cells (number /
 * boolean / date / string), the id field, and foreign keys detected by
 * value-subset matching against another sheet's id column. `zodSourceFor()`
 * emits a Zod snippet you adopt in code.
 *
 * Why it matters
 * ──────────────
 * Mode A round-trips OUR exports deterministically; Mode B is the harder,
 * heuristic case — turning a spreadsheet someone hands you into a starting-point
 * schema. Treat the result as a draft to review, not ground truth.
 *
 * Spec mapping
 * ────────────
 *   #414 — as-xls smart workbook (P4 Mode B: schema inference)
 */
import { describe, it, expect } from 'vitest'
import { writeXlsx, inferSchema, zodSourceFor } from '@noy-db/as-xlsx'

describe('showcase 119 — as-xlsx schema inference', () => {
  it('infers types + foreign keys from a hand-made workbook', async () => {
    const bytes = await writeXlsx([
      { name: 'clients', header: ['id', 'name'], rows: [['c1', 'Acme'], ['c2', 'Beta']] },
      { name: 'invoices', header: ['id', 'clientId', 'amount', 'paid'], rows: [['i1', 'c1', 100, true], ['i2', 'c2', 50, false]] },
    ])

    const schema = await inferSchema(bytes)
    expect(schema.collections['invoices']!.fields['amount']!.type).toBe('number')
    expect(schema.collections['invoices']!.fields['paid']!.type).toBe('boolean')
    expect(schema.collections['invoices']!.fields['clientId']!.references).toBe('clients') // FK detected from the data

    // Adopt the generated Zod in your code, then open the collections with it.
    expect(zodSourceFor(schema)).toContain('export const invoicesSchema = z.object({')
  })
})
