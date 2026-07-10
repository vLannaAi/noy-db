# Accounting periods

The `periods` subsystem manages closed accounting periods and their lifecycle: closure (seals writes), opening (materializes summaries), and two subsequent phases for retention and physical reclamation.

## Core operations

### closePeriod(name, endDate)

Seals a period by its name and inclusive end date. Every record whose `_ts ≤ endDate` (by write-time, or by business date if you provide a `dateField`) is locked against further writes — `put`/`delete` throw `PeriodClosedError`. The period itself is stored as a hash-chained record in the reserved `_periods` collection and appends a tamper-evident ledger entry. Periods form a linked chain: each records its prior period's hash, so the ledger cannot be tampered with later without breaking the chain.

### openPeriod(name, startDate, fromPeriod, carryForward)

Opens a new period after a closed one, optionally materializing closing aggregates as opening balances. The `carryForward` callback receives a read-only vault anchored at the prior period's `endDate` so it can compute summaries from the sealed state; the returned records are written with fresh timestamps (outside every closed period) before the new period's record lands.

### freezePeriod(name)

Physically purges the delete markers written within a closed period's window (those with `_ts < periodExclusiveUpperBound(endDate)`). Freeze does NOT purge live records, `_history` versions, or forget-tombstones (GDPR crypto-shred evidence) — the delete-markers-only seam leaves all three untouched. State lives in a companion `_period_freezes/<name>` record (the chained `_periods/<name>` stays byte-immutable for chain verification), and a tamper-evident ledger entry is appended. Freezing is terminal (a frozen period cannot be unfrozen) and idempotent (a second call is a no-op). Late-booked deletes (records with in-period business dates but `_ts` after the window) are reclaimed by the NEXT period's freeze. Freeze is local-only; on a synced vault, markers re-imported from sync targets survive there and are reclaimed by their next period's freeze at the remote.

### archivePeriod(name)

Relocates the closed period's in-window records (those with `_ts < periodExclusiveUpperBound(endDate)`) from the hot store to the configured cold tier (a `routeStore` with an `age: { cold }` route). Archival is non-destructive: `routeStore` reads fall through to cold on a hot miss, so archived records still load normally. It is therefore gated only on `closed` (not `frozen`) — it does not re-open the resurrection window and needs no convergence safe-point. State lives in a companion `_period_archives/<name>` record (chain-immutable), and a ledger entry is appended. Archival is idempotent and independent of freeze (compose in either order). Bounds by write-time `_ts`, not business date, so late-booked records archive at the next period. Requires a `routeStore` with a cold route; throws otherwise. Read cost: with `withLazy()`, archived records are truly cold (fetched from cold only on access); in the default hydrated mode, `loadAll` merges the cold store so archived records still load into RAM on open (hot-tier storage is reclaimed; RAM is not). Summaries always stay hot. A backup/restore round-trip re-materializes archived records into the hot tier (restore's `saveAll` partitions user collections back to `default`), while the restored `_period_archives` companion keeps `archivePeriod` a no-op — reads and integrity remain correct (non-destructive), but to reclaim hot space again the operator re-runs the archival (e.g. `store.compact(vault, { before })`).
