# Scheduled sync and phased pull — design

**Issues:** #809 (progressive bootstrap), #618 (role-gate auto-sync — **shipped**) · **Milestone:** 37
(Sync bootstrap modes [api]) · **Date:** 2026-07-28

Composes with #807 (period-scoped pull, shipped) and #808 (blob pinning, shipped). First consumer is
the LINE/LIFF client portal (milestone 36); the capability is portal-independent.

---

## Summary

Progressive bootstrap is not a new mechanism — it is **a sync policy**. The scheduler that runs it
already exists, the store-shaped policy presets already exist, and `pull()` already accepts the
filters a phase needs.

The original draft named four gaps. **Two are now closed** (PR #898): the scheduler was never
started, and it would have been unsafe if it were. Two remain: the policy cannot express **an
ordered sequence**, and its **status never reaches the app**.

Two stages, each independently shippable and independently useful.

---

## What exists today

| Piece | State |
|---|---|
| `db.pull(vault, { collections, periods, modifiedSince })` | ✅ works — #807 |
| `db.push(vault, { collections })` | ✅ works |
| `db.sync(vault)` = pull then push | ✅ works |
| `createNoydb({ syncPolicy })` with store-shaped presets | ✅ `INDEXED_STORE_POLICY`, `POD_STORE_POLICY` |
| `SyncScheduler` with push/pull callbacks and timers | ✅ `kernel/sync-policy.ts` |
| **Scheduler started on vault open, stopped on close** | ✅ **#897 — PR #898** |
| **Scheduler-initiated pull role-gated to `sync-peer`** | ✅ **#618 — PR #898** |
| Pull sequencing (ordered collection phases) | ❌ absent — Stage 1 below |
| Per-collection readiness | ❌ absent — Stage 2 below |
| `SyncSchedulerStatus` reachable from an app | ❌ **no accessor** — Stage 2 below |

`db.syncStatus(vault)` returns a *different, thinner* type — `{ dirty, lastPush, lastPull, online }`.
The scheduler's richer status is documented as *"safe to expose in a reactive UI status indicator"*
and is still unreachable.

**Every pull is still an explicit app call unless a policy asks otherwise.** `createNoydb()` and
`openVault()` never pull on their own.

---

## Already shipped (was Stages 1–2)

Recorded here because the decision taken while shipping them constrains everything below.

`startScheduler()` had **zero callers**, and `SyncScheduler.notifyChange()` opens with
`if (!this.started) return` — so **no automatic sync existed at any policy**. A declared
`syncPolicy` was silently inert. `Noydb` now starts each engine's scheduler after
`this.syncEngines.set(...)`, stops every scheduler in `close()`, builds one when **either** push or
pull is non-manual, and role-gates the scheduler-initiated pull to `sync-peer` (#618 — otherwise a
backup/archive target with an `interval` pull policy pulls ungated and reintroduces #616).

### The decision: automation starts on a *declared* policy, never a resolved one

A policy is **always resolved** — `noydb.ts` falls back to the store preset, and
`INDEXED_STORE_POLICY` is `push: 'on-change'`. Starting the scheduler on that resolved value was
tried first and the existing suite rejected it: **36 failures across 11 sync test files**, including
a conflict-resolution *outcome* flip, because `push: 'on-change'` fires `void executePush()`
**unawaited** — a caller that writes locally and then touches the remote directly races it.

So resolving a policy is not consent. Passing `sync:` alone still never syncs by itself; declaring a
policy is the opt-in. The escape hatch for anyone who declared a policy expecting it to stay inert:

```ts
syncPolicy: { push: { mode: 'manual' }, pull: { mode: 'manual' } }
```

**This is load-bearing for Stage 1.** `mode: 'phased'` is by definition declared, so a phased policy
starts without any further wiring — and nobody who did not ask for phasing can be given it by a
default.

---

## The governing constraint

**The kernel must not grow for a feature most consumers will never enable.** `collection.ts` sits at
**4263** lines against a **4264** ceiling; `noydb.ts` at **2158** against **2161**.

This design satisfies it by construction:

- Policy **types** live in `kernel/sync-policy.ts` and **erase at runtime**.
- The policy **constants** are plain objects — bytes.
- `SyncScheduler` is **verified absent from the floor entry chunk**: building `createNoydb` alone
  yields 1578 bytes with no `SyncScheduler` reference. It ships only when sync is used.
- No change to `Collection`, `Vault`, or `Noydb`'s hot paths. Stage 2's accessor is the only new
  `Noydb` member, and it is a one-line delegation.

A new bundle-gate assertion locks this in rather than assuming it.

---

## Granularity: db, vault, collection

Deliberately **three levels, not four**. `collection@period` phasing is **deferred to a future
`partitions` context** — see *Rejected alternatives*.

| Level | Where it is expressed |
|---|---|
| **db** | `createNoydb({ syncPolicy })` — governs every vault the instance opens |
| **vault** | a per-target `policy` on a `withSync({ sync: [...] })` entry |
| **collection** | the ordered `sequence` introduced in Stage 1 |

A sync engine is per-vault, so a `sequence` runs **once per engine**, naming collections within that
engine's vault. A db-level policy therefore replays the same collection order in each vault it
governs, which is the intended behaviour: the ordering expresses *which collections the app needs
first*, and that is a property of the app, not of the tenant.

---

## Stage 1 — a phased pull policy (#809)

**Problem.** `PullPolicy` can say *when* to pull, never *in what order*. A thin client wants its
navigation-critical collections first and bulk history last.

**Change.** One new mode and one new field:

```ts
export type PullMode = 'manual' | 'interval' | 'on-focus' | 'phased'

export interface PullPolicy {
  readonly mode: PullMode
  readonly intervalMs?: number
  /**
   * Required when `mode: 'phased'`, rejected otherwise. Collections are pulled
   * in this order, one at a time. Entries must be unique and non-empty.
   */
  readonly sequence?: readonly string[]
}
```

Usage — the policy *is* the plan:

```ts
const db = await createNoydb({
  store: toBrowserIdb(),
  sync:  toAwsS3({ bucket, client }),
  user, secret,
  syncStrategy: withSync(),
  syncPolicy: {
    push: { mode: 'on-change', minIntervalMs: 0, onUnload: true },
    pull: { mode: 'phased', sequence: ['clients', 'invoices', 'attachments'] },
  },
})
```

**Execution.** On start, the scheduler walks the sequence in order, calling the existing
`pull({ collections: [name] })` once per entry. Each entry is an ordinary pull; phasing is
sequencing, not new pull capability.

**After the sequence completes**, the scheduler settles into steady state — `intervalMs` if given,
otherwise idle until `notifyChange()`. Bootstrap and steady state are one flow, not two APIs.

**Sequential by construction.** Running phases in parallel would defeat prioritisation, which is the
entire point.

**Validation** happens where the policy is accepted, at `createNoydb`: `sequence` present iff
`mode === 'phased'`, non-empty, every entry a non-empty string, **no duplicates**. An invalid policy
throws before any I/O. Duplicates are rejected rather than merged because without period narrowing a
repeated collection can only be a mistake — and rejecting it keeps Stage 2's readiness rules a
simple one-entry-per-collection mapping.

**Push is not sequenced.** *"Push is never period-filtered"* is an existing documented law, and the
dirty queue is not reorderable — you push what changed. `PushOptions` keeps `collections` only.

---

## Stage 2 — readiness in the status surface (#809)

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

**`'live'` means that collection's phase completed cleanly.** Sequence entries are unique
(Stage 1), so this is one transition per collection with no "wait for a later repeat" rule to get
wrong. `'live'` asserts a miss is a real absence, so it must not be claimed early.

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
| Backup/archive role | scheduler-initiated pulls are skipped (shipped); explicit `db.pull()` still works |
| Vault closed mid-sequence | `stopScheduler()`; in-memory state discarded |
| No `withSync()` | unchanged — `pull()` throws its existing actionable error |

---

## Testing

**Stage 1** — phases execute in declared order, phase *n+1* never starting before *n* resolves; each
phase calls `pull()` with exactly that collection; the sequence runs once, then steady state;
`sequence` with a non-`phased` mode is rejected; `phased` without `sequence` is rejected; a
duplicate entry is rejected; an empty `sequence` is rejected.

**Stage 2** — transitions `cold → pulling → live`; an unnamed collection is absent from the map; a
phase with errors leaves its collection `'cold'`, explicitly not stuck `'pulling'`; a throwing pull
leaves nothing `'pulling'`; `schedulerStatus()` returns `null` when no scheduler exists.

**Cross-cutting** — a bundle-gate scenario asserting `SyncScheduler` stays out of the floor entry
chunk, so the kernel-cost claim is enforced rather than asserted.

The **errors-leave-it-cold** and **floor-bundle** tests are the ones to write first: each guards a
property whose loss is silent. (The **role-gate** test of that trio already landed with PR #898.)

---

## Out of scope

- **Period-scoped phases** — deferred to `partitions`; see below.
- **Blobs** — #808 owns their lifecycle; on-demand by construction.
- **Push sequencing** — the dirty queue is not reorderable, and period-filtered push is a documented
  non-goal.
- **Per-record priorities** beyond collection granularity.
- **Framework bindings** — an `in-*` example follows once the status surface exists.
- **Docs** — thin-client bootstrap section and the showcase step (noy-db-docs#120) follow.

---

## Rejected alternatives

**Period-scoped phases (`collection@period`) — deferred, not rejected.** The earlier draft gave
`PullScope` an object form carrying `periods`, so a phase could be *"invoices, current quarter"* and
readiness could be per collection×period. That is the real portal UX goal: render the current
quarter while older periods stream in. It is **deferred to a future `partitions` context**, which
will decide the vocabulary once rather than minting a phasing-only dialect here. Deferring it also
removes the compound-key question from readiness (*"ready for which period?"*) and the
`'invoices@2026-Q1'` string-shorthand question, where `@` has no precedent as a separator in this
codebase. `phase.index` gives a partial progress answer meanwhile, and `db.pull(vault, { periods })`
remains available explicitly.

**Starting the scheduler from the resolved default policy.** Shipped-and-reverted during PR #898 —
36 test failures including a conflict-resolution outcome change, because `on-change` push is
unawaited and races direct remote access. Recorded because *"a default already exists, so acting on
it is free"* is a specifically attractive mistake here.

**A standalone orchestrator subpath (`@noy-db/hub/bootstrap`, `progressiveBootstrap()`).** Worked
and cost zero kernel lines, but put pull sequencing in a second place: apps would configure cadence
via `syncPolicy` and sequencing via a separate handle, with no relationship between them. Sequencing
*is* a scheduling concern, so it belongs in the policy that already schedules. It also could not
hand off to steady-state sync, leaving bootstrap and ongoing sync as two disconnected APIs.

**Readiness on `Collection`, `progressive` on `PullOptions`.** The first draft. Grew the kernel for
a feature most consumers never enable, in a file with one line of ceiling headroom, and forced a
breaking reshape of `PullResult.phases` plus a `'live'`-by-default rule invented only to stop
non-adopters' UIs freezing. Recorded because the pull toward *"it's only a getter"* is exactly what
the ceiling exists to resist.

**A tri-state or wrapper return from `get()`.** Impossible to forget, but makes the return type
mode-dependent, splits every call site, and puts cost on the kernel's hottest path.

**Persisting readiness.** Instant render after restart, but mints state that can disagree with the
store and needs a never-sync guarantee enforced rather than documented.

**Deriving readiness from "does the collection have records?"** Survives restart with no new state,
but a partially-pulled collection reads `'live'` — reintroducing the false-confidence problem this
exists to remove.

**Wiring `startAutoSync()` alongside the scheduler.** Two competing timers for one job. It stays an
explicit opt-in; it is a coarser, older API (global `online`/`offline` listeners plus a bare
interval) that overlaps the policy model.
