# Sealed deterministic numbering + store-coordinated clock — design (DESIGN ONLY)

**Layer:** Store / sequencing · **Status:** design spec — **not implemented**. Sibling to the shipped CAS sequence (`#303`, `vault.sequence().next()`). Informed by a verified deep-research pass on distributed clocks, commit-timestamp ordering, and fiscal numbering (citations below).

## Problem

`vault.sequence(name).next()` (`#303`) gives gap-free numbering via an optimistic CAS hot-counter, but it **requires the store to advertise `capabilities.casAtomic`** — it throws `SequenceOfflineError` otherwise (`sequence/index.ts:90`). That correctly refuses on non-CAS stores, but leaves two real gaps the Pilot-3 deployment hits:

1. **Solo on a non-CAS local store** — a single-writer install on `to-file` can't number at all, even though there's no concurrency to race.
2. **Multi-operator on a shared store that has strong read-after-write but no (or expensive) hot-row CAS** — e.g. an object store. A hot CAS counter is either unavailable or a contention bottleneck.

This spec adds a **second, complementary** primitive — *sealed deterministic numbering* — that assigns serials by ordering records on their **store commit time** (not app/client time) after a settling window, plus the **store-clock abstraction** (`getStoreTime()`) it needs. It also defines the capability matrix that routes a deployment to the right primitive, and states the hard CAP boundary where neither works and **per-series** numbering is the only correct answer.

## Prior art & research findings (verified)

A 5-angle research pass (23 sources, 25 claims, 3-vote adversarial verification) produced these load-bearing, **confirmed** results:

