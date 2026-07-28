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

## The governing constraint

**The kernel must not grow for a feature most consumers will never enable.**

This is not a preference. `collection.ts` sits at 4263 lines against a 4264 ceiling — one line of
headroom — and the architecture is minimalist core plus opt-in services. A `Collection.readiness`
getter would make every consumer pay for progressive bootstrap whether or not they use it.

Design target: **zero kernel changes**, and nothing bundled unless the feature is imported.

## What makes that achievable

Everything a progressive bootstrap needs is **already public**:

| Need | Existing public API |
|---|---|
| run one phase | `db.pull(vault, { collections, periods, modifiedSince })` |
| know what a phase pulled | `PullResult` → `pulled`, `errors`, `conflicts`, `phases` |
| enumerate collections | `vault.collections()` — see the caveat under *Semantics* |

And #807 already made `pull()` phase-aware internally — the `_periods` navigation index and
companions are pulled first, exempt from every filter, before any record filtering.

**A phase is therefore just a `pull()` call with different filters.** The feature is orchestration,
not new kernel capability.

---

## Shape

A pure orchestrator published at `@noy-db/hub/bootstrap`. It imports only public API, holds its
state in a closure, and emits on its own emitter.

```ts
import { progressiveBootstrap } from '@noy-db/hub/bootstrap'

const boot = progressiveBootstrap(db, 'acme', [
  { periods: { current: true }, collections: ['invoices', 'clients'] },
  { periods: ['2026-Q1', '2025-Q4'] },
])

boot.readiness('invoices')        // 'cold' | 'pulling' | 'live'
const stop = boot.subscribe(e => paint(e))

await boot.run()                  // resolves when every phase completes
boot.result                       // aggregated KPI, populated after run()
```

### The types

```ts
type ReadinessState = 'cold' | 'pulling' | 'live'

/** One phase: a subset of the filters `pull()` already understands. */
type BootstrapPhase = Pick<PullOptions, 'collections' | 'periods' | 'modifiedSince'>

interface ReadinessEvent {
  readonly collection: string
  readonly state: ReadinessState
  /** 1-based index of the phase that caused this transition. */
  readonly phase: number
  readonly phasesTotal: number
}

interface BootstrapPhaseResult {
  readonly phase: number
  readonly collections: readonly string[]
  readonly pulled: number
  readonly bytes: number
  readonly errors: readonly Error[]
}

interface BootstrapResult {
  readonly phases: readonly BootstrapPhaseResult[]
  readonly pulled: number
  readonly errors: readonly Error[]
}

interface ProgressiveBootstrap {
  /** State for one collection. `'live'` for any collection the plan never names. */
  readiness(collection: string): ReadinessState
  /** Snapshot of every collection the plan names. */
  readinessMap(): ReadonlyMap<string, ReadinessState>
  /** Collections this plan will pull, as far as they are known before `run()`. */
  readonly plannedCollections: readonly string[]
  /** Current state is delivered immediately on subscribe. Returns an unsubscribe. */
  subscribe(listener: (event: ReadinessEvent) => void): () => void
  /** Runs every phase in order. Resolves when all have completed. */
  run(): Promise<BootstrapResult>
  /** Populated after `run()` resolves; `null` before. */
  readonly result: BootstrapResult | null
}

export function progressiveBootstrap(
  db: Noydb,
  vault: string,
  phases: readonly BootstrapPhase[],
): ProgressiveBootstrap
```

`get()` is untouched. The app interprets a miss by asking the handle:

```ts
const inv = await invoices.get('inv-1')
if (inv === null && boot.readiness('invoices') !== 'live') showSkeleton()
else if (inv === null)                                     showNotFound()
```

---

## Semantics

**Default is `'cold'`.** A handle exists only because someone started a bootstrap, so `'cold'` is
honest from construction. The earlier kernel-coupled draft needed a `'live'` default to stop
non-adopters' UIs freezing — a footgun this shape removes, because there is no global state to get
wrong.

**A collection the plan never names reads `'live'`.** The plan makes no claim about it, so nothing
is pending and a UI must not gate on it. `plannedCollections` shows what the plan covers.

