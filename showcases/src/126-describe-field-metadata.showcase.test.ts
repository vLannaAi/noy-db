/**
 * Showcase 126 — collection.describe() + fieldMeta: two consumers, one source (#483)
 *
 * What you'll learn
 * -----------------
 * `collection.describe()` (sync, zero store I/O) returns a normalised
 * `CollectionDescription` whose `fields` array merges every config channel —
 * money / dictKeyFields / refs / fieldMeta — into consumer-neutral
 * `DescribedField` objects. A single `describe()` call can power many
 * different consumers without each having to re-read the collection config.
 *
 *   1. Build a `sales` collection that combines schema + moneyFields +
 *      dictKeyFields (staticDict with labels) + refs + fieldMeta sensitivity.
 *   2. Consumer A — table header row: `describe().fields.map(f => f.label)`.
 *   3. Consumer B — export column spec: same `describe()` result, filter
 *      `sensitivity !== 'public'` to flag PII/secret fields for redaction.
 *   4. Merge precedence: channel (fieldMeta) > zod-4 .meta() > inferred-from-config.
 *
 * Why it matters
 * --------------
 * Consumer-neutral field descriptors eliminate the duplication that happens
 * when every layer (table, export, form, API serialiser) hard-codes its own
 * label/unit/sensitivity logic. `describe()` is the single source of truth:
 * descriptive, never prescriptive (layout, styling, and locale selection stay
 * app-side). Running sync with zero store I/O means it is cheap to call at
 * render time.
 *
 * What to read next
 * -----------------
 *   - docs/services/field-metadata.md (this feature's subsystem doc)
 *   - docs/superpowers/specs/2026-06-25-field-metadata-foundation-design.md
 *   - Showcase 87  (noydb describe CLI command — vault-level describe)
 *   - Showcase 100 (staticDict — code-provided dictionaries)
 *
 * Spec mapping
 * ------------
 * features.yaml -> features -> field-metadata
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, money, staticDict, ref } from '@noy-db/hub'
import type { FieldMeta } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

// ── Shared collection fixture ─────────────────────────────────────────────────

/**
 * A `sales` collection that exercises every describe() merge channel:
 *   - moneyFields    → infers semanticType:'currency', aggregate:'sum'
 *   - dictKeyFields  → staticDict with en labels → dict.values[].label
 *   - refs           → infers semanticType:'entity'
 *   - fieldMeta      → overrides label, sets sensitivity, unit, displayFor
 */

const SALE_STATUS = staticDict('saleStatus', {
  draft:   { en: 'Draft' },
  pending: { en: 'Pending' },
  paid:    { en: 'Paid' },
}, { displayLocale: 'en' })

const SALE_FIELD_META: Record<string, FieldMeta> = {
  saleDate: { label: 'Date' },
  total:    { label: 'Total (€)', unit: '€' },
  buyerId:  { label: 'Buyer', sensitivity: 'pii', displayFor: 'buyerName' },
  buyerVat: { label: 'VAT number', sensitivity: 'pii', semanticType: 'vat' },
  notes:    { label: 'Internal notes', sensitivity: 'secret' },
}

// ── Part A: table header row ──────────────────────────────────────────────────

