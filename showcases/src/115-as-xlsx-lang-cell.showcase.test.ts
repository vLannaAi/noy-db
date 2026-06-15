/**
 * Showcase 115 — as-xlsx global LANG cell (#414 P2)
 *
 * What you'll learn
 * ─────────────────
 * The headline of the smart workbook: a **single workbook-level language cell**.
 * Declare a sheet's i18n fields and `toBytes({ smart: true })` emits:
 *   1. A `_settings` sheet with a **`LANG` named range** (a dropdown of the
 *      available locales).
 *   2. Per-locale columns (`name__en`, `name__th`, …) holding the raw values.
 *   3. A display column whose formula is `IF(LANG="en", …, IF(LANG="th", …))` —
 *      so changing the one `LANG` cell **re-renders every label in the whole
 *      workbook live**, with the default-locale value cached for immediate show.
 *
 * Why it matters
 * ──────────────
 * A localized dataset normally means one export per language. Here a single
 * file serves every locale: the reviewer flips `LANG` and the workbook follows.
 * This is the same mechanism dictionaries will use (P2 cont.) and it's built
 * entirely on P1's formula + named-range + data-validation primitives.
 *
 * Spec mapping
 * ────────────
 *   #414 — as-xls smart workbook (P2: global LANG cell + i18n)
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withI18n, i18nText } from '@noy-db/hub/i18n'
import { memory } from '@noy-db/to-memory'
import { toBytes, readXlsx } from '@noy-db/as-xlsx'

describe('showcase 115 — as-xlsx global LANG cell', () => {
  it('emits a _settings LANG control + per-locale columns + a live display column', async () => {
    const store = memory()
    const init = await createNoydb({ store, user: 'alice', secret: 'pw-115' })
    await init.openVault('shop')
    await init.grant('shop', {
      userId: 'alice', displayName: 'Alice', role: 'owner', passphrase: 'pw-115',
      exportCapability: { plaintext: ['xlsx'] },
    })
    init.close()

    // Open WITHOUT an active locale so i18n fields stay raw {locale: value} maps.
    const db = await createNoydb({ store, user: 'alice', secret: 'pw-115', i18nStrategy: withI18n() })
    const vault = await db.openVault('shop')
    await vault.collection<{ id: string; name: Record<string, string> }>('products', {
      i18nFields: { name: i18nText({ languages: ['en', 'th'], required: 'all' }) },
    }).put('p1', { id: 'p1', name: { en: 'Widget', th: 'วิดเจ็ต' } })

    const wb = await readXlsx(await toBytes(vault, {
      smart: true,
      sheets: [{ name: 'products', collection: 'products', i18nFields: ['name'] }],
    }))

    expect(wb.sheets.map((s) => s.name)).toContain('_settings') // the LANG control
    const prod = wb.sheets.find((s) => s.name === 'products')!
    const header: Record<string, string> = {}
    for (const [letter, name] of Object.entries(prod.rows[0] ?? {})) header[String(name)] = letter
    const row = prod.rows.slice(1).find((r) => r[header['id']!] === 'p1')!
    expect(row[header['name']!]).toBe('Widget') // display resolves to LANG=en by default
    expect(row[header['name__th']!]).toBe('วิดเจ็ต') // Thai available — flip LANG to see it
  })
})
