# Single-vault target-purge — design (#615, scoped base of #611)

**Date:** 2026-07-10
**Issue:** [#615](https://github.com/vLannaAi/noy-db/issues/615) — the buildable, provably-safe base of #611's cross-target-purge question, scoped to a single vault.
**Milestone:** Retention: purge, GC & archival. This design is `surface: api` (no `/adapter` change).
**Builds on:** the shipped `Vault._purgeDeleteMarkers(before, collections?)` seam (`kernel/vault.ts`), the `with-audit/periods` freeze/archive lifecycle, and the existing sync-target model (`SyncTarget { store, role }`, `role ∈ 'sync-peer' | 'backup' | 'archive'`; `with-party/team/sync.ts`).

## Problem (from #611)

`freezePeriod` purges delete markers on the **local** adapter only. Markers already pushed to the vault's sync targets survive there; on a `sync-peer` target a later pull re-imports them locally (benign — they still read deleted — but no space is reclaimed on either side, and re-imported markers only reclaim at the next period's freeze). #611 asked whether freeze should sweep the vault's sync targets too. That question splits by **target role**, and only one half is safe to build now.

## Reframing — the role split

A vault has 0..N sync targets, each a `SyncTarget { store: NoydbStore, role }`. The role already drives sync direction (`noydb.ts`: "`sync-peer` targets do pull+push; `backup`/`archive` targets are push-only"):

- **`backup` / `archive` — push-only sinks.** The vault pushes to them but never *pulls from* them into its convergence set. Purging their markers is **provably safe**: nothing pulls the record back. Value: reclaims backup/archive space the markers occupy.
- **`sync-peer` — bidirectional.** This is where #611's re-import comes from, and it is the **risky** one: purge a marker there and a client that was offline before the cutoff pulls, misses the delete, and pushes the live record back → resurrection (#589's window). The only safe precondition — *all* sharing clients have pulled past the cutoff — is an assertion no machine in noy-db can verify (there is no peer-consensus primitive; #589).

This design builds the **safe half** and explicitly defers the risky half.

## Decision summary

1. **Scope:** add `vault.purgePeriodTargets(name)` — sweep delete markers off the vault's **push-only** targets (`backup`/`archive`) for a **closed + frozen** period, keyed to the same `_ts` boundary as freeze.
2. **Role filter:** `backup`/`archive` only. `sync-peer` targets are skipped (deferred — see Out of scope).
3. **Gate:** closed → **frozen** → target-purged. The period must already be frozen locally (local safe point established) before its markers are swept on targets.
4. **No-op, not error, when there are no push-only targets.** A vault legitimately may have none.
5. **Idempotent + audited:** a `_period_target_purges/<name>` companion (chained `_periods` record untouched) + one ledger entry, mirroring freeze/archive.
6. **Surface:** `api` only — target stores are `NoydbStore`s; `loadAll`/`delete` are already in the contract. No new capability, no `/adapter` change.
7. **Single-vault only.** Fleet-wide purge across sovereign vaults stays klum's concern over `@noy-db/hub/cargo`.

## Design

### 1. API + gating

```ts
vault.purgePeriodTargets(name: string): Promise<PeriodRecord>
```

- Loads the periods cache; the named period must exist and be `kind: 'closed'`. Throw `ValidationError` if absent or `kind: 'opened'`.
- **Must already be frozen:** the `_period_freezes/<name>` companion must be present. Throw `ValidationError('purgePeriodTargets: period "<name>" must be frozen first (closed → frozen → target-purged).')` otherwise. Rationale: freeze is the local convergence safe-point; extending the purge to remote sinks only makes sense once the operator has asserted the period settled locally.
- Requires the periods service (`withPeriods()`); unreachable under `NO_PERIODS` (same as `freezePeriod`).
- **No push-only targets → re-runnable no-op:** if the vault has zero `backup`/`archive` targets, return the period **unchanged, writing no companion**. This is deliberately *not* an empty companion: a persisted zero-target companion would make a later run (after the operator adds a backup target) hit the idempotent no-op and silently never sweep the new target — the "archived-count-0 black hole" the #613 review caught. No targets → nothing recorded → the next call re-evaluates.
- **Idempotent (when a companion exists):** read the `_period_target_purges/<name>` companion first; if present, return the period merged with the existing fields — no re-sweep, no second ledger entry. Markers pushed to a target *after* the purge (and targets *added* after the purge) reclaim at the next period's target-purge — consistent with freeze's late-booked rule.