describe('Showcase 126-A — consumer A: table header row from describe().fields', () => {
  it('returns the correct labels for all configured fields', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'demo',
      secret: 'showcase-126-a',
    })
    const vault = await db.openVault('firm')

    interface Sale extends Record<string, unknown> {
      id: string
      saleDate: string
      total: string
      status: string
      buyerId: string
      buyerVat: string
      notes?: string
    }

    const sales = vault.collection<Sale>('sales', {
      moneyFields:  { total: money({ currency: 'EUR' }) },
      dictKeyFields: { status: SALE_STATUS },
      refs:         { buyerId: ref('buyers') },
      fieldMeta:    SALE_FIELD_META,
    })

    // Sync — zero store I/O
    const d = sales.describe()

    // Consumer A: build a table header row
    const headers = d.fields.map((f) => f.label)

    // fieldMeta labels override the humanised key name
    expect(headers).toContain('Date')           // saleDate → 'Date'
    expect(headers).toContain('Total (€)')      // total    → 'Total (€)'
    expect(headers).toContain('Buyer')           // buyerId  → 'Buyer'
    expect(headers).toContain('VAT number')     // buyerVat → 'VAT number'
    expect(headers).toContain('Internal notes') // notes    → 'Internal notes'

    // staticDict field falls back to humanised key when no fieldMeta label provided
    // ('status' → 'Status' via humanizeFieldKey)
    expect(headers).toContain('Status')

    // Fields are in alphabetical key order (describe() sorts by key, not label)
    const fieldKeys = d.fields.map((f) => f.key)
    const sortedKeys = [...fieldKeys].sort()
    expect(fieldKeys).toEqual(sortedKeys)

    db.close()
  })

  it('describe() is synchronous — no awaiting required', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'demo',
      secret: 'showcase-126-a2',
    })
    const vault = await db.openVault('firm')

    interface SaleSimple extends Record<string, unknown> {
      id: string
      amount: string
    }

    const sales = vault.collection<SaleSimple>('sales', {
      moneyFields: { amount: money({ currency: 'USD' }) },
      fieldMeta: { amount: { label: 'Amount', unit: '$' } },
    })

    // Notably: no `await` — describe() returns CollectionDescription directly
    const d = sales.describe()
    const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f]))

    expect(d.collection).toBe('sales')
    expect(byKey.amount?.label).toBe('Amount')
    expect(byKey.amount?.unit).toBe('$')
    expect(byKey.amount?.semanticType).toBe('currency')
    expect(byKey.amount?.aggregate).toBe('sum')
    expect(byKey.amount?.money).toMatchObject({ mode: 'fixed', currency: 'USD' })

    db.close()
  })
})

// ── Part B: export column spec ────────────────────────────────────────────────

describe('Showcase 126-B — consumer B: export column spec — flag PII/secret fields', () => {
  it('derives an export spec from describe(): label + redacted flag for non-public fields', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'demo',
      secret: 'showcase-126-b',
    })
    const vault = await db.openVault('firm')

    interface Sale extends Record<string, unknown> {
      id: string
      saleDate: string
      total: string
      status: string
      buyerId: string
      buyerVat: string
      notes?: string
    }

    const sales = vault.collection<Sale>('sales', {
      moneyFields:   { total: money({ currency: 'EUR' }) },
      dictKeyFields: { status: SALE_STATUS },
      refs:          { buyerId: ref('buyers') },
      fieldMeta:     SALE_FIELD_META,
    })

    const d = sales.describe()

    // Consumer B: build an export column spec.
    // Public fields are exported as-is; PII and secret fields are flagged for redaction.
    const exportSpec = d.fields.map((f) => ({
      key:      f.key,
      label:    f.label,
      redacted: f.sensitivity !== undefined && f.sensitivity !== 'public',
    }))

    const byKey = Object.fromEntries(exportSpec.map((c) => [c.key, c]))

    // PII fields are flagged
    expect(byKey.buyerId?.redacted).toBe(true)
    expect(byKey.buyerVat?.redacted).toBe(true)

    // Secret fields are flagged
    expect(byKey.notes?.redacted).toBe(true)

    // Fields without a sensitivity setting are NOT redacted
    expect(byKey.saleDate?.redacted).toBe(false)
    expect(byKey.total?.redacted).toBe(false)
    expect(byKey.status?.redacted).toBe(false)

    // Labels are correct in the export spec too (same describe() call)
    expect(byKey.buyerId?.label).toBe('Buyer')
    expect(byKey.total?.label).toBe('Total (€)')

    db.close()
  })

  it('two consumers, one describe() call — identical field list', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'demo',
      secret: 'showcase-126-b2',
    })
    const vault = await db.openVault('firm')

    interface Sale extends Record<string, unknown> {
      id: string
      saleDate: string
      total: string
      status: string
      buyerId: string
      buyerVat: string
      notes?: string
    }

    const sales = vault.collection<Sale>('sales', {
      moneyFields:   { total: money({ currency: 'EUR' }) },
      dictKeyFields: { status: SALE_STATUS },
      refs:          { buyerId: ref('buyers') },
      fieldMeta:     SALE_FIELD_META,
    })

    // Both consumers read ONE result — no second describe() call
    const d = sales.describe()

    const headerRow   = d.fields.map((f) => f.label)
    const exportCols  = d.fields.map((f) => ({ label: f.label, redacted: f.sensitivity !== 'public' && f.sensitivity !== undefined }))
    const piiKeys     = d.fields.filter((f) => f.sensitivity === 'pii').map((f) => f.key)
    const secretKeys  = d.fields.filter((f) => f.sensitivity === 'secret').map((f) => f.key)

    // Consumer A (table header)
    expect(headerRow).toContain('Buyer')
    expect(headerRow).toContain('Total (€)')

    // Consumer B (export spec)
    const buyerExport = exportCols.find((c) => c.label === 'Buyer')
    expect(buyerExport?.redacted).toBe(true)

    // PII fields: buyerId + buyerVat
    expect(piiKeys).toContain('buyerId')
    expect(piiKeys).toContain('buyerVat')
    expect(piiKeys).not.toContain('total')

    // Secret fields: notes
    expect(secretKeys).toContain('notes')
    expect(secretKeys).not.toContain('saleDate')

    db.close()
  })
})

