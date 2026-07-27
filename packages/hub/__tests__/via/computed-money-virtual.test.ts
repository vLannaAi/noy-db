/**
 * #813 part 1 — the money ∩ virtual-`computed` recipe, as executable documentation.
 *
 * A field that is BOTH money-typed and a virtual `computed` cannot be declared in
 * `moneyFields` and `viaFields` at once — the config validator refuses a field
 * declared "via both a sugar key and viaFields". The canonical form is a single
 * `viaFields` entry composing both descriptors with `via()`:
 *
 *   via(money({ currency: 'THB' }), computed(fn, { mode: 'virtual', deps: [...] }))
 *
 * Money's presentation fields ride the virtual value, so the read surface carries
 * `<field>`, `<field>Formatted` and `<field>Number` even though nothing is stored.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, via, money, computed, memoryStore } from '../../src/index.js'

/**
 * `Intl.NumberFormat` separates the currency code from the number with a
 * NON-BREAKING space (U+00A0), not U+0020. Comparing against a literal typed
 * space fails with the maddening `expected 'THB 42.50' to be 'THB 42.50'`, so
 * normalise before asserting rather than embedding an invisible character.
 */
const spaces = (s: unknown) => String(s).replace(/\s/g, ' ')

/** The virtual + presentation fields are not on `Receipt`, so read through `unknown`. */
const fields = (r: unknown) => r as unknown as Record<string, unknown>

interface Receipt {
  kind: string
  amount: string
  paidTotal: string
}

describe('#813 — money ∩ virtual computed', () => {
  const declare = () =>
    createNoydb({ store: memoryStore(), user: 'u', secret: 'x'.repeat(32) }).then(async (db) => {
      const vault = await db.openVault('acme')
      return vault.collection<Receipt>('receipts', {
        viaFields: {
          receiptAmount: via(
            money({ currency: 'THB' }),
            computed((r) => (r.kind === 'IV' ? r.paidTotal : r.amount), {
              mode: 'virtual',
              deps: ['kind', 'amount', 'paidTotal'],
            }),
          ),
        },
      })
    })

  it('composes money onto a virtual computed field', async () => {
    const receipts = await declare()
    await receipts.put('r1', { kind: 'IV', amount: '10.00', paidTotal: '42.50' })

    const got = fields(await receipts.get('r1'))
    expect(got.receiptAmount).toBe('42.50')
    expect(spaces(got.receiptAmountFormatted)).toBe('THB 42.50')
    expect(got.receiptAmountNumber).toBe(42.5)
  })

  it('follows the branch — non-IV falls back to `amount`', async () => {
    const receipts = await declare()
    await receipts.put('r2', { kind: 'CN', amount: '10.00', paidTotal: '42.50' })

    const got = fields(await receipts.get('r2'))
    expect(got.receiptAmount).toBe('10.00')
    expect(spaces(got.receiptAmountFormatted)).toBe('THB 10.00')
  })

  it('is virtual — the derived value is never stored, so it re-derives on read', async () => {
    const receipts = await declare()
    await receipts.put('r3', { kind: 'IV', amount: '1.00', paidTotal: '5.00' })
    expect(fields(await receipts.get('r3')).receiptAmount).toBe('5.00')

    // Change only the source fields; the derived value must follow without a
    // migration or recompute step.
    await receipts.put('r3', { kind: 'CN', amount: '7.25', paidTotal: '5.00' })
    expect(fields(await receipts.get('r3')).receiptAmount).toBe('7.25')
  })
})
