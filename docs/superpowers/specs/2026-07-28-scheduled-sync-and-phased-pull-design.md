# Scheduled sync and phased pull — design

**Issues:** #809 (progressive bootstrap), #618 (role-gate auto-sync) · **Milestone:** 37 (Sync
bootstrap modes [api]) · **Date:** 2026-07-28

Composes with #807 (period-scoped pull, shipped) and #808 (blob pinning, shipped). First consumer is
the LINE/LIFF client portal (milestone 36); the capability is portal-independent.

---

## Summary

Progressive bootstrap is not a new mechanism — it is **a sync policy**. The scheduler that should
run it already exists, the store-shaped policy presets already exist, and `pull()` already accepts
the filters a phase needs. What is missing is that **the scheduler is never started**, it would be
**unsafe if it were**, it cannot express **an ordered sequence**, and its **status never reaches the
app**.

Four gaps, one capability: *a scheduler that runs, is safe, can be sequenced, and reports progress.*

Each stage below is independently shippable and independently useful.

---

## What exists today

| Piece | State |
|---|---|
| `db.pull(vault, { collections, periods, modifiedSince })` | ✅ works — #807 |
| `db.push(vault, { collections })` | ✅ works |
| `db.sync(vault)` = pull then push | ✅ works — `sync.ts:664` |
| `createNoydb({ syncPolicy })` with store-shaped presets | ✅ `INDEXED_STORE_POLICY`, `POD_STORE_POLICY` |
| `SyncScheduler` with push/pull callbacks and timers | ✅ built — `kernel/sync-policy.ts` |
| Constructed when a non-manual policy is passed | ✅ `sync.ts:152` |
| `notifyChange()` fired on every write | ✅ `sync.ts:236` |
| **`startScheduler()`** — *"Called after vault is fully opened"* | ❌ **zero callers** |
| **`startAutoSync()`** — online/offline + interval | ❌ **zero callers** |
| Pull sequencing (ordered collection/period phases) | ❌ absent |
| Per-collection readiness | ❌ absent |
| `SyncSchedulerStatus` reachable from an app | ❌ **no accessor** |

`db.syncStatus(vault)` returns a *different, thinner* type — `{ dirty, lastPush, lastPull, online }`.
The scheduler's richer status is documented as *"safe to expose in a reactive UI status indicator"*
and is unreachable.

**Every pull today is an explicit app call.** `createNoydb()` and `openVault()` never pull.

---

## The governing constraint

**The kernel must not grow for a feature most consumers will never enable.** `collection.ts` sits at
4263 lines against a 4264 ceiling.

This design satisfies it by construction:

- Policy **types** live in `kernel/sync-policy.ts` and **erase at runtime**.
- The policy **constants** are plain objects (`noydb.ts:73` imports `INDEXED_STORE_POLICY`) — bytes.
- `SyncScheduler` is **verified absent from the floor entry chunk**: building `createNoydb` alone
  yields 1578 bytes with no `SyncScheduler` reference. It ships only when sync is used.
- No change to `Collection`, `Vault`, or `Noydb`'s hot paths.

A new bundle-gate assertion locks this in rather than assuming it.

---

## Stage 1 — start the scheduler

**Problem.** `startScheduler()` exists, is constructed when a policy is passed, has its pull/push
callbacks wired, and receives `notifyChange()` on every write — but nothing ever starts it. An app
that passes `syncPolicy` today gets a scheduler that silently never runs.

**Change.** The engine's owner starts it. Sync engines are created and held by **`Noydb`**, not
`Vault` — `noydb.ts:568` sets the primary engine and `:585` the additional targets, keyed
`vault` and `vault::label`. So:

- **start** — immediately after `this.syncEngines.set(...)` at `noydb.ts:568` and `:585`, once the
  engine's policy is known. This is the moment the method's own JSDoc describes
  (*"Called after vault is fully opened"*).
- **stop** — in `Noydb.close()` (`noydb.ts:1624`), alongside the existing teardown of
  `policyEnforcers` and `sessionTimer`, which already cancel timers and listeners there.

Both additions are inside `noydb.ts`, whose kernel-surface budget is **2161** — check the ratchet
before committing, and shrink first if the additions exceed it rather than bumping.

**Not changed.** `startAutoSync(intervalMs)` stays app-called. It is a coarser, older API — global
`online`/`offline` listeners plus a bare interval — that overlaps the policy model. Wiring both
would give two competing timers. It is left as an explicit opt-in and marked as such.

**Default behaviour is unchanged.** `INDEXED_STORE_POLICY` is `pull: { mode: 'manual' }`, and the
scheduler is only constructed when `push.mode !== 'manual'`. Apps that pass no policy are unaffected.

---

## Stage 2 — role-gate it (#618)

**Problem.** #618 is not the wiring; it is the safety belt that must land *with* it. Once the
scheduler runs, its pull callback (`() => this.pull()`) bypasses the Noydb-level gate that #616
added, because that gate lives at the orchestration layer while the scheduler calls the engine
directly.

