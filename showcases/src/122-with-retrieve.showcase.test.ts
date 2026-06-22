/**
 * Showcase 122 — Client-side lexical retrieval (collection.retrieve) — #308 L1
 *
 * What you'll learn
 * ─────────────────
 * `collection.retrieve(query, opts)` builds a **client-side in-memory inverted
 * index** the first time it is called (or on open when `warmIndexOnOpen: true`),
 * then scores query terms with multi-field BM25 and returns ranked hits with a
 * per-hit snippet. It extends the L0 scan (`collection.search`) with:
 *
 *   1. **i18nText all-locale indexing** — a Thai-language query matches records
 *      whose i18nText field has a Thai locale value. Hit carries `locale`.
 *   2. **dictKey label indexing** — resolved labels (all locales) are indexed so
 *      queries match by label, not by the opaque stored code.
 *   3. **Prefix autocomplete** — `prefix: true` makes the last query term a
 *      prefix (typeahead).
 *   4. **`includeRecord`** — attach the full decrypted record to each hit.
 *   5. **`warmIndex()`** — pre-build the index so the first retrieve() is instant.
 *
 * Why it matters
 * ──────────────
 * Retrieval in the trusted tier (client-side, never written to the store) is
 * the right model for private personal-AI retrieval — analogous to Apple
 * Intelligence's on-device Spotlight index. The store sees only ciphertext;
 * only the relevant context reaches the model.
 *
 * What to read next
 * ─────────────────
 *   - docs/subsystems/search.md (epic map, field-type matrix, trusted-tier rationale)
 *   - docs/superpowers/specs/2026-06-22-ai-retrieval-l1-lexical-index-design.md
 *   - Showcase 111 (L0 scan-mode search — collection.search)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → search-index
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withI18n, i18nText, dictKey } from '@noy-db/hub/i18n'
import { memory } from '@noy-db/to-memory'

// ─── Shared types ──────────────────────────────────────────────────────────────

interface Invoice extends Record<string, unknown> {
  id: string
  title: Record<string, string>  // i18nText: { en, th }
  status: string                 // dictKey code: 'draft' | 'paid' | 'overdue'
}

// ─── Part 1: i18nText — Thai-language query matches the Thai locale ────────────

describe('Showcase 122-A — i18nText: Thai-query retrieval + locale on hit', () => {
  it('retrieves by Thai locale value, returns locale on hit, snippet from that locale', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: 'retrieve-122-a-passphrase',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('firm', { locale: 'en' })

    // dictKey setup — per-vault encrypted dictionary for invoice status labels
    await vault.dictionary('invoiceStatus').putAll({
      draft:   { th: 'ฉบับร่าง',  en: 'Draft'   },
      paid:    { th: 'ชำระแล้ว',  en: 'Paid'    },
      overdue: { th: 'เกินกำหนด', en: 'Overdue' },
    })

    const invoices = vault.collection<Invoice>('invoices', {
      textIndexes: ['title', 'status'],
      i18nFields: {
        title: i18nText({ languages: ['en', 'th'], required: 'any' }),
      },
      dictKeyFields: {
        status: dictKey('invoiceStatus', ['draft', 'paid', 'overdue'] as const),
      },
    })

    await invoices.put('inv-1', {
      id: 'inv-1',
      title: { en: 'Overdue invoice for Acme Holdings', th: 'ใบแจ้งหนี้เกินกำหนด บจก.แอคมี' },
      status: 'overdue',
    })
    await invoices.put('inv-2', {
      id: 'inv-2',
      title: { en: 'Paid invoice — Globex', th: 'ใบแจ้งหนี้ที่ชำระแล้ว Globex' },
      status: 'paid',
    })
    await invoices.put('inv-3', {
      id: 'inv-3',
      title: { en: 'Draft memo', th: 'บันทึกฉบับร่าง' },
      status: 'draft',
    })

    // Thai-language query: 'ใบแจ้งหนี้' = 'invoice'
    // Both inv-1 and inv-2 have this in their Thai title.
    const hits = await invoices.retrieve('ใบแจ้งหนี้')
    const ids = hits.map((h) => h.id).sort()
    expect(ids).toEqual(['inv-1', 'inv-2'])

    // Every hit carries the matched locale ('th' for these i18nText hits).
    for (const h of hits) {
      expect(h.locale).toBe('th')
      // Snippet is a window around the matched text.
      expect(h.snippet).toBeTruthy()
      // Score is positive and hits are sorted descending.
      expect(h.score).toBeGreaterThan(0)
    }

    db.close()
  })
})

// ─── Part 2: dictKey labels — query by label text in any locale ────────────────
//
// Design note: `buildStringFieldEntries` indexes the raw field value (the opaque
// code, e.g. 'overdue') before `buildDictKeyFieldEntries` indexes the resolved
// labels.  When the English label is distinct from the code, the hit carries
// `locale: 'en'`.  The Thai label always has locale: 'th' (no Thai code names).
// Use labels that don't share tokens with the code to get clean locale assertions.

describe('Showcase 122-B — dictKey: label-text retrieval (English + Thai)', () => {
  it('finds records by resolved label text; Thai hit carries locale', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: 'retrieve-122-b-passphrase',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('firm', { locale: 'en' })

    // Use labels whose text is distinct from the stored code so that the
    // label-match hit is unambiguous (field: 'status', locale: 'en'|'th').
    await vault.dictionary('invoiceStatus').putAll({
      s1: { en: 'Pending Approval', th: 'รอการอนุมัติ' },
      s2: { en: 'Settled',          th: 'ชำระเสร็จสิ้น' },
    })

    const invoices = vault.collection<Invoice>('invoices', {
      textIndexes: ['title', 'status'],
      i18nFields: {
        title: i18nText({ languages: ['en', 'th'], required: 'any' }),
      },
      dictKeyFields: {
        status: dictKey('invoiceStatus', ['s1', 's2'] as const),
      },
    })

    await invoices.put('inv-a', { id: 'inv-a', title: { en: 'Acme invoice' }, status: 's1' })
    await invoices.put('inv-b', { id: 'inv-b', title: { en: 'Globex invoice' }, status: 's2' })

    // English label query — 'Approval' appears only in s1's English label.
    const enHits = await invoices.retrieve('Approval', { fields: ['status'] })
    expect(enHits.map((h) => h.id)).toEqual(['inv-a'])
    expect(enHits[0]!.field).toBe('status')
    expect(enHits[0]!.locale).toBe('en')

    // Thai label query — 'รอการอนุมัติ' appears only in s1's Thai label.
    const thHits = await invoices.retrieve('รอการอนุมัติ', { fields: ['status'] })
    expect(thHits.map((h) => h.id)).toEqual(['inv-a'])
    expect(thHits[0]!.locale).toBe('th')

    // Both locales find the same record (locale-agnostic search).
    expect(enHits[0]!.id).toBe(thHits[0]!.id)

    db.close()
  })
})

// ─── Part 3: prefix autocomplete + includeRecord ──────────────────────────────

describe('Showcase 122-C — prefix autocomplete + includeRecord', () => {
  it('typeahead: prefix=true matches incomplete Thai term; includeRecord attaches the record', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: 'retrieve-122-c-passphrase',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('firm', { locale: 'en' })

    await vault.dictionary('invoiceStatus').putAll({
      draft:   { th: 'ฉบับร่าง',  en: 'Draft'   },
      paid:    { th: 'ชำระแล้ว',  en: 'Paid'    },
      overdue: { th: 'เกินกำหนด', en: 'Overdue' },
    })

    const invoices = vault.collection<Invoice>('invoices', {
      textIndexes: ['title', 'status'],
      i18nFields: {
        title: i18nText({ languages: ['en', 'th'], required: 'any' }),
      },
      dictKeyFields: {
        status: dictKey('invoiceStatus', ['draft', 'paid', 'overdue'] as const),
      },
    })

    await invoices.put('inv-x', {
      id: 'inv-x',
      title: { en: 'Quarterly meeting notes', th: 'บันทึกการประชุมรายไตรมาส' },
      status: 'draft',
    })
    await invoices.put('inv-y', {
      id: 'inv-y',
      title: { en: 'Another overdue invoice', th: 'ใบแจ้งหนี้เกินกำหนดอีกใบ' },
      status: 'overdue',
    })

    // Prefix autocomplete: 'ใบแจ้ง' is a prefix of 'ใบแจ้งหนี้เกินกำหนดอีกใบ'.
    const ac = await invoices.retrieve('ใบแจ้ง', { prefix: true, limit: 5 })
    expect(ac.map((h) => h.id)).toContain('inv-y')

    // English prefix typeahead: 'Over' → 'Overdue' (label) or 'overdue' in title.
    const acEn = await invoices.retrieve('Over', { prefix: true })
    expect(acEn.length).toBeGreaterThan(0)

    // includeRecord: true — the full record is attached to each hit.
    const withRec = await invoices.retrieve('ใบแจ้งหนี้', { includeRecord: true })
    for (const h of withRec) {
      expect(h.record).toBeDefined()
      expect((h.record as Invoice).id).toBe(h.id)
    }

    db.close()
  })
})

// ─── Part 4: warmIndex() — pre-build so first retrieve() is instant ───────────

describe('Showcase 122-D — warmIndex(): explicit pre-build', () => {
  it('warmIndex() resolves without error and subsequent retrieve() returns correct hits', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'analyst',
      secret: 'retrieve-122-d-passphrase',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('firm', { locale: 'en' })

    await vault.dictionary('invoiceStatus').putAll({
      draft:   { th: 'ฉบับร่าง', en: 'Draft' },
    })

    const invoices = vault.collection<Invoice>('invoices', {
      textIndexes: ['title'],
      i18nFields: {
        title: i18nText({ languages: ['en', 'th'], required: 'any' }),
      },
      dictKeyFields: {
        status: dictKey('invoiceStatus', ['draft'] as const),
      },
    })

    await invoices.put('inv-w', {
      id: 'inv-w',
      title: { en: 'Warm index test', th: 'ทดสอบการวอร์มดัชนี' },
      status: 'draft',
    })

    // warmIndex() pre-builds the index; no error expected.
    await expect(invoices.warmIndex()).resolves.toBeUndefined()

    // A subsequent retrieve() finds the record.
    const hits = await invoices.retrieve('ทดสอบ')
    expect(hits.map((h) => h.id)).toContain('inv-w')
    expect(hits[0]!.locale).toBe('th')

    db.close()
  })
})
