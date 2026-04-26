/**
 * Showcase 14 — "Dictionary + i18n translation (multi-locale demo)"
 *
 * Framework: Pure hub (no framework glue)
 * Store:     `memory()`
 * Pattern:   Multi-locale document store — `dictKey` for stable
 *            enum-like labels, `i18nText` for free-form translatable
 *            fields, `vault.dictionary()` for the shared label store.
 * Dimension: Internationalisation — proves NOYDB handles Thai,
 *            English, and Arabic (RTL) round-trips end-to-end through
 *            the encrypted envelope, and that locale-switching happens
 *            at read time, not at write time.
 *
 * What this proves:
 *   1. `vault.dictionary('status').putAll({ ... })` seeds a per-vault
 *      label store. Each dict value is a locale map
 *      (`{ en, th, ar, ... }`). The dictionary is itself an encrypted
 *      collection — labels are never stored plaintext.
 *   2. `dictKey('status', ['draft', 'open', ...] as const)` binds a
 *      record field to that dictionary. Writes store the stable key
 *      (`'draft'`); reads resolve to the active locale.
 *   3. `i18nText({ languages: ['en', 'th', 'ar'], required: 'all' })`
 *      declares a free-form field that carries every locale inline.
 *      Useful for per-record content (invoice descriptions) vs shared
 *      enums (invoice statuses).
 *   4. `resolveI18nText(value, locale, fallback?)` looks up a locale
 *      with configurable fallback — a single locale, a list of locales,
 *      'any', or 'raw' (return the full map).
 *   5. Thai + Arabic text (RTL) round-trip through AES-GCM bit-for-bit.
 *      The ciphertext contains neither the Thai UTF-8 bytes nor the
 *      Arabic glyph bytes — stores see only the envelope.
 *
 * The dictionary pattern is the right choice for any enum-like field
 * that needs translation. The `i18nText` pattern is the right choice
 * for per-record free-form content. Both can coexist in the same
 * record — showcase seeds one of each.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createNoydb,
  dictKey,
  i18nText,
  resolveI18nText,
  type Noydb,
  type NoydbStore,
} from '@noy-db/hub'
import { withI18n } from '@noy-db/hub/i18n'
import { memory } from '@noy-db/to-memory'

import { SHOWCASE_PASSPHRASE, THAI_SAMPLE } from './_fixtures.js'

const VAULT = 'firm-demo'

// Multi-locale fixtures. Arabic is RTL — proves direction-of-script
// makes no difference to the encryption layer.
const EN_HELLO = 'Hello, world — NOYDB is safe.'
// Thai sample comes from _fixtures: 'สวัสดีชาวโลก — NOYDB ปลอดภัย'
const AR_HELLO = 'مرحبا بالعالم — NOYDB آمن.'

interface Invoice {
  id: string
  /** `dictKey('status')` — stable key from the shared status dictionary. */
  status: string
  /** Inline multi-locale description (per-record free-form text). */
  description: Record<string, string>
  amount: number
}

