# Recipe 2 — Accounting application

> **Audience:** compliance-heavy verticals — accounting, legal, healthcare records, insurance — where every change needs to be auditable, periods need to seal at year-end, attachments are normal, and labels need translation.
> **Bundle:** core + `withHistory` + `withPeriods` + `withBlobs` + `withI18n` + `withConsent` + `withAggregate` (~13,200 LOC).
> **Verified by:** [showcases/src/recipe-accounting-app.recipe.test.ts](../../showcases/src/recipe-accounting-app.recipe.test.ts)

## What this gets you

| Subsystem | What it adds |
|---|---|
| `withHistory()` | Per-record version snapshots, hash-chained audit ledger, `vault.timeMachine()` for point-in-time reads, `vault.verifyBackupIntegrity()` for tamper detection |
| `withPeriods()` | `vault.closePeriod()` / `openPeriod()` with a write-guard that rejects writes to records inside a closed business date range |
| `withBlobs()` | Binary attachments (receipts, invoices PDFs) with content-addressed dedup and MIME sniffing |
| `withI18n()` | `dictKey()` for shared label dictionaries (`status`, `taxClass`) + `i18nText()` for free-form translatable fields |
| `withConsent()` | Optional GDPR/PIPL-style consent audit log scoped to specific reads |
| `withAggregate()` | `sum`, `groupBy`, `count` for reports |

## Setup

```ts
import { createNoydb } from '@noy-db/hub'
import { withHistory } from '@noy-db/hub/history'
import { withPeriods } from '@noy-db/hub/periods'
import { withBlobs } from '@noy-db/hub/blobs'
import { withI18n } from '@noy-db/hub/i18n'
import { withConsent } from '@noy-db/hub/consent'
import { withAggregate } from '@noy-db/hub/aggregate'
import { postgres } from '@noy-db/to-postgres'

const db = await createNoydb({
  store: postgres({ url: process.env.DATABASE_URL! }),
  user: 'admin@firm.example',
  secret: process.env.NOYDB_PASSPHRASE!,

  historyStrategy: withHistory(),
  periodsStrategy: withPeriods(),
  blobsStrategy: withBlobs(),
  i18nStrategy: withI18n(),
  consentStrategy: withConsent(),
  aggregateStrategy: withAggregate(),
})
```

## Define collections with the right options

```ts
import { dictKey, i18nText } from '@noy-db/hub'

interface Invoice {
  id: string
  clientId: string
  status: string         // dictKey → resolves to a localised label on read
  description: Record<string, string>  // i18nText
  amount: number
  date: string           // YYYY-MM-DD — the business date used by closePeriod
}

const vault = await db.openVault('firm-2026')

// Seed the shared status dictionary once per vault.
await vault.dictionary('status').putAll({
  draft:   { en: 'Draft',    th: 'ฉบับร่าง',     ar: 'مسودة' },
  open:    { en: 'Open',     th: 'เปิดใช้งาน',   ar: 'مفتوح' },
  paid:    { en: 'Paid',     th: 'ชำระแล้ว',     ar: 'مدفوع' },
  overdue: { en: 'Overdue',  th: 'เกินกำหนด',    ar: 'متأخر' },
})

const invoices = vault.collection<Invoice>('invoices', {
  dictKeyFields: {
    status: dictKey('status', ['draft', 'open', 'paid', 'overdue'] as const),
  },
  i18nFields: {
    description: i18nText({ languages: ['en', 'th', 'ar'], required: 'all' }),
  },
})
```

## Write — every change is auditable

```ts
await invoices.put('inv-001', {
  id: 'inv-001',
  clientId: 'client-42',
  status: 'open',
  description: {
    en: 'Quarterly tax filing',
    th: 'การยื่นภาษีรายไตรมาส',
    ar: 'الإقرار الضريبي الفصلي',
  },
  amount: 15_000,
  date: '2026-03-15',
})

// History is recorded automatically. Edit again:
await invoices.put('inv-001', {
  ...(await invoices.get('inv-001'))!,
  status: 'paid',
})

// Read the entire history of this record:
const history = await invoices.history('inv-001')
// [{ version: 2, ts: '...', record: { status: 'paid', ... } },
//  { version: 1, ts: '...', record: { status: 'open', ... } }]

// Read what the record looked like on a specific date:
const q1End = vault.at('2026-03-31T23:59:59Z')
const asOfQ1 = await q1End.collection<Invoice>('invoices').get('inv-001')
```

## Close the period — Q1 books are sealed

```ts
import { PeriodClosedError } from '@noy-db/hub'

await vault.closePeriod({ name: 'Q1-2026', dateField: 'date', date: '2026-03-31' })

// Any later attempt to put a record with date ≤ 2026-03-31 throws:
await invoices.put('inv-late', {
  id: 'inv-late',
  amount: 1_000,
  date: '2026-03-15',  // inside Q1 — but Q1 is closed
  // ...
}).catch(err => {
  if (err instanceof PeriodClosedError) {
    // user-facing: "you can't book to a closed period"
  }
})
```

## Attach files

```ts
const receiptBlob = await invoices.blob('inv-001').put({
  field: 'receipt',
  bytes: new Uint8Array(/* PDF bytes */),
  mime: 'application/pdf',
})

// Read it back
const { bytes, mime } = await invoices.blob('inv-001').get('receipt')
```

## Run reports

```ts
import { sum, count } from '@noy-db/hub'

const monthly = await invoices.query()
  .where('status', '==', 'paid')
  .groupBy('clientId')
  .aggregate({ total: sum('amount'), invoiceCount: count() })
  .run()
// → [{ key: 'client-42', total: 78_500, invoiceCount: 12 }, ...]
```

## Verify nothing was tampered with

```ts
const verdict = await vault.verifyBackupIntegrity()
if (!verdict.ok) {
  // The hash chain or a data envelope was modified out-of-band.
  // Investigate: chainResult tells you the diverged index.
}
```

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md) — full catalog
- [docs/subsystems/history.md](../subsystems/history.md) (TODO)
- [docs/subsystems/periods.md](../subsystems/periods.md) (TODO)
- [docs/subsystems/blobs.md](../subsystems/blobs.md) (TODO)
- [showcases/src/15-year-end-closure.showcase.test.ts](../../showcases/src/15-year-end-closure.showcase.test.ts) — closer look at the closePeriod write-guard
