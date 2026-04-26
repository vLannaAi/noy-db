/**
 * Showcase 09 — withI18n()
 *
 * What you'll learn
 * ─────────────────
 * Multi-locale records via reserved `_dict_<name>` collections.
 * Records carry a stable key (e.g. `'invoice.draft'`); the dictionary
 * carries the labels (`{ en: 'Draft', th: 'ฉบับร่าง', fr: 'Brouillon' }`).
 * `resolveLabel(key, locale, fallback)` looks up at render time.
 *
 * Why it matters
 * ──────────────
 * The hub's i18n boundary policy is "store stable keys, resolve at
 * render time" — the same database serves every locale, no schema
 * migration when a locale is added, and a UI in any framework can
 * reuse the same dictionary handle.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 01 + 07.
 *
 * What to read next
 * ─────────────────
 *   - docs/subsystems/i18n.md (the full surface)
 *   - the in-pinia useDictLabel composable (renders with reactive locale)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → i18n
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withI18n } from '@noy-db/hub/i18n'
import { memory } from '@noy-db/to-memory'

describe('Showcase 09 — withI18n()', () => {
  it('stores stable keys and resolves to a locale at read time', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-i18n-passphrase-2026',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('demo')
    const status = vault.dictionary<'draft' | 'paid' | 'overdue'>('invoiceStatus')

    await status.put('draft', { en: 'Draft', th: 'ฉบับร่าง', fr: 'Brouillon' })
    await status.put('paid', { en: 'Paid', th: 'ชำระแล้ว', fr: 'Payée' })
    await status.put('overdue', { en: 'Overdue', th: 'เกินกำหนด', fr: 'En retard' })

    expect(await status.resolveLabel('draft', 'en', ['any'])).toBe('Draft')
    expect(await status.resolveLabel('paid', 'th', ['any'])).toBe('ชำระแล้ว')
    expect(await status.resolveLabel('overdue', 'fr', ['any'])).toBe('En retard')

    db.close()
  })

  it('falls back through the chain when the requested locale is missing', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-i18n-passphrase-2026',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('demo')
    const status = vault.dictionary<'draft'>('invoiceStatus')

    await status.put('draft', { en: 'Draft' })
    // No 'th' translation — falls through to en, then any.
    expect(await status.resolveLabel('draft', 'th', ['en', 'any'])).toBe('Draft')

    db.close()
  })

  it('without withI18n() opted in, vault.dictionary() throws', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-i18n-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    expect(() => vault.dictionary('invoiceStatus')).toThrow(/i18n/)
    db.close()
  })
})
