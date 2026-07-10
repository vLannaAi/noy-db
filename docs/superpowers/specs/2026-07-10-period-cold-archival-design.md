# Period-driven cold archival — design (#613, #604 Spec 3)

**Date:** 2026-07-10
**Issue:** [#613](https://github.com/vLannaAi/noy-db/issues/613) — the deferred cold-archival half of the #604 period-close lifecycle.
**Milestone:** Retention: purge, GC & archival. This design is `surface: api` (no `/adapter` change).
**Builds on:** the shipped `with-audit/periods` subsystem (close/open/freeze), the shipped `Vault._purgeDeleteMarkers` seam pattern (`kernel/vault.ts`), and the existing `routeStore` age-tiering machinery (`with-store/route-store.ts`).

## Reframing (from the brainstorm)

#604's original scope named a cold-archival phase: "a frozen period's sealed live records should be movable to a cold/cheap storage tier while keeping period summaries hot." Exploration found that **most of the cold-tier machinery already exists on the existing `NoydbStore` seam** — so this is a small, surgical spec, not a new subsystem:

- `routeStore({ age: { cold, coldAfterDays, collections } })` already performs a **physical hot/cold storage split**: old records live in a cheap backend, reads **transparently fall through** to cold on a hot miss (`get()`), and `routeStore.compact(vault)` is the background migrator (put to cold, delete from hot). It wraps `NoydbStore`s → **no `/adapter` change**.
- Period **summaries stay hot for free**: `_periods` / `_period_freezes` / `_period_archives` are `_`-prefixed, and age-tiering skips `_`-prefixed collections.
- **True memory-cold** already exists via `withLazy()` — per-id reads into a bounded LRU, no bulk hydration.

**The one genuine gap:** all of that migration keys off a *rolling* age (`coldAfterDays`), triggered by `compact()`, **decoupled from periods**. #604's vision is precise — a **specific closed period's** records go cold, driven by the operator's lifecycle action, keyed to the exact period window, not an arbitrary N-days cutoff. This spec closes exactly that gap and nothing more.

## Decision summary

1. **Scope:** add `vault.archivePeriod(name)` — relocate a *closed* period's in-window sealed records to the configured cold tier, keyed to the period's `_ts` upper bound, reusing `routeStore`'s migration + read-through. Move only; no new storage backend owned by the subsystem.
2. **Boundary:** `_ts ≤ endDate` (the same `periodExclusiveUpperBound(endDate)` freeze uses), **not** business date — the store tier sees only encrypted envelopes and cannot read `record[dateField]`.
3. **Non-destructive + separate from freeze:** archival keeps records readable (read-through), so it is gated only on `closed` (does not require `frozen` first) and is a **separate call** from `freezePeriod`.
4. **Idempotent:** a companion `_period_archives/<name>` record makes re-archiving a no-op.
5. **Store requirement:** the vault's store must be a `routeStore` with a cold route, enforced by a store **capability** (`coldArchival`) with a clear error otherwise.
6. **Surface:** `api` only — rides the existing `NoydbStore` seam; no `/adapter` change.

## Design

### 1. API + gating

```ts
vault.archivePeriod(name: string): Promise<PeriodRecord>
```

- Loads the periods cache; the named period must exist and be `kind: 'closed'`. Throw `ValidationError` if the period is absent or is `kind: 'opened'`.
- Requires the periods service (`withPeriods()`); with `NO_PERIODS` the call path is unreachable (same as `closePeriod` / `freezePeriod`).
- **Requires a cold-capable store.** The vault's store must be a `routeStore` configured with a cold route. Enforced by checking `store.capabilities?.coldArchival === true`; otherwise throw `ValidationError("archivePeriod: cold archival requires a routeStore with a cold route.")`. (Capability, not `typeof store.compact === 'function'` duck-typing — a plain store must fail loudly, not silently no-op.)
- **No frozen-first requirement.** Archival is non-destructive: after the move, records are still read via `routeStore`'s cold read-through, so archival does not re-open the #589 resurrection window and does not need freeze's convergence safe-point. Freeze (purge markers) and archive (move records cold) are independent and compose in either order.
- **Idempotent:** `archivePeriod` first reads the companion `_period_archives/<name>`; if present, it is a **no-op** returning the period merged with the existing archive fields — no re-migration, no second ledger entry.

Wire it the same way as `freezePeriod`: a `VaultPeriods.archivePeriod` method (`with-audit/periods/vault-facade.ts`) + a thin `vault.archivePeriod` delegator (`kernel/vault.ts`, beside `freezePeriod`).

### 2. What it archives — the `_ts` boundary

`routeStore` operates on **encrypted envelopes**. A record's business date lives inside the encrypted `_data`; only the envelope's write-time `_ts` is visible at the store tier (this is exactly why the existing `AgeRoute` tiers by `_ts`). So period archival bounds the move by write-time **`_ts < periodExclusiveUpperBound(endDate)`** — the identical boundary `freezePeriod` uses for its marker purge.

**Consequence (documented, correct — identical to freeze's late-booked-delete rule):** a record with an in-period *business date* but a later *`_ts`* (booked after the period end) has an out-of-window `_ts`, so it is **not** moved by this period's archive; it is archived when the *next* period is archived (its `_ts` falls in that window). This mirrors the family's existing "reclaimed at the next period's freeze" behavior for late-booked deletes and re-imported markers — a consistent rule, not a special case.

**Never touched:** `_`-prefixed reserved collections (`_periods` / `_period_freezes` / `_period_archives` — the summaries and chain records) are excluded, so summaries stay hot by construction. Delete markers are purged by `freezePeriod`, not archived.

### 3. Mechanism — surgical `routeStore` extension

Three small pieces:

**a. `routeStore.compact` gains an explicit cutoff.**

```ts
compact(vault: string, opts?: { before?: string }): Promise<number>
```

When `opts.before` is provided, migration uses `env._ts < opts.before` as the cold predicate instead of the `coldAfterDays`-derived cutoff; the cold destination is still `opts.age.cold`. `isCold` gains an optional explicit-`before` path:

```ts
function isCold(collection: string, env: EncryptedEnvelope, before?: string): boolean {
  if (collection.startsWith('_')) return false          // summaries/chain records stay hot
  if (opts.age?.collections?.length && !opts.age.collections.includes(collection)) return false
  // explicit period cutoff wins; else the rolling age cutoff; else nothing is cold
  const cutoff =
    before ??
    (opts.age?.coldAfterDays != null
      ? isoOf(Date.now() - opts.age.coldAfterDays * 86_400_000)
      : undefined)
  return cutoff !== undefined && env._ts < cutoff
}
```

Note the explicit `_`-prefix guard: the current `collections`-omitted `compact()` path lists **all** collections from the primary, so the period-archival path must exclude reserved collections or it would archive the summaries. This guard is added to `isCold` so it protects both the rolling and the period-driven paths.

**b. A cold destination without a rolling age.** Relax `AgeRoute` so `coldAfterDays` is optional: `age: { cold }` alone means "cold destination configured for period-driven archival, no rolling auto-compact." When `coldAfterDays` is omitted, the rolling `compact(vault)` (no `before`) migrates nothing; only `compact(vault, { before })` acts. `routeStore` advertises `capabilities.coldArchival = true` whenever `opts.age?.cold` is set.

**c. The Vault seam.** A new `@internal` `Vault` method parallel to `_purgeDeleteMarkers`:

```ts
// kernel/vault.ts
async _archiveClosedPeriod(before: string): Promise<number> {
  const store = this.store as Partial<RoutedNoydbStore>
  if (store.capabilities?.coldArchival !== true || typeof store.compact !== 'function') {
    throw new ValidationError('archivePeriod: cold archival requires a routeStore with a cold route.')
  }
  return store.compact(this.name, { before })
}
```

`VaultPeriods` gains an `archiveRecords: (before) => this._archiveClosedPeriod(before)` dep, exactly parallel to the shipped `purgeDeleteMarkers` dep.

### 4. State + ledger (mirrors freeze exactly)

Like freeze, archival state lives in a **companion record** in a new reserved collection, never mutating the hash-chained `_periods/<name>` record (rewriting a sealed, chained record would break its `priorPeriodHash` chain the moment a `verifyPeriodChain()` ships — the same reasoning §3 of the freeze spec established):

```ts
export const PERIOD_ARCHIVES_COLLECTION = '_period_archives'   // sibling of '_periods' / '_period_freezes'

export interface PeriodArchiveRecord {
  readonly period: string              // the archived period's name (the key)
  readonly archivedAt: string          // ISO, archive call time
  readonly archivedBy: string          // invoking keyring userId
  readonly archivedRecordCount: number // records physically relocated hot → cold
}
```

`PeriodRecord` gains `archivedAt?`, `archivedBy?`, `archivedRecordCount?` as **optional, return-only** fields: never written into the stored `_periods/<name>` record, merged in from the companion when a `PeriodRecord` is returned by `getPeriod` / `listPeriods` / `archivePeriod`.

Archival writes the companion through the same encrypt-and-put path period records use (`writeReserved`, keyed `_period_archives/<name>`) and appends one tamper-evident ledger entry via `appendPeriodLedgerEntry(ledger, userId, envelope, name, PERIOD_ARCHIVES_COLLECTION)` — reusing the trailing-`collection` param added in #604 so the ledger attributes the put to `_period_archives`, not the chained `_periods` record (the exact bug #604's whole-branch review caught for freeze; archival must not repeat it).

### 5. Read path + the hydrated-mode limitation

- **Lazy mode (`withLazy()`):** collections declared `prefetch: false` read per-id via `get()`, which hits `routeStore`'s cold read-through on a hot miss. *True* cold — an archived record touches RAM only when accessed.
- **Hydrated mode (default):** `routeStore.loadAll` merges all stores (including cold), so archived records load into RAM on vault open. **Hot-tier storage is reclaimed; RAM is not.** This is an existing property of `AgeRoute`, documented here so the operator knows `withLazy()` is the answer when memory-cold (not just storage-cold) is the goal. Queries and reads return archived records correctly in both modes.

### 6. Interaction with the write-seal

Unchanged and strictly additive: an archived period is still `kind: 'closed'`, so `assertTsWritable` still rejects writes to it. Archival changes only physical storage location (records move hot → cold), never the seal semantics or read results.

### 7. Testing

Behind `withPeriods()`, on an encrypted vault whose store is a `routeStore({ default: hot, age: { cold } })` (white-box `hot` / `cold` memory stores exposing `.raw()`), mirroring `period-freeze.test.ts`:

1. **Relocates in-window records:** close a period; `archivePeriod` moves records with `_ts < bound` out of the hot store into the cold store; `archivedRecordCount` matches; the records are **absent from hot, present in cold**.
2. **Reads still resolve after archival:** `get`/`query` for an archived id returns the record (cold read-through) — value unchanged.
3. **Leaves out-of-window records hot:** a record with `_ts` after `endDate` (late-booked) stays in the hot store; a later period's archive relocates it.
4. **Summaries stay hot:** `_periods` / `_period_freezes` / `_period_archives` records remain in the hot store after archive.
5. **Gating:** `archivePeriod` on an absent or `kind: 'opened'` period throws; requires the strategy.
6. **Store requirement:** `archivePeriod` on a vault whose store is a plain (non-route) store throws the cold-archival `ValidationError`.
7. **Idempotent:** a second `archivePeriod` is a no-op (no re-migration, no extra ledger entry, `archivedAt` + count stable, companion bytes unchanged).
8. **Ledger + chain immutability:** archive appends exactly one ledger entry attributed to `_period_archives`, writes the `_period_archives/<name>` companion, and leaves the stored `_periods/<name>` record's bytes **unchanged**; `verifyBackupIntegrity()` stays ok on a `withPeriods()` + `withHistory()` vault post-archive (the regression #604 caught for freeze). `getPeriod` / `listPeriods` return the period with the merged archive fields.
9. **Seal preserved:** writes to an archived period still throw `PeriodClosedError`.
10. **Compose with freeze:** freeze-then-archive and archive-then-freeze both succeed and leave a consistent state (markers purged, records cold, summaries hot).

## Out of scope (deferred / rejected)

- **#611 cross-target purge** — sweeping the vault's *sync targets* (remote peers) is a different axis from the local hot/cold split; stays deferred to its own future work, not folded in here.
- **Un-archive / restore-to-hot** — cold is cold; read-through makes tier location transparent, so there is no functional need. A future rolling `compact()` in the reverse direction could restore if ever wanted (YAGNI now).
- **Business-date-precise archival** — rejected: it would require decryption at the store tier, breaking the "stores never see plaintext" invariant. `_ts` bounding is the sound choice.
- **Cold-archival of forget-tombstones / history / delete markers** — markers are freeze's job; tombstones and history are audit evidence kept hot.
