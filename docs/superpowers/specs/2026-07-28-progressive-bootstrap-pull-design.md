# Progressive bootstrap pull — design

**Issue:** #809 · **Milestone:** 37 (Sync bootstrap modes [api]) · **Date:** 2026-07-28

Composes with #807 (period-scoped pull, shipped) and #808 (blob pinning, shipped). First consumer
is the LINE/LIFF client portal (milestone 36), but the capability is portal-independent.

---

## The gap

`pull()` is async and local-first reads work throughout, so nothing technically blocks. Two things
are missing anyway:

- **No readiness signal.** A UI cannot tell that collection X is complete, Y is mid-pull, and Z has
  not started.
- **A miss is ambiguous during bootstrap.** `get()` returns `null` both for "no such record" and
  "not pulled yet", so an app must either show false empty states or wait for the whole pull. That
  wait is the *effective* blocking a thin client suffers.

## What already exists

#807 built more of this than the issue assumes. `pull()` already runs a **two-phase sequence** —
the `_periods` navigation index and companions first (exempt from every filter), then records — and
already reports per-phase KPI counters:

```ts
readonly phases?: {
  readonly summaries: { readonly records: number; readonly bytes: number }
  readonly records:   { readonly records: number; readonly bytes: number }
}
```

`PullOptions` already carries `collections`, `periods` and `modifiedSince`.

So this design **generalises a fixed pair into an ordered list** and adds a readiness tracker beside
it. It does not invent a phasing mechanism.

There is no readiness precedent anywhere in the codebase; `'cold' | 'pulling' | 'live'` is new
vocabulary.

---

## API surface

Three additions, plus one reshape of an existing field. `pull()`'s contract, `get()`'s signature and
today's default behaviour are all unchanged.

### 1. The plan

```ts
interface PullOptions {
  /**
   * Ordered bootstrap phases. Each phase is a subset of the filters `pull()`
   * already understands, so the plan needs no parallel vocabulary. Omit for
   * today's one-shot behaviour, which stays the default.
   */
  progressive?: ReadonlyArray<
    Pick<PullOptions, 'collections' | 'periods' | 'modifiedSince'>
  >
}
```

Typical portal plan:

```ts
await db.pull('acme', {
  progressive: [
    { periods: { current: true }, collections: ['invoices', 'clients'] },
    { periods: ['2026-Q1', '2025-Q4'] },
  ],
})
```

`_periods` summaries, reserved lookup collections and tombstones remain exempt from filtering, per
#807 — the navigation index is still pulled first, before phase 1.

**`progressive` is mutually exclusive with the top-level `collections` / `periods` / `modifiedSince`
filters.** Passing both throws `ValidationError` at plan validation. Silently intersecting a
top-level filter with each phase would make the plan's meaning depend on something outside it, and
silently ignoring the top-level filter would be worse. Every scope a progressive pull applies lives
in its phases.

### 2. The state

```ts
type ReadinessState = 'cold' | 'pulling' | 'live'

// on Collection
readonly readiness: ReadinessState
```

Per collection. Not per period — see *Rejected alternatives*.

### 3. The signal

```ts
// NoydbEventMap
'sync:readiness': {
  vault: string
  collection: string
  state: ReadinessState
  phase: number        // 1-based index of the phase that caused this
  phasesTotal: number
}
```

Follows the pattern every other sync signal already uses (`sync:pull`, `sync:online`, …), so
framework bindings hook it exactly as they hook those.

### 4. Widened result

`PullResult.phases` becomes an **array**, one entry per phase that ran, each keeping #807's
`{records, bytes}` counters so the 4G-budget KPI continues to work. Every entry is **named**, which
removes any question about what an index means:

```ts
readonly phases?: ReadonlyArray<{
  /** `'summaries'` = the #807 navigation index. `'phase-N'` = 1-based progressive phase. */
  readonly name: 'summaries' | `phase-${number}`
  readonly records: number
  readonly bytes: number
}>
```

`'summaries'` appears first whenever the navigation index runs, and is absent when it does not, so
a consumer must read `name` rather than assume a position.

> **This is a breaking change to `PullResult.phases`**, which #807 shipped as
> `{ summaries, records }`. Reshaping it is the only way to express N phases without a second field
> that means the same thing. It is an opt-in KPI field on a pre-1.0 line, and the migration is
> mechanical: `phases.summaries` → `phases.find(p => p.name === 'summaries')`, and the old
> `phases.records` → the sum of the non-summaries entries.

---

## Semantics

These are the rules that make the feature honest. Each exists for a stated reason.

**Default is `'live'`, not `'cold'`.**
A collection reads `'live'` until a progressive plan naming it begins. Apps not using progressive
mode must never see a UI stick on skeletons, and `'live'` is precisely today's meaning: *no
bootstrap in flight, trust your reads.*

**The flip to `'cold'` is synchronous.**
`pull()` marks every collection named in the plan `'cold'` **before any I/O**, so an app cannot
observe a stale `'live'` between calling `pull()` and the first phase starting.

**`'live'` requires every naming phase to complete — not the first.**
A collection named in phases 1 and 3 stays `'pulling'` until phase 3 finishes. Reaching `'live'` is
a claim that a miss is a real absence, so it must not be made early.

**A phase with no `collections` filter names every collection the vault currently knows** — those
with a declared schema or existing local records, the same set an unfiltered `pull()` touches.
Consequence worth knowing: such a phase makes everything wait for it. A collection that first
appears *during* the pull is not retroactively added to an earlier phase's name set.