**Failure scenario, verbatim from #618:** *"a backup/archive-only primary with an
`interval`/`on-focus` pull policy would pull ungated, silently reintroducing #616."*

**Change.** A role guard in the engine's scheduler-initiated pull path:

```ts
pull: () => (this.role === 'sync-peer' ? this.pull().then(() => {}) : Promise.resolve()),
```

This is the engine self-initiating sync on a timer, so role-gating it does not violate the rule that
*an explicit `engine.pull()` still pulls* — #618 says exactly this.

**This stage must not ship separately from Stage 1.** Alone it guards nothing; after Stage 1 without
it, a backup target silently pulls.

---

## Stage 3 — a phased pull policy (#809)

**Problem.** `PullPolicy` can say *when* to pull, never *in what order*. A thin client wants its
navigation index and current period first, bulk history last.

**Change.** One new mode and one new field:

```ts
export type PullMode = 'manual' | 'interval' | 'on-focus' | 'phased'

/** One phase: a collection, optionally narrowed to periods. */
export type PullScope =
  | string                                    // 'invoices' — every period
  | {
      readonly collection: string
      /** Same shape as `PullOptions.periods` — no new vocabulary. */
      readonly periods: PullOptions['periods']
    }

export interface PullPolicy {
  readonly mode: PullMode
  readonly intervalMs?: number
  /** Required when `mode: 'phased'`, rejected otherwise. Pulled in order. */
  readonly sequence?: readonly PullScope[]
}
```

Usage — the policy *is* the plan:

```ts
const db = await createNoydb({
  store: toBrowserIdb(),
  sync:  toAwsS3({ bucket, client }),
  user, secret,
  syncStrategy:    withSync(),
  periodsStrategy: withPeriods(),
  syncPolicy: {
    push: { mode: 'on-change', minIntervalMs: 0, onUnload: true },
    pull: {
      mode: 'phased',
      sequence: [
        { collection: 'invoices', periods: { current: true } },
        { collection: 'clients',  periods: { current: true } },
        { collection: 'invoices', periods: ['2026-Q1', '2025-Q4'] },
      ],
    },
  },
})
```

**Execution.** On start, the scheduler walks the sequence in order, calling the existing
`pull({ collections: [scope.collection], periods: scope.periods })` once per entry. Each entry is an
ordinary pull; phasing is sequencing, not new pull capability.

**After the sequence completes**, the scheduler settles into steady state — `intervalMs` if given,
otherwise idle until `notifyChange()`. Bootstrap and steady-state are one flow, not two APIs.

**Sequential by construction.** Running phases in parallel would defeat prioritisation, which is the
entire point.

**Validation** happens where the policy is accepted, at `createNoydb` — `sequence` non-empty and
present iff `mode === 'phased'`, every entry naming a non-empty collection. An invalid policy throws
before any I/O.

**Push is not sequenced.** *"Push is never period-filtered"* is an existing documented law, and the
dirty queue is not reorderable — you push what changed. `PushOptions` keeps `collections` only.

---

## Stage 4 — readiness in the status surface (#809)

**Problem.** A UI cannot tell whether a collection is complete, mid-pull, or untouched — so a `null`
from `get()` is ambiguous during bootstrap, and apps must either show false empty states or block.

**Change.** Extend the status the scheduler already publishes, and give it a public accessor.

```ts
export type ReadinessState = 'cold' | 'pulling' | 'live'

export interface SyncSchedulerStatus {
  readonly state: SyncSchedulerState
  readonly lastPushAt: string | null
  readonly lastPullAt: string | null
  readonly lastError: Error | null
  readonly pendingWrites: number
  /** Per collection. Empty unless `pull.mode === 'phased'`. */
  readonly readiness: ReadonlyMap<string, ReadinessState>
  /** 1-based position in the sequence, or `null` outside a phased run. */
  readonly phase: { readonly index: number; readonly total: number } | null
}

// on Noydb — the accessor that does not exist today
schedulerStatus(vault: string): SyncSchedulerStatus | null
```

Reactive UIs already receive `sync:pull` on each phase completion, so no new event is required; a
listener reads `schedulerStatus()` when it fires.

**Interpreting a miss:**

```ts
const inv = await invoices.get('inv-1')
const { readiness } = db.schedulerStatus('acme')!
if (inv === null && readiness.get('invoices') !== 'live') showSkeleton()
else if (inv === null)                                    showNotFound()
```

`get()` is untouched — no per-read cost, no mode-dependent return type.

### Readiness rules

**Default `'cold'`** for every collection the sequence names, from scheduler start.

**A collection the sequence never names is absent from the map**, and a caller reading `undefined`
must treat it as *"no claim made"* — never as a reason to gate a UI. Documented on the field.

**`'live'` requires every entry naming a collection to complete** — not the first. A collection at
positions 1 and 3 stays `'pulling'` until 3 finishes. `'live'` asserts a miss is a real absence, so
it must not be claimed early.