- **A store/server clock must be modelled as a bounded-uncertainty *interval*, not a point.** Google Spanner's TrueTime exposes `[earliest, latest]` and achieves external consistency only by **commit-wait** — waiting out the uncertainty before a write is observable. [Spanner OSDI'12](https://www.usenix.org/system/files/conference/osdi12/osdi12-final-16.pdf)
- **Hybrid Logical Clocks (HLC) are the recognized "no atomic clock" option** for monotonic, causally-consistent ordering — used by CockroachDB and YugabyteDB. CockroachDB runs on plain NTP (~100–250 ms accuracy), enforces a **max-offset bound**, **restarts** any read that lands inside another value's uncertainty window, and **self-terminates a node** that detects drift beyond the bound. [CockroachDB: living without atomic clocks](https://www.cockroachlabs.com/blog/living-without-atomic-clocks/), [clock management](https://www.cockroachlabs.com/blog/clock-management-cockroachdb/), [YugabyteDB clock sync](https://www.yugabyte.com/blog/evolving-clock-sync-for-distributed-databases/)
- **Wall-clock Last-Writer-Wins is unsafe** — clock skew between nodes silently loses updates (the canonical Cassandra LWW failure). [CASSANDRA-11586](https://issues.apache.org/jira/browse/CASSANDRA-11586), [Aphyr: the trouble with timestamps](https://aphyr.com/posts/299-the-trouble-with-timestamps)
- **Timestamps alone do not provide a stable total order** — a deterministic tiebreaker is mandatory.
- **Accurate inter-server *offset estimation* is NOT a prerequisite for correct ordering** (this claim was *refuted*, 1-2). Systems achieve correctness via bounded-uncertainty + commit-wait (TrueTime) or HLC — **not** by estimating and subtracting pairwise clock offsets. This kills the "multi-store offset/sync" idea as a core mechanism.
- **S3 and Cloudflare R2 both provide strong read-after-write consistency** (GET/PUT/LIST on S3). [S3 consistency](https://aws.amazon.com/s3/consistency/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- **S3/R2 DO support conditional-write CAS** — the claim "R2 resolves concurrent writes by LWW with no CAS" was *refuted* (0-3). Modern S3 (`If-Match`/`If-None-Match`) and R2 conditional writes give atomic compare-and-swap. So these object stores can back **both** primitives.
- **Safe lease/lock coordination needs a monotonically-increasing fencing token**, never a wall clock. [Kleppmann: how to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- **Even mature databases don't promise gap-free sequences** (Snowflake DB sequences explicitly don't) — gap-free is a strong, special requirement, not a default. [Snowflake sequences are not gap-free](https://medium.com/snowflake/did-you-snow-1-sequences-does-not-guarantee-gap-free-numbers-why-cd6d2f74c0ec)
- **Italian fiscal law explicitly permits per-series numbering** (registri *sezionali*): multiple registers, each independently gap-free. Per-operator/per-device series is the *blessed* multi-station pattern, not a workaround. [FatturaPA sezionali](https://www.facilefatturaelettronica.it/sites/default/files/materiali/FFE-Sezionali-NumerazioneFatture-MonoSez-190902.pdf), [numerazione fatture](https://www.danea.it/blog/numerazione-fatture-guida/)

**Verdict from the research:** the store-coordinated-clock approach is **sound, but only in the TrueTime/HLC shape** — `getStoreTime()` must be an *interval*, sealing must *commit-wait* out the uncertainty, and the system must *fail-closed* when the bound is exceeded. The naive "estimate offsets between stores and sort by adjusted wall time" idea is the unsafe path the literature specifically warns against. Borrow: TrueTime interval + commit-wait, CockroachDB max-offset + fail-stop, HLC for the no-atomic-clock case, fencing tokens for any lease, per-series for offline. Avoid: offset averaging, wall-clock LWW, point-valued store time.

## The two primitives

| Primitive | Mechanism | Best for | Store requirement |
|---|---|---|---|
| `sequence(name).next()` (exists, #303) | optimistic CAS hot-counter | online, one authority or CAS store; low-to-moderate contention | `casAtomic` |
| **`withSealedNumbering` (new)** | deferred deterministic sort by store commit time, sealed per batch | shared strong-RAW store; high-throughput; avoids hot-row contention | `serverWriteTime` + strong read-after-write (ordering); `casAtomic` *or* a designated sealer (seal commit) |
| *(fallback)* per-series allocation | per-operator/device disjoint series | offline / loose-sync / independent concurrent stores | none (CAP-safe) |

These are complementary, not competing: `next()` coordinates **on write** (one CAS per number); sealed numbering coordinates **on seal** (one CAS per *batch*), trading write-time contention for a settling delay.

### Unified async API surface

Both primitives expose the **same call shape — `next(): Promise<number>`** — so callers and UIs don't branch on store type: `await` it, show a loader, render the number when it resolves. What differs is *latency* and *binding*:

```ts
// CAS: resolves in ms with a fresh number the caller places.
const n = await vault.sequence('invoices').next()

// Sealed: resolves when the next seal assigns THIS record its serial
// (after the settling window). `for` binds the eventual number to a record,
// because sealed numbering orders + stamps records by store-commit-time.
const n = await vault.sequence('invoices').next({ for: recordId, timeoutMs })
```

Semantics that keep the shared signature honest:

- **Resolves at the next *scheduled* seal — it does not trigger one.** Forcing a seal per call would destroy batching and can't satisfy commit-wait (the settling window must elapse). The Promise is a subscription: "resolve when my record is sealed."
- **The record's `fiscalNumber` field is the source of truth; the Promise is a live convenience over it.** A crash between `next()` and the seal loses the in-memory Promise but **not** the durable pending record — it still gets numbered at the next seal. Robust UIs re-read the field on reload; the Promise is the fast path, not the system of record. (In-process: a pending-promise registry; cross-instance: poll the record / series head.)
- **Resolution order = store-commit-time order, not call order.** Two operators calling `next()` concurrently get serials in the order their records committed to the store.
- **Fail-closed stays pending, doesn't reject.** Under clock uncertainty the seal waits, so the Promise stays unresolved; an optional `timeoutMs` rejects with a "numbering delayed" signal so the UI can surface that state instead of spinning.
- **Discoverability caveat (leaky abstraction):** the same `await invoice.next()` is ~1 ms on a CAS store and up to `settleWindowMs` on a sealed deployment. This latency gap must be documented at the call site so a developer isn't surprised that a "get the next number" call can block for minutes on a file-share backend.

## The store-clock abstraction

```ts
interface StoreTime {
  /** Lower bound — true time is provably ≥ this. */
  readonly earliest: number
  /** Upper bound — true time is provably ≤ this. */
  readonly latest: number
}

interface NoydbStore {
  // … existing …
  /**
   * Authoritative store time as a bounded-uncertainty interval (TrueTime
   * model). `latest - earliest` is the store's clock-uncertainty bound ε.
   * Backed by the store's own write clock where available; never the
   * client wall clock. Absent ⇒ store cannot back sealed numbering.
   */
  getStoreTime?(): Promise<StoreTime>
}
```

**Why an interval, not a point** (TrueTime): a point-valued `getStoreTime()` re-creates wall-clock LWW. The interval lets sealing *commit-wait* — only timestamps whose `latest < watermark` are certainly in the past, so no later record can sort before them.

**Per-store sourcing** (folds into the #321 capabilities audit as a new `serverWriteTime` capability):

- `to-aws-s3` / `to-cloudflare-r2` — object `Last-Modified` (server-assigned) + strong read-after-write. ε from observed NTP/clock-skew bound. ✅ both primitives (also CAS via conditional writes).
- `to-file` / `to-nfs` — filesystem `mtime`. Local fs: tight ε. NFS: looser (attribute caching) — larger ε or unsupported.
- `to-aws-dynamo` — no automatic server timestamp; but it has `casAtomic`, so use `next()`. `serverWriteTime: false`.
- `to-memory` — synthetic monotonic counter; ε≈0 (single process). Fine for tests; `casAtomic` already true so `next()` is the real path.

**Multi-store: do NOT estimate/sync offsets.** The research refutes offset estimation as a prerequisite. Instead:

1. **Single authoritative store** for the numbering series — its `getStoreTime()` is the only clock that matters. This is the recommended default; it sidesteps cross-store skew entirely.
2. **HLC** (hybrid logical clock) when causal monotonicity is needed across stores without a single authority — a `(physicalTime, logicalCounter)` pair that never goes backwards. Heavier; deferred to a later slice if a real multi-store-authority case appears.
3. Otherwise → **per-series** (below). Independent concurrent stores with no canonical authority cannot share a gap-free sequence (CAP).

## `withSealedNumbering` — the algorithm

Declared per collection (or per numbering series):

```ts
createNoydb({
  numbering: withSealedNumbering({
    series: 'invoices-2026',
    field: 'fiscalNumber',          // where the assigned serial is written
    settleWindowMs: 5 * 60_000,     // must be ≥ store uncertainty bound ε
    store: 'authoritative',         // single-authority clock source
  }),
})
```

**Write** — records get a unique id (ULID) and **no** serial; they are "pending".

**Seal** (triggered after `settleWindowMs`, by any connected operator, or a designated sealer):

1. `now = getStoreTime()`. Compute **watermark** `T = now.earliest - ε` — the latest instant provably in the past for every record (commit-wait: subtract the uncertainty so no in-flight write can still land before `T`).
2. Read all pending records with strong read-after-write (completeness up to the read point is guaranteed on S3/R2).
3. Take records with `record.storeTime.latest ≤ T` (certainly settled); sort by the **total order `(storeTime.earliest, recordId)`** — `recordId` is the mandatory tiebreaker since timestamps alone aren't a total order.
4. Assign serials by position, **appending after the last sealed serial** (read from the series head). Records with `storeTime.latest > T` stay pending for the next seal.
5. **Commit the seal** by advancing the series head `{ lastSerial, watermark: T }`. This is the one irreducible coordination point — one per batch, not one per number. Two ways to commit it, depending on the store:
   - **`casAtomic` available** (S3/R2 conditional writes, Dynamo) → **any operator** may seal; concurrent sealers are CAS-arbitrated (the loser re-reads and converges, since the assignment is deterministic). Preferred — no single point of authority.
   - **`serverWriteTime` but no CAS** (bare NFS/SMB share) → there is no safe way to arbitrate concurrent seal commits, so a **single designated sealer** must own the series head (a fenced lease — monotonic fencing token, never a wall clock). This reintroduces one online authority, but only for the seal, not for every write.

   **Coherence note:** sealed numbering's *ordering* needs only `serverWriteTime`, but its *seal commit* needs `casAtomic` **or** a designated sealer. The research established that S3/R2 have both `serverWriteTime` and conditional-write CAS, so the common cloud case is any-operator sealing; the designated-sealer path exists for plain file shares.

**Why this is stable** (the property the earlier app-time scheme lacked): store commit time is monotonic with actual commit order, so a newly-written record always has `storeTime > T` of any sealed batch → it can only **append**, never insert mid-sequence → already-issued serials never shift. The seal's CAS makes the watermark agreed, so two concurrent sealers either compute the identical assignment (deterministic) or one's CAS loses and re-reads — converging without duplicates.

**Fail-closed** (CockroachDB model): if `getStoreTime()` is unavailable, ε exceeds `settleWindowMs`, or drift beyond the bound is detected, sealing **refuses** (`NumberingUncertaintyError`) rather than guessing. Pending records simply wait. Issuance is gated on a sealed serial, so nothing is finalized under uncertainty.

## Topology verdicts

| Topology | Primitive | Why |
|---|---|---|
| Solo / single writer | `next()` with `{ singleWriter: true }` opt-in, **or** sealed | no concurrency; relax the `casAtomic` gate under an explicit single-writer assertion |
| Multi-op, CAS store (Dynamo, S3/R2 conditional) | `next()` | atomic counter is simplest when contention is low |
| Multi-op, strong-RAW store w/ server time (S3/R2, local fs share) | **`withSealedNumbering`** | no hot-row contention; one CAS per batch; server time gives stable order |
| Loose-sync / offline / independent concurrent stores | **per-series** only | single global gap-free sequence is impossible across partitions (CAP); per-series is gap-free per register and fiscally valid (sezionali) |

## Capability matrix (extends the #321 audit)

Each `to-*` adapter is tagged with what coordination it can offer:

- `casAtomic: true` → `next()` available.
- `serverWriteTime: true` (+ strong read-after-write) → `withSealedNumbering` available.
- neither → per-series only; `next()`/sealed throw with an actionable message pointing to per-series.

The #321 follow-up audit therefore classifies **two** capabilities per store, not one. Known: S3/R2 = both; Dynamo = casAtomic only; local file = serverWriteTime (tight ε); NFS/SMB = serverWriteTime with loose ε or neither; memory = casAtomic.

## What to build (recommended slicing)

1. `StoreTime` interval type + `getStoreTime?()` on `NoydbStore`; `serverWriteTime` capability. Implement for `to-file` (mtime) + `to-aws-s3` (Last-Modified) first.
2. `withSealedNumbering` core: pending-record model, watermark + commit-wait seal, `(storeTime, id)` order, one-CAS series head, fail-closed `NumberingUncertaintyError`.
3. `singleWriter` opt-in on `next()` (closes the solo gap; smallest change).
4. Per-series allocator (`series:` discriminator) — the offline/CAP answer. Arguably build this **first**: it is unconditionally correct and unblocks the most topologies with the least machinery.
5. (Deferred) HLC store clock — only if a real multi-store-authority case appears.

## Open questions

- **Where does the seal run?** Any-operator (each runs the deterministic seal, CAS-arbitrated) vs a single designated sealer (simpler, needs that node online). Recommend any-operator with CAS arbitration; fencing token on the series head.
- **ε sourcing.** How is the uncertainty bound measured per store — fixed conservative constant, NTP-reported dispersion, or observed round-trip? Start with a conservative constant per adapter; expose it.
- **Settling vs latency.** `settleWindowMs` trades issue latency for safety. Is a 5-min defer acceptable for the pilot's invoice flow, or is `next()`-on-a-CAS-store the better fit there (and sealed numbering reserved for non-CAS shared stores)?
- **Date-order vs sync-order for offline.** Per-series + late sync numbers in sync order, which can break "numbers ascend with dates." Flag late arrivals for manual handling, or bind series to fiscal periods.

## Relationship to existing work

- `#303` atomic sequence — the CAS sibling; unchanged. This spec adds the non-CAS path.
- `#321` capabilities audit — gains a second capability (`serverWriteTime`) per adapter; this spec defines it.
- Fiscal periods / `immutableGuard` (#301) — issued (sealed-and-numbered) records become WORM; sealing is the natural point to freeze them.
