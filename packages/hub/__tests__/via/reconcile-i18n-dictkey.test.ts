/**
 * #664 Part 2 — the i18n/dictKey late-attach reconcile machinery. Pre-#664, `i18nFields`/
 * `dictKeyFields` on a SECOND-OR-LATER `vault.collection()` call were silently ignored — only
 * the fresh-construction branch ever wired them (no `_applyI18nFields`/`_applyDictKeyFields`
 * existed). `via/reconcile.ts`'s `reconcileI18nFields`/`reconcileDictKeyFields` close that gap by
 * rebuilding the pipeline through `Collection._setVia` (#666) and wiring the same vault registries
 * fresh construction populates.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { i18nText } from '../../src/via/i18n/core.js'
import { dictKey, staticDict } from '../../src/via/i18n/dictionary.js'
import { UnknownDictCodeError } from '../../src/kernel/errors.js'
import { inlineMemory } from '../classified/harness.js'

interface Invoice extends Record<string, unknown> {
  id: string
  total: number
  memo?: Record<string, string>
}

interface Worker extends Record<string, unknown> {
  id: string
  status?: string
}

const CIVIL_STATUS = { single: { en: 'Single', th: 'โสด' }, married: { en: 'Married', th: 'สมรส' } } as const

describe('#664 Part 2 — i18nFields late-attach reconcile', () => {
  it('open without i18n, re-open with i18nFields — locale resolution activates post-attach (was raw before)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-i18n-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('books', { locale: 'en' })

    // First declaration: no i18nFields at all.
    const first = vault.collection<Invoice>('invoices', {})
    await first.put('i1', { id: 'i1', total: 10, memo: { en: 'Hello', th: 'สวัสดี' } })

    // Pre-attach: no i18n binding compiled — the field reads back completely raw at any locale.
    const beforeAttach = await first.get('i1', { locale: 'en' })
    expect(beforeAttach?.memo).toEqual({ en: 'Hello', th: 'สวัสดี' })

    // Late-attach i18nFields on a second vault.collection() call — same instance, reconciled.
    const second = vault.collection<Invoice>('invoices', {
      i18nFields: { memo: i18nText({ languages: ['en', 'th'], required: 'any' }) },
    })
    expect(second).toBe(first)

    // Post-attach: the SAME already-written record now resolves per-locale on read.
    const afterAttachEn = await second.get('i1', { locale: 'en' })
    expect(afterAttachEn?.memo).toBe('Hello')
    const afterAttachTh = await second.get('i1', { locale: 'th' })
    expect(afterAttachTh?.memo).toBe('สวัสดี')

    // Put-time i18n validation is live post-attach too: a NEW record's memo is enforced.
    await second.put('i2', { id: 'i2', total: 5, memo: { en: 'Bye', th: 'ลาก่อน' } })
    const i2 = await second.get('i2', { locale: 'th' })
    expect(i2?.memo).toBe('ลาก่อน')
  })

  it('a second, later i18nFields call is first-wins (no-op) — the family attaches at most once', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-i18n-2', i18nStrategy: withI18n() })
    const vault = await db.openVault('books', { locale: 'en' })
    vault.collection<Invoice>('invoices', {})
    const second = vault.collection<Invoice>('invoices', {
      i18nFields: { memo: i18nText({ languages: ['en', 'th'], required: 'any' }) },
    })
    // A THIRD call with different i18nFields config must not throw and must not reattach.
    expect(() => vault.collection<Invoice>('invoices', {
      i18nFields: { memo: i18nText({ languages: ['en'], required: 'all' }) },
    })).not.toThrow()
    await second.put('i1', { id: 'i1', total: 1, memo: { en: 'Hi' } }) // th NOT required — the FIRST config (required:'any') won, not the third call's required:'all'
  })
})

describe('#664 Part 2 — dictKeyFields late-attach reconcile', () => {
  it('open without dictKeyFields, re-open with staticDict — closed-vocab enforcement AND <field>Label dressing activate post-attach', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-dictkey-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('co1', { locale: 'th' })

    // First declaration: no dictKeyFields — "status" is a plain, unvalidated string field.
    const first = vault.collection<Worker>('workers', {})
    await first.put('w0', { id: 'w0', status: 'anything-goes' }) // no enforcement yet

    const beforeAttach = await first.get('w0')
    expect(beforeAttach).not.toHaveProperty('statusLabel')

    // Late-attach dictKeyFields (staticDict — closed vocabulary by default).
    const second = vault.collection<Worker>('workers', {
      dictKeyFields: { status: staticDict('civilStatus', CIVIL_STATUS, { displayLocale: 'th' }) },
    })
    expect(second).toBe(first)

    // Closed-vocab enforcement is now LIVE — an unknown code refuses at put time.
    await expect(second.put('w1', { id: 'w1', status: 'not-a-key' })).rejects.toThrow(UnknownDictCodeError)

    // A valid code writes fine and dresses `<field>Label` on read.
    await second.put('w2', { id: 'w2', status: 'married' })
    const w2 = await second.get('w2', { locale: 'th' })
    expect(w2?.status).toBe('married')
    expect(w2?.['statusLabel']).toBe('สมรส')
  })

  it('closed-vocab enforcement does NOT retroactively apply to records written before the attach', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-dictkey-2', i18nStrategy: withI18n() })
    const vault = await db.openVault('co1')
    const first = vault.collection<Worker>('workers', {})
    await first.put('w0', { id: 'w0', status: 'pre-existing-junk' })

    vault.collection<Worker>('workers', {
      dictKeyFields: { status: staticDict('civilStatus', CIVIL_STATUS) },
    })
    // Reading the pre-existing record back does not throw (future-writes-only semantics —
    // seam map §3's documented scope for a late-attached lookup/dictKey family).
    const w0 = await first.get('w0')
    expect(w0?.status).toBe('pre-existing-junk')
  })
})