// ── Part C: merge precedence + structural inference ───────────────────────────

describe('Showcase 126-C — merge precedence: channel > inferred-from-config', () => {
  it('fieldMeta channel overrides inferred semanticType/aggregate for money fields', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'demo',
      secret: 'showcase-126-c',
    })
    const vault = await db.openVault('firm')

    interface Invoice extends Record<string, unknown> {
      id: string
      amount: string
      clientId: string
    }

    // Without fieldMeta: money infers semanticType:'currency', aggregate:'sum'
    const plain = vault.collection<Invoice>('invoices-plain', {
      moneyFields: { amount: money({ currency: 'EUR' }) },
    })
    const dPlain = plain.describe()
    const amountPlain = dPlain.fields.find((f) => f.key === 'amount')!
    expect(amountPlain.semanticType).toBe('currency')
    expect(amountPlain.aggregate).toBe('sum')

    // With fieldMeta channel: channel wins over inferred values
    const withMeta = vault.collection<Invoice>('invoices-meta', {
      moneyFields: { amount: money({ currency: 'EUR' }) },
      fieldMeta: {
        amount: {
          label: 'Invoice amount',
          unit: '€',
          // channel overrides: keep semanticType:'currency' but set aliases
          semanticType: 'currency',
          aliases: ['amount', 'invoice total'],
        },
        clientId: { label: 'Client', sensitivity: 'pii' },
      },
      refs: { clientId: ref('clients') },
    })
    const dMeta = withMeta.describe()
    const byKey = Object.fromEntries(dMeta.fields.map((f) => [f.key, f]))

    // channel label wins
    expect(byKey.amount?.label).toBe('Invoice amount')
    // channel unit present
    expect(byKey.amount?.unit).toBe('€')
    // channel aliases present
    expect(byKey.amount?.aliases).toContain('invoice total')
    // inferred money block still present
    expect(byKey.amount?.money).toMatchObject({ mode: 'fixed', currency: 'EUR' })

    // ref: inferred entity + channel overrides label + sensitivity
    expect(byKey.clientId?.semanticType).toBe('entity')
    expect(byKey.clientId?.label).toBe('Client')
    expect(byKey.clientId?.sensitivity).toBe('pii')
    expect(byKey.clientId?.ref).toMatchObject({ target: 'clients' })

    db.close()
  })

  it('staticDict: describe() surfaces values with labels synchronously', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'demo',
      secret: 'showcase-126-c2',
    })
    const vault = await db.openVault('firm')

    interface OrderRecord extends globalThis.Record<string, unknown> {
      id: string
      status: string
    }

    const coll = vault.collection<OrderRecord>('orders', {
      dictKeyFields: {
        status: staticDict('orderStatus', {
          open:   { en: 'Open' },
          closed: { en: 'Closed' },
        }, { displayLocale: 'en' }),
      },
    })

    const d = coll.describe()
    const statusField = d.fields.find((f) => f.key === 'status')!

    expect(statusField.type).toBe('enum')
    expect(statusField.dict?.static).toBe(true)
    expect(statusField.dict?.name).toBe('orderStatus')

    // Labels from the in-code static table are surfaced synchronously
    const labels = statusField.dict?.values?.map((v) => v.label)
    expect(labels).toContain('Open')
    expect(labels).toContain('Closed')

    db.close()
  })
})