Wire it as a `VaultPeriods.purgePeriodTargets` method (`with-audit/periods/vault-facade.ts`) + a thin `vault.purgePeriodTargets` delegator (`kernel/vault.ts`, beside `freezePeriod`/`archivePeriod`), exactly as freeze/archive are wired.

### 2. What it sweeps — role filter + boundary

- Iterates the vault's sync targets, sweeping **only** those with `role === 'backup' || role === 'archive'`. **`sync-peer` targets are skipped** (resurrection risk; deferred).
- For each swept target store: remove delete markers (`isDeleteMarker`, i.e. `_del === true`) whose `_ts < periodExclusiveUpperBound(period.endDate)` — the **same boundary and predicate freeze uses locally**. Never touches live records or forget-tombstones (the marker-only predicate leaves both untouched by construction).
- Late-booked deletes (in-period business date, `_ts` after the window) reclaim at the next period's target-purge — identical to freeze's local rule.

### 3. Why this is safe

Push-only targets are never pulled from into the convergence set, so purging their markers cannot resurrect a record. The period is already **frozen** (local markers gone, record settled locally), so a later restore from a purged backup yields a consistent *deleted* state (the record is absent locally and on the backup). The `sync-peer` skip is the load-bearing safety choice: those are the only targets whose purge could reopen the #589 window, and their safe precondition is unverifiable in a single vault.

### 4. Mechanism — generalize the shipped sweep

- **Extract a store-parameterized sweep.** The shipped `_purgeDeleteMarkers(before, collections?)` (`kernel/vault.ts`) hardcodes `this.adapter`. Extract its body into:

  ```ts
  // @internal — sweep delete markers with `_ts < before` off ANY store. Returns the count removed.
  private async _purgeMarkersOn(store: NoydbStore, before: string, collections?: string[]): Promise<number> {
    const snapshot = await store.loadAll(this.name)
    let removed = 0
    for (const [coll, records] of Object.entries(snapshot)) {
      if (collections && !collections.includes(coll)) continue
      for (const [id, env] of Object.entries(records)) {
        if (isDeleteMarker(env) && env._ts < before) {
          await store.delete(this.name, coll, id)
          removed++
        }
      }
    }
    return removed
  }
  ```
  `_purgeDeleteMarkers` becomes a one-line caller: `return this._purgeMarkersOn(this.adapter, before, collections)`. Behavior for the local path is byte-identical (assert via the existing freeze tests).

- **Reach the targets.** noydb owns the sync targets (`syncEngines` / `normalizeSyncTargets`); the vault currently receives only `syncAdapter = targets[0].store`. Add a thin accessor passed to the Vault at construction:

  ```ts
  // noydb.ts, in the new Vault({...}) opts:
  getPurgeableTargets: () => targets
    .filter(t => t.role === 'backup' || t.role === 'archive')
    .map(t => ({ store: t.store, role: t.role, label: t.label })),
  ```
  Default to `() => []` when sync is not configured. The vault gets read/delete access to the target stores only; noydb stays the target-owner. (An accessor thunk, not a stored array, so it composes with the existing lazy/opts wiring.)

- **The facade seam.** `VaultPeriods` gains a `purgeTargets(before): Promise<TargetPurgeCount[]>` dep, wired in `kernel/vault.ts` to a `Vault._purgePeriodTargets(before)` method that iterates `getPurgeableTargets()` and calls `_purgeMarkersOn(target.store, before)` per target, returning `[{ label, role, purgedCount }]`.

### 5. State + audit (mirrors freeze/archive)

