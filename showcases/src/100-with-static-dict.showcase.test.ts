/**
 * Showcase 100 — staticDict() code-provided dictionary (#291)
 *
 * What you'll learn
 * ─────────────────
 * `staticDict(name, table, { displayLocale })` — a sibling to `dictKey`
 * for **closed, defined-in-code, identical-across-vaults** enums
 * (honorific, civil-status, gender, religion, status…):
 *   1. The record stores only the stable **code**; labels live in code.
 *   2. **Locale-less resolution** — on a vault opened with NO locale, a
 *      bare `get()` still gains `<field>Label`, resolved via the
 *      configured `displayLocale`. (This is the property a locale-less
 *      app needs and `dictKey` cannot provide.)
 *   3. **Locale-active read** behaves exactly like `dictKey`.
 *   4. **No `_dict_*` collection** is ever created — the adapter shows no
 *      `_dict_civilStatus` key.
 *   5. **Read-only by construction** — `vault.dictionary(staticName)`
 *      throws `StaticDictReadonlyError` (no `put`/`rename`/`delete`).
 *   6. `groupBy(field)` buckets by the stable code.
 *   7. `dictKey` and `staticDict` mix freely in one collection.
 *
 * Why it matters
 * ──────────────
 * A large class of enums are code constants identical across every
 * vault. `dictKey` would force a per-vault encrypted `_dict_*` copy and
 * an O(records) `rename()` for what is really a code deploy — and would
 * resolve to nothing on a locale-less read. `staticDict` embeds the
 * label table in code, resolves locale-lessly via `displayLocale`, and
 * still flows through the same query/label machinery.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 09 (withI18n basics), Showcase 94 (i18n hardening).
 *
 * What to read next
 * ─────────────────
 *   - docs/services/i18n.md (§ staticDict)
 *   - docs/superpowers/specs/2026-06-07-i18n-static-dictionary-design.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → i18n
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withI18n, dictKey, staticDict, StaticDictReadonlyError, UnknownDictCodeError } from '@noy-db/hub/i18n'
import { withAggregate, count } from '@noy-db/hub/aggregate'
import { memory } from '@noy-db/to-memory'

const CIVIL_STATUS = {
  adultMale:   { th: 'นาย',    en: 'Mr'  },
  adultFemale: { th: 'นาง',    en: 'Mrs' },
  youngFemale: { th: 'นางสาว', en: 'Ms'  },
} as const

interface Worker { id: string; civilStatus: string; department?: string }

describe('Showcase 100 — staticDict() code-provided dictionary', () => {
  it('resolves a label under a locale-less read via displayLocale', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-100-a', i18nStrategy: withI18n() })
    const vault = await db.openVault('co1') // NO locale
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    await workers.put('w1', { id: 'w1', civilStatus: 'adultMale' })

    const r = (await workers.get('w1')) as Worker & { civilStatusLabel?: string }
    expect(r.civilStatus).toBe('adultMale')      // record stores only the code
    expect(r.civilStatusLabel).toBe('นาย')        // resolved via displayLocale
  })

  it('resolves under an active locale exactly like dictKey', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-100-b', i18nStrategy: withI18n() })
    const vault = await db.openVault('co1', { locale: 'en' })
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    await workers.put('w1', { id: 'w1', civilStatus: 'youngFemale' })

    const r = (await workers.get('w1')) as Worker & { civilStatusLabel?: string }
    expect(r.civilStatusLabel).toBe('Ms')        // active locale wins over displayLocale
  })

  it('creates NO _dict_civilStatus collection in the adapter', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'a', secret: 'pw-100-c', i18nStrategy: withI18n() })
    const vault = await db.openVault('co1')
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    await workers.put('w1', { id: 'w1', civilStatus: 'adultMale' })

    // A staticDict has no per-vault encrypted copy — nothing under _dict_*.
    const dictKeys = await store.list('co1', '_dict_civilStatus')
    expect(dictKeys).toEqual([])
  })

  it('refuses mutation via vault.dictionary() — read-only by construction', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-100-d', i18nStrategy: withI18n() })
    const vault = await db.openVault('co1')
    vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    expect(() => vault.dictionary('civilStatus')).toThrow(StaticDictReadonlyError)
  })

  it('groupBy(field) buckets by the stable code', async () => {
    const db = await createNoydb({
      store: memory(), user: 'a', secret: 'pw-100-e',
      i18nStrategy: withI18n(), aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('co1')
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: { civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    await workers.put('w1', { id: 'w1', civilStatus: 'adultMale' })
    await workers.put('w2', { id: 'w2', civilStatus: 'adultMale' })
    await workers.put('w3', { id: 'w3', civilStatus: 'adultFemale' })

    const rows = workers.query().groupBy('civilStatus').aggregate({ n: count() }).run() as Array<{ civilStatus: string; n: number }>
    const byCode = Object.fromEntries(rows.map((r) => [r.civilStatus, r.n]))
    expect(byCode['adultMale']).toBe(2)
    expect(byCode['adultFemale']).toBe(1)
  })

  it('mixes dictKey and staticDict in one collection', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-100-f', i18nStrategy: withI18n() })
    const vault = await db.openVault('co1', { locale: 'th' })
    // Per-vault, user-editable enum → dictKey (encrypted _dict_*).
    await vault.dictionary('department').putAll({
      ops: { th: 'ปฏิบัติการ', en: 'Operations' },
      fin: { th: 'การเงิน',    en: 'Finance' },
    })
    const workers = vault.collection<Worker>('workers', {
      dictKeyFields: {
        department:  dictKey('department', ['ops', 'fin'] as const),
        civilStatus: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }),
      },
    })
    await workers.put('w1', { id: 'w1', civilStatus: 'adultMale', department: 'ops' })

    const r = (await workers.get('w1')) as Worker & { civilStatusLabel?: string; departmentLabel?: string }
    expect(r.departmentLabel).toBe('ปฏิบัติการ')  // dictKey via encrypted _dict_*
    expect(r.civilStatusLabel).toBe('นาย')         // staticDict via in-code table

    // The code-defined enum is unknown-code-guarded on put…
    await expect(
      workers.put('w2', { id: 'w2', civilStatus: 'bogus', department: 'ops' }),
    ).rejects.toThrow(UnknownDictCodeError)
  })
})
