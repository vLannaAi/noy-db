/**
 * Showcase 117 — as-xlsx smart import (#414 P4)
 *
 * What you'll learn
 * ─────────────────
 * The read side of the smart workbook. `fromBytes(vault, bytes, { smart: true })`
 * reverses what smart export wrote — onto an EXISTING schema (Mode A):
 *   1. Rebuilds i18n fields from their per-locale columns (`name__en`,
 *      `name__th` → `{ en, th }`).
 *   2. Drops the derived columns — the i18n display column and every
 *      `<field>__label` (FK/dict) formula column.
 *   3. Keeps the code columns (the real values), then applies via diff.
 *
 * Why it matters
 * ──────────────
 * Round-trip: export a vault as a rich workbook, edit it in Excel, import it
 * back. The smart reader strips the presentation layer (labels, displays) and
 * reconstructs the canonical record — so a human-edited workbook flows straight
 * back into the encrypted store.
 *
 * Spec mapping
 * ────────────
 *   #414 — as-xls smart workbook (P4: smart import, Mode A)
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withI18n, i18nText } from '@noy-db/hub/i18n'
import { withTransactions } from '@noy-db/hub/tx'
import { memory } from '@noy-db/to-memory'
import { toBytes, fromBytes } from '@noy-db/as-xlsx'

describe('showcase 117 — as-xlsx smart import (round-trip)', () => {
  it('exports a localized workbook, then imports it back onto the schema', async () => {
    const store = memory()
    const init = await createNoydb({ store, user: 'alice', secret: 'pw-117' })
    await init.openVault('shop')
    await init.grant('shop', {
      userId: 'alice', displayName: 'Alice', role: 'owner', passphrase: 'pw-117',
      exportCapability: { plaintext: ['xlsx'] }, importCapability: { plaintext: ['xlsx'] },
    })
    init.close()

    const db = await createNoydb({ store, user: 'alice', secret: 'pw-117', i18nStrategy: withI18n(), txStrategy: withTransactions() })
    const vault = await db.openVault('shop')
    const products = vault.collection<{ id: string; name: Record<string, string> }>('products', {
      i18nFields: { name: i18nText({ languages: ['en', 'th'], required: 'all' }) },
    })
    await products.put('p1', { id: 'p1', name: { en: 'Widget', th: 'วิดเจ็ต' } })

    // Export → (edit in Excel) → import back.
    const bytes = await toBytes(vault, { smart: true, sheets: [{ name: 'products', collection: 'products', i18nFields: ['name'] }] })
    await products.delete('p1')
    const plan = await fromBytes(vault, bytes, { collection: 'products', sheet: 'products', smart: true })
    await plan.apply()

    expect(await products.get('p1')).toEqual({ id: 'p1', name: { en: 'Widget', th: 'วิดเจ็ต' } })
  })
})
