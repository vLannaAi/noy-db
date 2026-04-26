# periods

> **Subpath:** `@noy-db/hub/periods`
> **Factory:** `withPeriods()`
> **Cluster:** D — Time & Audit
> **LOC cost:** ~334 (off-bundle when not opted in)

## What it does

Accounting-style period closure with a write-guard. After `vault.closePeriod({ name, dateField, endDate })`, any later put of a record whose business date (`record[dateField]`) falls inside the closed range throws `PeriodClosedError`. Period closures themselves form a hash-chained anchor sequence written to the ledger.

## When you need it

- Accounting / financial books that need year-end and quarter-end seals
- Audit / regulatory workflows where post-close edits must be impossible
- Inventory or reporting systems with closed periods

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withPeriods } from '@noy-db/hub/periods'
import { withHistory } from '@noy-db/hub/history' // periods writes ledger entries

const db = await createNoydb({
  store: ...,
  user: ...,
  periodsStrategy: withPeriods(),
  historyStrategy: withHistory(), // recommended
})
```

## API

- `vault.closePeriod({ name, dateField?, endDate })`
- `vault.openPeriod({ name, startDate, priorPeriodName, carryForward? })`
- `vault.listPeriods()` — closed/open chain in order
- `vault.previousPeriod()` — `VaultInstant` view at the prior closed boundary

## Behavior when NOT opted in

- `vault.closePeriod()` / `.openPeriod()` throw with a pointer to `@noy-db/hub/periods`
- `vault.listPeriods()` returns `[]` — no chain
- The write-guard is a no-op — every put succeeds regardless of date

## Pairs well with

- **history** — period boundaries are anchored in the ledger
- **consent** — period close events appear in the audit log

## Edge cases & limits

- `dateField` is recommended over the default `_ts` fallback — accounting semantics use business date, not write time
- A late entry (write-time after close, business-date inside close) is the canonical correctness check; a `_ts`-only seal would silently let it through
- Period chain integrity: each close hashes the prior close's record. Tampering with one breaks the chain on `vault.verifyBackupIntegrity()`

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `docs/recipes/accounting-app.md`
- `__tests__/periods.test.ts`, `showcases/src/15-year-end-closure.showcase.test.ts`
