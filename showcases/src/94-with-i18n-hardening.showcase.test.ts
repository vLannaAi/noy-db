/**
 * Showcase 94 — i18n hardening (per-layer onMissing, substitute, script, dictKey parity)
 *
 * What you'll learn
 * ─────────────────
 * The multilingual-field hardening layer over `withI18n()`:
 *   1. `onMissing` + `substitute` — a person's name stored in one
 *      language resolves to a preferred substitute when the active
 *      locale is absent (proper names aren't translated — a Thai name
 *      shown to an `en` reader is acceptable).
 *   2. `script` enforcement — a Thai address with embedded Latin
 *      (building names) is accepted, while Thai text dumped into an
 *      `en` slot is rejected. (#283)
 *   3. dictKey parity — a honorific (`Mr.`/`Ms.` → `คุณ`) resolved per
 *      element of a `contacts[]` array, with the stable key preserved
 *      so identity survives the many-to-one label collapse. (#282)
 *
 * Why it matters
 * ──────────────
 * In a bilingual (or multi-script) interface, missing-translation
 * policy, substitute ordering, and script validation otherwise sprawl
 * across application code with weak enforcement. noy-db makes them
 * field-level declarations honored on every read/write.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 09 (withI18n basics).
 *
 * What to read next
 * ─────────────────
 *   - docs/services/i18n.md (§ Hardening)
 *   - docs/superpowers/specs/2026-06-05-i18n-multilingual-field-hardening-design.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → i18n
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withI18n, i18nText, dictKey, ScriptViolationError } from '@noy-db/hub/i18n'
import { memory } from '@noy-db/to-memory'

describe('Showcase 94 — i18n hardening', () => {
  it('substitutes a proper name when the active locale is absent', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-94-a', i18nStrategy: withI18n() })
    const vault = await db.openVault('people', { locale: 'en' })
    interface Person { id: string; firstName: Record<string, string> }
    const people = vault.collection<Person>('people', {
      i18nFields: {
        firstName: i18nText({
          languages: ['th', 'en'],
          required: 'any',
          substitute: ['en', 'th', 'any'],
          onMissing: { read: 'substitute' },
        }),
      },
    })
    await people.put('p1', { id: 'p1', firstName: { th: 'สมชาย' } })
    const p = await people.get('p1')
    expect(p?.firstName).toBe('สมชาย') // en absent → substitute chain → th
  })

  it('accepts Thai-with-embedded-Latin but rejects Thai in an en slot (#283)', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-94-b', i18nStrategy: withI18n() })
    const vault = await db.openVault('orgs', { locale: 'th' })
    interface Org { id: string; name: Record<string, string>; address: Record<string, string> }
    const orgs = vault.collection<Org>('orgs', {
      i18nFields: {
        name: i18nText({ languages: ['th', 'en'], required: 'any', script: 'auto' }),
        address: i18nText({ languages: ['th'], required: 'any', script: 'auto' }),
      },
    })
    // Thai address with embedded Latin building name — accepted.
    await orgs.put('o1', {
      id: 'o1',
      name: { th: 'บริษัท ตัวอย่าง' },
      address: { th: '9/9 อาคาร TCM ถนนรัชดาภิเษก' },
    })
    // Thai text in the en slot — rejected.
    await expect(
      orgs.put('o2', { id: 'o2', name: { en: 'สมชาย' }, address: { th: 'x' } }),
    ).rejects.toThrow(ScriptViolationError)
  })

  it('resolves an honorific per contact element, keeping the key (#282)', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-94-c', i18nStrategy: withI18n() })
    const vault = await db.openVault('entities', { locale: 'th' })
    const dict = vault.dictionary('contactTitle')
    await dict.put('mr', { en: 'Mr.', th: 'คุณ' })
    await dict.put('ms', { en: 'Ms.', th: 'คุณ' })

    interface Entity { id: string; contacts: { name: string; title: string }[] }
    const entities = vault.collection<Entity>('entities', {
      dictKeyFields: { 'contacts[].title': dictKey('contactTitle', ['mr', 'ms'] as const) },
    })
    await entities.put('e1', {
      id: 'e1',
      contacts: [
        { name: 'Somchai', title: 'mr' },
        { name: 'Jane', title: 'ms' },
      ],
    })
    const e = (await entities.get('e1')) as unknown as { contacts: Record<string, unknown>[] }
    // Labels collapse to คุณ for display…
    expect(e.contacts[0]!.titleLabel).toBe('คุณ')
    expect(e.contacts[1]!.titleLabel).toBe('คุณ')
    // …but the stable keys stay distinct (identity survives).
    expect(e.contacts[0]!.title).toBe('mr')
    expect(e.contacts[1]!.title).toBe('ms')
  })
})