describe('Showcase 14 — Dictionary + i18n translation (pure hub)', () => {
  let db: Noydb
  let rawStore: NoydbStore

  beforeEach(async () => {
    rawStore = memory()
    db = await createNoydb({
      store: rawStore,
      user: 'owner', i18nStrategy: withI18n(),
      secret: SHOWCASE_PASSPHRASE,
    })
    const vault = await db.openVault(VAULT)

    // Step 0 — seed the shared status dictionary. This happens once per
    // vault at bootstrap (real apps do this in a migration). Every
    // invoice record written afterwards can reference these labels by
    // their stable key (`'draft'`, `'open'`, ...) regardless of locale.
    const statusDict = vault.dictionary('status')
    await statusDict.putAll({
      draft:   { en: 'Draft',    th: 'ฉบับร่าง',     ar: 'مسودة' },
      open:    { en: 'Open',     th: 'เปิดใช้งาน',   ar: 'مفتوح' },
      paid:    { en: 'Paid',     th: 'ชำระแล้ว',     ar: 'مدفوع' },
      overdue: { en: 'Overdue',  th: 'เกินกำหนด',    ar: 'متأخر' },
    })

    // Declare the invoices collection with its dictKey field. This is
    // the load-bearing wiring that links the records' `status` field
    // to the dictionary seeded above.
    vault.collection<Invoice>('invoices', {
      dictKeyFields: {
        status: dictKey('status', ['draft', 'open', 'paid', 'overdue'] as const),
      },
      i18nFields: {
        description: i18nText({ languages: ['en', 'th', 'ar'], required: 'all' }),
      },
    })
  })

  afterEach(async () => {
    await db.close()
  })

  it('step 1 — dictionary seeds labels for every configured locale', async () => {
    const vault = db.vault(VAULT)
    const dict = vault.dictionary('status')
    const entries = await dict.list()
    const keys = entries.map((e) => e.key).sort()
    expect(keys).toEqual(['draft', 'open', 'overdue', 'paid'])

    // Read a single entry — returns the full locale map via `.labels`.
    const draft = entries.find((e) => e.key === 'draft')
    expect(draft?.labels).toEqual({ en: 'Draft', th: 'ฉบับร่าง', ar: 'مسودة' })
  })

  it('step 2 — records store stable keys + locale maps; encryption is transparent', async () => {
    const vault = db.vault(VAULT)
    const invoices = vault.collection<Invoice>('invoices')

    await invoices.put('inv-001', {
      id: 'inv-001',
      status: 'open', // stable key — dictionary resolves at read time
      description: {
        en: EN_HELLO,
        th: THAI_SAMPLE,
        ar: AR_HELLO,
      },
      amount: 15_000,
    })

    const rec = await invoices.get('inv-001')
    expect(rec).toBeTruthy()
    expect(rec!.status).toBe('open')
    expect(rec!.description).toEqual({
      en: EN_HELLO,
      th: THAI_SAMPLE,
      ar: AR_HELLO,
    })
    expect(rec!.amount).toBe(15_000)
  })

  it('step 3 — resolveI18nText picks the right locale with fallback chain', () => {
    const description = {
      en: EN_HELLO,
      th: THAI_SAMPLE,
      ar: AR_HELLO,
    }

    // Primary locale present — returns exact match.
    expect(resolveI18nText(description, 'th')).toBe(THAI_SAMPLE)
    expect(resolveI18nText(description, 'ar')).toBe(AR_HELLO)

    // Missing locale with single-locale fallback.
    expect(resolveI18nText({ en: 'Hello' }, 'th', 'en')).toBe('Hello')

    // Missing locale with ordered fallback list.
    expect(resolveI18nText({ en: 'Hello' }, 'th', ['jp', 'en'])).toBe('Hello')

    // 'any' fallback — returns the first available locale's value.
    expect(resolveI18nText({ en: 'Hello' }, 'th', 'any')).toBe('Hello')

    // 'raw' fallback — returns the full map for the caller to handle.
    expect(resolveI18nText(description, 'raw')).toEqual(description)
  })

  it('step 4 — Thai and Arabic (RTL) text round-trip byte-for-byte', async () => {
    const vault = db.vault(VAULT)
    const invoices = vault.collection<Invoice>('invoices')

    await invoices.put('inv-unicode', {
      id: 'inv-unicode',
      status: 'paid',
      description: {
        en: 'Payment for services rendered',
        th: 'ชำระเงินสำหรับบริการ',
        ar: 'الدفع مقابل الخدمات المقدمة',
      },
      amount: 42_000,
    })

    const rec = await invoices.get('inv-unicode')
    expect(rec!.description.th).toBe('ชำระเงินสำหรับบริการ')
    expect(rec!.description.ar).toBe('الدفع مقابل الخدمات المقدمة')
    // The test is trivial to pass if the encoder writes UTF-8 and the
    // decoder reads UTF-8 — but it proves the AES-GCM round-trip is
    // text-agnostic, which is the promise NOYDB makes for Unicode.
  })

  it('step 5 — recap: dictionary + i18n content are both encrypted', async () => {
    // Peek at the raw stored envelope for an invoice. Dictionary values
    // (the status labels) live in the `_dict_status` reserved collection;
    // let's check both collections to prove nothing leaks.

    const vault = db.vault(VAULT)
    const invoices = vault.collection<Invoice>('invoices')

    await invoices.put('inv-secret', {
      id: 'inv-secret',
      status: 'overdue',
      description: {
        en: 'CONFIDENTIAL retainer fee',
        th: 'ค่าบริการปรึกษาลับ',
        ar: 'رسوم الاستشارة السرية',
      },
      amount: 999_999,
    })

    // Invoice record envelope on disk.
    const invEnv = await rawStore.get(VAULT, 'invoices', 'inv-secret')
    expect(invEnv).toBeTruthy()
    expect(invEnv!._noydb).toBe(1)
    expect(invEnv!._data).not.toContain('CONFIDENTIAL')
    expect(invEnv!._data).not.toContain('overdue')
    expect(invEnv!._data).not.toContain('ค่าบริการ')
    expect(invEnv!._data).not.toContain('الاستشارة')

    // Dictionary entry envelope on disk (reserved `_dict_status` collection).
    const dictEnv = await rawStore.get(VAULT, '_dict_status', 'overdue')
    expect(dictEnv).toBeTruthy()
    expect(dictEnv!._noydb).toBe(1)
    expect(dictEnv!._data).not.toContain('Overdue')
    expect(dictEnv!._data).not.toContain('เกินกำหนด')
    expect(dictEnv!._data).not.toContain('متأخر')
  })
})
