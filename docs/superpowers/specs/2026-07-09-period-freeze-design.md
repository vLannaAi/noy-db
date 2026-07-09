# Period freeze — design (#604, Spec 2 of the #589 arc)

**Date:** 2026-07-09
**Issue:** [#604](https://github.com/vLannaAi/noy-db/issues/604) (period-close lifecycle + operator purge/archive)
**Milestone:** Retention: purge, GC & archival — this design is `surface: api` (no `/adapter` change).
**Builds on:** #589's shipped `Vault._purgeDeleteMarkers(before, collections?)` seam (`kernel/vault.ts:1342`) and the existing `with-audit/periods` subsystem.

## Reframing (from the brainstorm)

#604 was scoped as "build a period-close lifecycle + purge + archive + summaries + scheduling." Exploration found the **`with-audit/periods` subsystem already exists and is mature**: `vault.closePeriod({ name, endDate, dateField? })` seals every record whose business date (`record[dateField]`, else envelope `_ts`) is `≤ endDate` — further writes throw `PeriodClosedError`; the period is a ledger-instrumented record in the reserved `_periods` collection with a tamper-evident hash chain; `vault.openPeriod({ …, carryForward })` materializes closing aggregates as opening balances (**that is the "summary"**); `listPeriods`/`getPeriod` round it out; opt-in via `withPeriods()` / `periodsStrategy`.

Two originally-sketched #604 features conflict with deliberate existing decisions and are **dropped**: **re-open** (the sanctioned path is a compensating entry in the *new* period, not unlocking a sealed one) and **scheduled/auto-rollover** (`close`/`open` are deliberately explicit operator calls).

What genuinely does **not** exist is the **"frozen" phase**: a closed period seals writes *logically* but nothing *physically* purges the delete markers #589 leaves behind. That is this spec. Cold-archival tiering of sealed records is deferred to its own later spec.

## Decision summary

1. **Scope:** add `vault.freezePeriod(name)` — physically purge the delete markers within a *closed* period's window, via `_purgeDeleteMarkers`. Purge only; no cold-archival.
2. **Safe-point:** a closed period is the operator-asserted convergence boundary #589 requires; the `freezePeriod` call *is* the assertion (no auto-freeze, no mandatory delay in v1).
3. **Marker boundary:** markers have no business date (empty body), so freeze bounds them by write-time `_ts ≤ endDate`. Late-booked deletes reclaim at the next period's freeze.
4. **Terminal + idempotent:** frozen cannot be unfrozen; re-freezing is a no-op.
5. **Surface:** `api` only — uses the store's existing `delete` via the shipped seam; no `/adapter` change.

## Design

### 1. API + gating

```ts
vault.freezePeriod(name: string): Promise<PeriodRecord>
```

- Loads the periods cache; the named period must exist and be `kind: 'closed'`. Throw `ValidationError` if the period is absent or is `kind: 'opened'`. If the period exists, is closed, and is **already frozen**, return it unchanged (idempotent no-op — see §3).
- Requires the periods service (`withPeriods()`); with `NO_PERIODS` the call path is unreachable (same as `closePeriod`).
- **The operator's call is the convergence assertion.** No settle-delay guard in v1 — the operator owns "this period is settled," exactly as they own `closePeriod`. (A future optional `{ minClosedAge }` guard is a clean additive extension; YAGNI now.)
- **Terminal:** there is no `unfreezePeriod`, consistent with the subsystem's no-re-open stance.

Wire it the same way as `closePeriod`: a `VaultPeriods.freezePeriod` method (`with-audit/periods/vault-facade.ts`) + a thin `vault.freezePeriod` delegator (`kernel/vault.ts`, beside `closePeriod` at ~:3382).

### 2. What it purges — the marker boundary

Freeze calls the shipped seam:

```ts
const purged = await this._purgeDeleteMarkers(<exclusiveUpperBound>)
```

**The nuance:** the period *seals records* by business date (`record[dateField] ≤ endDate`), but a delete marker carries an **empty body — no `dateField`, only its write-time `_ts`**. So markers can only be bounded by `_ts`. Freeze purges delete markers with **`_ts ≤ period.endDate`**.

Implementation detail: `_purgeDeleteMarkers(before)` filters `env._ts < before` (strict). `endDate` is an inclusive date/timestamp bound. To make `_ts ≤ endDate` inclusive of the whole `endDate`, pass the **exclusive upper bound**: if the period has a successor `opened` period chained from it (via `openPeriod`'s `fromPeriod`), use that successor's `startDate`; otherwise use `endDate` widened to its end-of-day (`endDate` + `'T23:59:59.999Z'` when `endDate` is a bare date, else `endDate` itself is already a timestamp and the successor/`endDate`-as-is applies). The spec's invariant is *inclusive of `endDate`, exclusive of anything after*; the plan pins the exact string construction with tests for both a bare-date `endDate` and a full-timestamp `endDate`.

**Consequence (documented, correct):** a *late-booked* delete — a record with an in-period business date, deleted *after* `endDate` (write-time `_ts` after the window) — has an out-of-window marker `_ts`, so it is **not** purged by this period's freeze; it is reclaimed when the *next* period freezes (its `_ts` falls in that window). This is conservative and correct: the delete already converged and reads absent; the marker merely lingers one more period. It is the only sound option given markers have no business date.

**Never touched:** forget-tombstones (GDPR crypto-shred erasure *evidence*) and live records — the `_purgeDeleteMarkers` seam is delete-markers-only by construction (`isDeleteMarker`, i.e. `_del === true`), so `isTombstoneShape` forget-tombstones and live envelopes are structurally out of range. Freeze passes **no `collections` filter** → all data collections in the vault.

### 3. State + ledger (closes a #589 deferral)

**Freeze must NOT mutate the chained `_periods/<name>` record.** Periods are hash-chained: each period stores `priorPeriodHash = sha256(canonicalJson(priorPeriodRecord))` (`chainAnchor`), and the subsystem explicitly anticipates a `verifyPeriodChain()` (docstring, `periods.ts`). Rewriting a *sealed, already-chained* period record to add `frozenAt` would change its `canonicalJson` → change its hash → make the successor's stored `priorPeriodHash` mismatch → break the chain the moment that verifier ships. There is no `verifyPeriodChain()` today, so this would be a *latent* corruption in the one property the subsystem exists to guarantee — unacceptable in an audit product.

Instead, freeze state lives in a **companion record** in a new reserved collection, leaving the chained record untouched:

```ts
export const PERIOD_FREEZES_COLLECTION = '_period_freezes'   // sibling of '_periods'

export interface PeriodFreezeRecord {
  readonly period: string             // the frozen period's name (the key)
  readonly frozenAt: string           // ISO, freeze call time
  readonly frozenBy: string           // invoking keyring userId
  readonly purgedMarkerCount: number  // markers physically removed
}
```

`PeriodRecord` gains the same three fields as **optional, return-only** (`frozenAt?`, `frozenBy?`, `purgedMarkerCount?`): they are **never written into the stored `_periods/<name>` record** (so its `canonicalJson`/hash is unchanged), and are merged in from the companion when a `PeriodRecord` is *returned* by `getPeriod` / `listPeriods` / `freezePeriod`. The public shape stays "a frozen period carries these fields"; the storage keeps them off the chained record.

Freeze writes the companion through the same encrypt-and-put path period records use (`writePeriodRecord`-style, keyed `_period_freezes/<name>`) and appends a tamper-evident ledger entry via `appendPeriodLedgerEntry` (actor, boundary, count). **This is exactly the ledger/event emission deferred from #589's `_purgeDeleteMarkers`** (its doc: "emits no ledger/event yet — #604's period-close, the only intended caller, owns the audit record"). Freeze is that caller; this closes the deferral.

**Idempotency:** `freezePeriod` first reads the companion `_period_freezes/<name>`; if present, it is a **no-op** returning the period merged with the existing freeze fields — no re-purge, no second ledger entry.

### 4. Interaction with the write-seal

Unchanged and strictly additive: a frozen period is still `kind: 'closed'`, so the existing `assertTsWritable` guard still rejects writes to it. Freeze changes only physical storage (markers removed), never the seal semantics. Reads of purged ids remain `null` (they were already absent via the marker; now they're absent via true removal).

### 5. Testing

Behind `withPeriods()`, on an encrypted vault:

1. **Purge in-window markers:** close a period; delete records with markers whose `_ts ≤ endDate`; `freezePeriod` removes them from the raw store; `purgedMarkerCount` matches; reads stay `null`.
2. **Leave out-of-window markers:** a marker with `_ts` after `endDate` (late-booked delete) survives freeze; a subsequent later period's freeze reclaims it.
3. **Never touch live / forget-tombstones:** live records and forget crypto-shred tombstones in-window are untouched by freeze.
4. **Gating:** `freezePeriod` on a nonexistent or `kind: 'opened'` period throws; requires the strategy.
5. **Idempotent:** second `freezePeriod` is a no-op (no extra ledger entry, count unchanged, `frozenAt` stable).
6. **Ledger + chain immutability:** the freeze appends one ledger entry and writes the `_period_freezes/<name>` companion; the stored `_periods/<name>` record's bytes are **unchanged** by freeze (assert the chained record's `canonicalJson`/hash is identical before and after a freeze); `getPeriod`/`listPeriods` return the period with the merged freeze fields.
7. **Seal preserved:** writes to the frozen period still throw `PeriodClosedError`.
8. **Boundary construction:** parametrized over a bare-date `endDate` (`'2026-03-31'`) and a full-timestamp `endDate` — the inclusive-of-`endDate`, exclusive-of-after invariant holds for both.

## Out of scope (deferred / dropped)

- **Cold-archival tiering** of sealed live records (move to an `archive` target, keep summaries hot) — its own later spec; may need a storage-adapter capability (`surface: port`).
- **Purging forget-tombstones / history** — kept as audit evidence.
- **Re-open** and **scheduled/auto-freeze** — dropped (conflict with the subsystem's deliberate design).
- **Cross-vault / fleet freeze** (klum-db orchestration) — periods are a single-vault primitive; fleet orchestration, if ever wanted, binds this via `@noy-db/hub/cargo` and is klum's concern.