**`'pulling'` is only ever a live state.**
On error or abort it resets to `'cold'`, never sticks. A stuck `'pulling'` would leave a permanent
skeleton — the worst available outcome.

**`get()` is untouched.**
It returns `T | null` as it always has. The app consults collection readiness to interpret a miss:

```ts
const inv = await invoices.get('inv-1')
if (inv === null && invoices.readiness !== 'live') showSkeleton()
else if (inv === null)                             showNotFound()
```

This keeps the kernel's hottest path unchanged and costs nothing per read.

---

## Data flow

```
pull({ progressive: [P1, P2, P3] })
  │
  ├─ validate plan                       throws BEFORE any I/O
  ├─ mark all named collections 'cold'   synchronous, emits, BEFORE any I/O
  ├─ pull navigation index               (#807, unchanged)
  │
  ├─ P1 ─ mark P1's collections 'pulling'  (emit)
  │        run the existing pull path with P1's filters
  │        append { name: 'phase-1', records, bytes } to phases
  │        collections whose LAST naming phase was P1 → 'live'  (emit)
  ├─ P2 ─ …
  ├─ P3 ─ …
  │
  └─ resolve PullResult { pulled, conflicts, errors, erasures, phases[] }
```

Each phase reuses the existing pull path verbatim. `progressive` is a loop around what already
works, not a second implementation.

**Completion:** the promise resolves when **all** phases finish, so `await pull()` keeps meaning
"fully synced". Non-blocking UX comes from *not* awaiting it — fire the pull and render off
`sync:readiness`.

---

## Failure

**Plan validation throws before any I/O**, matching #807's existing rule (*"throws without leaving a
batch dangling"*). No readiness mutation, no records applied.

**Per-record errors accumulate in `PullResult.errors`** and do not abort — today's behaviour,
unchanged.

**A phase that accumulated errors leaves its collections `'cold'`.**
This is the load-bearing failure rule. `'live'` claims a miss is a real absence; if anything in that
phase failed we cannot claim it. That phase's `phases` entry still reports what *did* land, so the
KPI stays truthful.

**Later phases still run.** Their scopes are independent, and a failed backfill should not block an
unrelated phase.

**Interruption needs no special handling.** Readiness is in-memory, so a restart returns every
collection to the default and re-running the plan is cheap — pull is already idempotent, and
`modifiedSince` makes completed phases near-free.

---

## Testing

| Area | Assertion |
|---|---|
| ordering | phases run in declared order; phase *n+1* never starts before *n* resolves |
| transitions | `live → cold` (synchronous, pre-I/O) `→ pulling → live` |
| event payload | `phase` / `phasesTotal` correct on every emission |
| multi-phase collection | stays `'pulling'` until its **last** naming phase completes |
| unfiltered phase | names every collection |
| **failure** | a phase with errors leaves its collections `'cold'` — explicitly not stuck `'pulling'` |
| **validation** | an invalid plan throws with no readiness mutation and no records applied |
| **no regression** | a non-progressive `pull()` leaves readiness `'live'` throughout |
| push | unaffected by `progressive` |
| KPI | each `phases` entry's `records` matches envelopes actually applied, and `name` identifies it |
| resume | after a simulated restart, re-running the plan is idempotent |

The **failure** and **no-regression** rows are the two to write first — they are the ones that would
silently ruin the feature.

---

## Out of scope

- **Blobs.** #808 owns their lifecycle; they stay on-demand by construction.
- **Push.** The dirty queue is never phased or filtered.
- **Per-record priorities** beyond phase granularity.
- **Framework bindings.** At least one `in-*` example belongs in a follow-up, once the event exists.
- **Docs.** The thin-client bootstrap section and the showcase step (noy-db-docs#120) follow the
  implementation.

---

## Rejected alternatives

**A tri-state or wrapper return from `get()`.** Most honest — impossible to forget — but it makes
the return type mode-dependent, splits every call site, and puts a cost on the kernel's hottest
path. Collection-level readiness answers the question UIs actually ask ("is this list still
loading?"), which is per-collection, not per-record.

**A separate `getState(id)` method.** Precise, but a second read API that must stay aligned with the
first, for a question that is not genuinely per-record.

**Per collection×period readiness.** Would let the portal render the current quarter while older
periods stream in — the real UX goal. Rejected for v1 because it turns "is `invoices` ready?" into
"ready for *which* period?", requiring a compound key and compound events. Revisit if the
render-during-backfill case proves to matter in practice; the phase index on `sync:readiness` gives
a partial answer meanwhile.

**Persisting readiness to a device-local reserved collection.** Would render instantly after a
restart, but mints persisted state that can disagree with the store (e.g. after a manual purge) and
requires the never-sync guarantee to be enforced rather than documented.

**Deriving readiness from "does the collection have records?"** No new state and survives restart,
but a partially-pulled collection would read as `'live'` — reintroducing the false-confidence
problem this feature exists to remove.

**A separate `pullProgressive()` method.** A second sync entry point duplicating `PullOptions`'
vocabulary, which would then have to track it as it evolves.

**Resolving after phase 1 with the rest in background.** Gives time-to-first-interaction as an
awaited value, but changes what `await pull()` means in progressive mode, leaves work running after
the promise settles, and leaves later-phase errors with no home.

**A named bootstrap mode on `withSync()`.** Zero configuration, but the right phases are genuinely
app-specific — the hub should not decide what an app's navigation index is.