**`'pulling'` is never terminal.** On error it returns to `'cold'`. A stuck `'pulling'` leaves a
permanent skeleton — the worst available outcome.

**A phase whose pull reported errors leaves its collection `'cold'`.** `PullResult.errors`
accumulates without throwing; if anything failed we cannot claim completeness.

**State is in-memory**, dying with the scheduler. A restart re-runs the sequence, which is cheap —
`pull()` is idempotent and `modifiedSince` makes settled phases near-free. Nothing is persisted, so
nothing can disagree with the store or leak across devices.

---

## Failure

| Situation | Behaviour |
|---|---|
| Invalid policy | throws at `createNoydb`, before any I/O |
| A phase's `pull()` reports errors | recorded; that collection stays `'cold'`; **later phases still run** |
| A phase's `pull()` throws | scheduler enters `'error'` with `lastError`; no collection left `'pulling'` |
| Backup/archive role | scheduler-initiated pulls are skipped (Stage 2); explicit `db.pull()` still works |
| Vault closed mid-sequence | `stopScheduler()`; in-memory state discarded |
| No `withSync()` | unchanged — `pull()` throws its existing actionable error |

---

## Testing

**Stage 1** — scheduler starts on vault open when a non-manual policy is passed; does not start
without one; stops on close; a `pull: manual` policy never auto-pulls.

**Stage 2** — a `backup`-role engine does **not** pull on a scheduler tick; a `sync-peer` does; an
explicit `engine.pull()` still pulls for both. This is the #616 regression test at the engine level.

**Stage 3** — phases execute in declared order, phase *n+1* never starting before *n* resolves; each
phase calls `pull()` with exactly that scope's collection and periods; the sequence runs once, then
steady state; `sequence` with a non-`phased` mode is rejected; `phased` without `sequence` is
rejected.

**Stage 4** — transitions `cold → pulling → live`; a collection at two positions stays `'pulling'`
until the last; an unnamed collection is absent from the map; a phase with errors leaves its
collection `'cold'`, explicitly not stuck `'pulling'`; a throwing pull leaves nothing `'pulling'`;
`schedulerStatus()` returns `null` when no scheduler exists.

**Cross-cutting** — a bundle-gate scenario asserting `SyncScheduler` stays out of the floor entry
chunk, so the kernel-cost claim is enforced rather than asserted.

The **role-gate**, **errors-leave-it-cold** and **floor-bundle** tests are the ones to write first:
each guards a property whose loss is silent.

---

## Out of scope

- **Blobs** — #808 owns their lifecycle; on-demand by construction.
- **Push sequencing** — the dirty queue is not reorderable, and period-filtered push is a documented
  non-goal.
- **Per-record priorities** beyond collection+period granularity.
- **`'invoices@2026-Q1'` string shorthand** for `PullScope`. Deferred: the object form carries the
  same information with no parsing ambiguity, and `@` has no precedent as a separator in this
  codebase. Add later as sugar if the ergonomics justify it.
- **Framework bindings** — an `in-*` example follows once the status surface exists.
- **Docs** — thin-client bootstrap section and the showcase step (noy-db-docs#120) follow.

---

## Rejected alternatives

**A standalone orchestrator subpath (`@noy-db/hub/bootstrap`, `progressiveBootstrap()`)** — the
previous draft of this spec. It worked and cost zero kernel lines, but it put pull sequencing in a
second place: apps would configure cadence via `syncPolicy` and sequencing via a separate handle,
with no relationship between them. Sequencing *is* a scheduling concern, so it belongs in the policy
that already schedules. It also could not hand off to steady-state sync, leaving bootstrap and
ongoing sync as two disconnected APIs.

**Readiness on `Collection`, `progressive` on `PullOptions`** — the first draft. Grew the kernel for
a feature most consumers never enable, in a file with one line of ceiling headroom, and forced a
breaking reshape of `PullResult.phases` plus a `'live'`-by-default rule invented only to stop
non-adopters' UIs freezing. Recorded because the pull toward *"it's only a getter"* is exactly what
the ceiling exists to resist.

**A tri-state or wrapper return from `get()`.** Impossible to forget, but makes the return type
mode-dependent, splits every call site, and puts cost on the kernel's hottest path.

**Per collection×period readiness.** Would let the portal render the current quarter while older
periods stream in — the real UX goal. Deferred: it turns *"is `invoices` ready?"* into *"ready for
which period?"*, needing a compound key. `phase.index` gives a partial answer meanwhile.

**Persisting readiness.** Instant render after restart, but mints state that can disagree with the
store and needs a never-sync guarantee enforced rather than documented.

**Deriving readiness from "does the collection have records?"** Survives restart with no new state,
but a partially-pulled collection reads `'live'` — reintroducing the false-confidence problem this
exists to remove.

**Wiring `startAutoSync()` alongside the scheduler.** Two competing timers for one job. It stays an
explicit opt-in.