**`'live'` requires every phase naming a collection to complete — not the first.** A collection in
phases 1 and 3 stays `'pulling'` until phase 3 finishes. Reaching `'live'` asserts that a miss is a
real absence, so it must not be claimed early.

**A phase with no `collections` filter names every collection with local records at that moment**,
resolved via `vault.collections()` when the phase starts.

Be precise about what that does *not* include. `collections()` is `loadAll()` plus `Object.keys()`,
so it returns only collections that already hold **persisted local records** — a declared-but-empty
collection is absent, and on a genuinely cold first boot the list may be empty entirely. That makes
an unfiltered phase near-useless as the *first* phase of a bootstrap, which is exactly when a client
has nothing local yet.

Two consequences, both intentional:

- **Name collections explicitly in a bootstrap plan.** The orchestrator warns (does not throw) when
  a phase omits `collections`, because the resulting name set is whatever happened to be local.
- **An unfiltered phase still pulls everything** — `pull()` without a `collections` filter is
  unrestricted, and that is unchanged. Only the *readiness bookkeeping* is limited to names
  `collections()` could see, so a collection arriving in that phase transitions to `'live'` on the
  next phase boundary rather than immediately.

`vault.ts:3183` already works around the same limitation for introspection by unioning
`collectionCache.keys()` with `collections()`; that cache is private, so the orchestrator cannot
reuse it without new kernel surface — which this design exists to avoid.

**`'pulling'` is never terminal.** On error it returns to `'cold'`. A stuck `'pulling'` would leave
a permanent skeleton — the worst available outcome.

**`subscribe` delivers current state immediately**, so a component mounting mid-bootstrap renders
correctly without waiting for the next transition.

---

## Data flow

```
progressiveBootstrap(db, 'acme', [P1, P2, P3])
  │  validate plan            throws synchronously — non-empty, each phase a
  │                           valid filter subset, no unknown keys
  │  mark named collections 'cold'
  │
run()
  ├─ P1 ─ resolve P1's collection set (explicit list, or vault.collections())
  │        mark them 'pulling'                              (emit)
  │        await db.pull(vault, P1)                          ← existing API
  │        record BootstrapPhaseResult
  │        if no errors touched them: collections whose LAST
  │          naming phase was P1 → 'live'                    (emit)
  │        else: those collections → 'cold'                  (emit)
  ├─ P2 ─ …
  ├─ P3 ─ …
  └─ resolve BootstrapResult
```

**Completion:** `run()` resolves when all phases finish. Non-blocking UX comes from not awaiting it
— fire it and render off `subscribe`.

**Concurrency:** phases run sequentially. Running them in parallel would defeat prioritisation,
which is the entire point.

---

## Failure

**Plan validation throws synchronously at construction**, before `run()` exists to be called — an
invalid plan can never leave partial state.

**`db.pull()` errors surface in `PullResult.errors`** without throwing; the orchestrator copies them
into that phase's result and the aggregate.

**A phase with errors leaves its collections `'cold'`.** The load-bearing rule: `'live'` claims a
miss is a real absence, and if anything in that phase failed we cannot claim it. The phase result
still reports what *did* land, so the KPI stays truthful.

**Later phases still run** — their scopes are independent, and a failed backfill should not block an
unrelated phase.

**If `db.pull()` throws** (sync not enabled, invalid period option), `run()` rejects with that error
and every collection not already `'live'` returns to `'cold'`.

**Sync is required.** `pull()` throws without `syncStrategy: withSync()`. The orchestrator lets that
error propagate unchanged rather than rewrapping it — the hub's message already names the fix.

**Interruption needs no handling.** State lives in the handle, so a restart starts fresh; re-running
the plan is cheap because `pull()` is idempotent and `modifiedSince` makes completed phases
near-free.

---

## Packaging

New subpath `@noy-db/hub/bootstrap` → `src/with-party/bootstrap/index.ts`, wired through
`tsup.entries.mjs` and `package.json`'s `exports` like every other subpath.

