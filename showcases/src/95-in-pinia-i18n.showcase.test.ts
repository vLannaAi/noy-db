/**
 * Showcase 95 — in-pinia reactive i18n
 *
 * What you'll learn
 * ─────────────────
 * Make a Pinia/Vue app language-agnostic over noy-db's i18n:
 *   1. `useNoydbI18n` — one reactive active-locale. `setLocale('th')`
 *      flips the language; `'follow'` stores re-read resolved.
 *   2. `defineNoydbStore({ i18n: 'follow' })` — store items resolve to
 *      the global locale and re-resolve on flip. Default `'raw'` keeps
 *      `{th,en}` maps (feeds a bilingual per-cell toggle).
 *   3. `useI18nField` / `useDictLabel` — reactive field + dict-label
 *      selectors that follow the same global locale.
 *
 * Why it matters
 * ──────────────
 * The store holds raw by default (lossless, non-breaking); resolution is
 * opt-in and reactive. One switch re-renders the whole UI in another
 * language — no per-component locale plumbing.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 38 (in-pinia), 09 (withI18n).
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-pinia
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { createNoydb } from '@noy-db/hub'
import { withI18n, i18nText } from '@noy-db/hub/i18n'
import {
  defineNoydbStore,
  setActiveNoydb,
  useNoydbI18n,
  useI18nField,
  useDictLabel,
} from '@noy-db/in-pinia'
import { memory } from '@noy-db/to-memory'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Person { id: string; name: Record<string, string> | string }

describe('Showcase 95 — in-pinia reactive i18n', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("'follow' store resolves and re-resolves on a global setLocale flip", async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'sc95-a', i18nStrategy: withI18n() })
    setActiveNoydb(db)
    const i18n = useNoydbI18n()
    i18n.setLocale('en')

    const usePeople = defineNoydbStore<Person>('people', {
      vault: 'v',
      i18n: 'follow',
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any' }) },
    })
    const store = usePeople()
    await store.$ready
    await store.add('p1', { id: 'p1', name: { th: 'สมชาย', en: 'Somchai' } })

    expect(store.items.find((p) => p.id === 'p1')?.name).toBe('Somchai')
    i18n.setLocale('th')
    for (let n = 0; n < 50 && store.items.find((p) => p.id === 'p1')?.name !== 'สมชาย'; n++) await tick(10)
    expect(store.items.find((p) => p.id === 'p1')?.name).toBe('สมชาย')
  })

  it("default 'raw' store keeps the {th,en} map (bilingual source)", async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'sc95-b', i18nStrategy: withI18n() })
    setActiveNoydb(db)
    const usePeople = defineNoydbStore<Person>('people-raw', {
      vault: 'v2',
      i18nFields: { name: i18nText({ languages: ['th', 'en'], required: 'any' }) },
    })
    const store = usePeople()
    await store.$ready
    await store.add('p1', { id: 'p1', name: { th: 'สมชาย', en: 'Somchai' } })
    // raw map preserved → a BilingualText component owns the per-cell toggle
    expect(store.items.find((p) => p.id === 'p1')?.name).toEqual({ th: 'สมชาย', en: 'Somchai' })
  })

  it('useI18nField + useDictLabel follow the global locale', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'sc95-c', i18nStrategy: withI18n() })
    setActiveNoydb(db)
    const vault = await db.openVault('v3')
    const dict = vault.dictionary('title')
    await dict.put('mr', { en: 'Mr.', th: 'คุณ' })

    const i18n = useNoydbI18n()
    i18n.setLocale('en')

    const name = useI18nField({ th: 'สมชาย', en: 'Somchai' })
    const label = useDictLabel('title', { vault })
    const mr = label('mr')
    for (let n = 0; n < 50 && mr.value !== 'Mr.'; n++) await tick(10)
    expect(name.value).toBe('Somchai')
    expect(mr.value).toBe('Mr.')

    i18n.setLocale('th')
    for (let n = 0; n < 50 && mr.value !== 'คุณ'; n++) await tick(10)
    expect(name.value).toBe('สมชาย')   // sync computed
    expect(mr.value).toBe('คุณ')        // async dict label
  })
})