```ts
export const PERIOD_TARGET_PURGES_COLLECTION = '_period_target_purges'   // sibling of _periods / _period_freezes / _period_archives

export interface TargetPurgeCount {
  readonly label?: string
  readonly role: 'backup' | 'archive'
  readonly purgedCount: number
}

export interface PeriodTargetPurgeRecord {
  readonly period: string
  readonly purgedAt: string
  readonly purgedBy: string
  readonly targets: readonly TargetPurgeCount[]   // one entry per swept push-only target; [] if none
}
```

The companion is written **only when the vault has at least one push-only target** (even if that sweep removed zero markers — a real sweep with a 0 count is still recorded). With no push-only targets, no companion is written (see §1's re-runnable no-op). Kept **off** the chained `_periods/<name>` record (same chain-immutability reasoning as freeze/archive). `PeriodRecord` gains return-only `targetsPurgedAt?`, `targetsPurgedBy?`, and `targetsPurged?: readonly TargetPurgeCount[]` — merged from the companion on read (`getPeriod` / `listPeriods` / `purgePeriodTargets`), never written into `_periods/<name>`. Written via the existing generic `writeReserved`, with one `appendPeriodLedgerEntry(ledger, userId, envelope, name, PERIOD_TARGET_PURGES_COLLECTION)` — the trailing collection param MUST be the companion collection (the `verifyBackupIntegrity` misattribution class of bug from the #604 arc).

### 6. Interaction with freeze / archive / seal

Independent and additive. Target-purge never touches local storage (only target stores) and requires the period frozen, so it composes after freeze; it neither reads nor writes the `_period_freezes` / `_period_archives` companions. The period stays `kind: 'closed'`; the write-seal is unaffected. `getPeriod`/`listPeriods` now merge up to three companions (freeze, archive, target-purge) onto the returned record.

### 7. Testing

Behind `withPeriods()`, on an encrypted vault configured with a `backup`-role target (white-box `memory()` stores exposing `.raw()` for both local and target):

1. **Sweeps a backup target:** push a delete so a `_del` marker lands on the backup; close + freeze; `purgePeriodTargets` removes the in-window marker from the backup store; `targets[0].purgedCount` matches; local reads unaffected.
2. **Skips `sync-peer` targets:** a `sync-peer` target's in-window marker survives `purgePeriodTargets` (only push-only targets swept).
3. **Boundary:** an out-of-window marker (`_ts` after the period) on the backup survives.
4. **Gate — frozen required:** `purgePeriodTargets` on a closed-but-not-frozen period throws; on absent / `opened` throws.
5. **No targets → re-runnable no-op (no black hole):** a vault with no push-only targets returns the period with no target-purge fields and writes **no** companion (assert `_period_target_purges/<name>` absent). Then a *subsequent* call after a `backup` target is configured DOES sweep it and writes the companion — proving the no-target path didn't poison future runs.
6. **Idempotent:** second call is a no-op (no re-sweep, no second ledger entry, `purgedAt` stable, companion bytes unchanged).
7. **Ledger + chain immutability:** one ledger entry attributed to `_period_target_purges`; the stored `_periods/<name>` bytes are unchanged; `verifyBackupIntegrity()` stays ok on a `withPeriods()` + `withHistory()` vault post-purge. `getPeriod`/`listPeriods` return the merged fields (and still correctly merge freeze/archive companions when present).
8. **Local sweep unchanged:** the extracted `_purgeMarkersOn` leaves `_purgeDeleteMarkers`'s local behavior byte-identical (existing `period-freeze.test.ts` stays green).

## Out of scope (deferred / rejected)

- **`sync-peer` target purge** — the risky half; needs an all-clients-converged assertion no single vault can verify. Deferred; its thread stays tracked by #611. If ever built it is a distinct, louder operation, and the fleet-wide variant belongs to **klum** over `@noy-db/hub/cargo` (single-vault primitive here; fleet orchestration there).
- **`by-*` transports** (WebRTC peer, BroadcastChannel tabs) — ephemeral session-share, no durable marker store to purge.
- **Cross-vault / fleet purge** — klum's concern.
- **Purging live records / forget-tombstones / history on targets** — markers only; the rest stays as audit/data evidence.