**It is not a strategy service.** No `with<Name>()` factory, no strategy-bag row, no `NO_*` stub —
each would cost kernel lines for a feature that needs none. It must therefore be added to
`NOT_SERVICE_SUBPATHS` in `scripts/check-architecture.mjs`, whose `service-subpath-naming` check
otherwise requires every subpath to have a matching factory. The reason is recorded there and in
`SERVICES.md`, as that guard's contract requires.

**Bundle impact is zero when unused.** The hub declares `sideEffects: false`, so an app that never
imports the subpath never pays for it. A bundle-gate scenario asserts this rather than assuming it.

---

## Testing

| Area | Assertion |
|---|---|
| ordering | phases run in declared order; phase *n+1* never starts before *n* resolves |
| transitions | `cold → pulling → live` |
| subscribe | a late subscriber receives current state immediately |
| multi-phase collection | stays `'pulling'` until its **last** naming phase completes |
| unnamed collection | reads `'live'`, never gates a UI |
| unfiltered phase | names only collections with local records at phase start; a collection arriving *in* that phase goes `'live'` at the next boundary, not immediately |
| unfiltered warning | a phase omitting `collections` warns once, and does not throw |
| **failure** | a phase with errors leaves its collections `'cold'` — explicitly not stuck `'pulling'` |
| **throwing pull** | `run()` rejects; no collection is left `'pulling'` |
| **validation** | an invalid plan throws at construction, before any I/O |
| **zero kernel cost** | bundle scenario: importing `@noy-db/hub` alone does not pull in the orchestrator |
| KPI | each phase result's `pulled`/`bytes` match what `pull()` reported |
| sync required | without `withSync()`, the hub's own actionable error propagates unchanged |
| idempotent | running the same plan twice is safe and cheap |

The **failure**, **zero kernel cost** and **no-stuck-pulling** rows are the ones to write first —
each guards a property whose loss would silently ruin the feature.

---

## Out of scope

- **Blobs.** #808 owns their lifecycle; on-demand by construction.
- **Push.** The dirty queue is never phased or filtered.
- **Per-record priorities** beyond phase granularity.
- **Framework bindings.** At least one `in-*` example belongs in a follow-up, once the handle exists.
- **Docs.** The thin-client bootstrap section and the showcase step (noy-db-docs#120) follow.

---

## Rejected alternatives

**Readiness on `Collection`, `progressive` on `PullOptions` — the first draft of this spec.**
Rejected outright: it grows the kernel for a feature most consumers never enable, in a file with one
line of ceiling headroom, and it forced a **breaking reshape of `PullResult.phases`** plus a
`'live'`-by-default rule invented purely to stop non-adopters' UIs freezing. The orchestrator shape
removes all three problems at once. Recorded because the pull toward "just add it to the kernel,
it's only a getter" is exactly what the ceiling exists to resist.

**A real strategy service (`withBootstrap()`, bag row, `NO_BOOTSTRAP` stub).** The conventional
shape for hub capabilities, and the right one when a feature must hook the write path or hold vault
state. This one needs neither — it only sequences public calls — so the bag row and stub would be
pure kernel cost for no capability.

**A tri-state or wrapper return from `get()`.** Impossible to forget, but it makes the return type
mode-dependent, splits every call site, and puts cost on the kernel's hottest path. Collection-level
readiness answers the question UIs actually ask.

**Per collection×period readiness.** Would let the portal render the current quarter while older
periods stream in — the real UX goal. Deferred for v1: it turns "is `invoices` ready?" into "ready
for *which* period?", needing a compound key and compound events. The `phase` index on
`ReadinessEvent` gives a partial answer meanwhile. Revisit if render-during-backfill proves to
matter.

**Persisting readiness.** Would render instantly after a restart, but mints state that can disagree
with the store (e.g. after a manual purge) and would need a never-sync guarantee enforced rather
than documented.

**Deriving readiness from "does the collection have records?"** Survives restart with no new state,
but a partially-pulled collection reads as `'live'` — reintroducing the false-confidence problem the
feature exists to remove.

**Resolving `run()` after phase 1 with the rest in background.** Gives time-to-first-interaction as
an awaited value, but leaves work running after the promise settles and later-phase errors with no
home. `subscribe` already provides the early signal.
