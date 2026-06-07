# Cross-Vault Live Queries & Distributed Aggregate — Design

- **Date:** 2026-06-07
- **Milestone:** 16 — Multi-vault partition federation (epic #271)
- **Status:** Design approved; revised to fold in the #312 forward-compat amendments (A/B/E) — pending re-review, follows the VaultGroup routing MVP (PR #292)
- **Scope:** `queryAcrossLive` (reactive record fan-out) + `aggregateAcross` (one-shot distributed reduce, scalars + groupBy) + `aggregateAcrossLive` (reactive distributed reduce), all on the `ShardedQuery` surface — made **key-custody-neutral** per #312

## #312 forward-compat amendments (folded in)

This revision absorbs three forward-compat changes from #312 (custodial multi-tenant adopter, epic #271). They are cheap pre-implementation and expensive to retrofit once the surface ossifies:

- **A — `SkippedVault.reason: 'no-grant'`** distinct from `'error'`. A fan-out identity that legitimately lacks a grant to a shard must be reported as access-scoping, not a fault.
- **B — key-custody-neutral fan-out contract.** Drop "single operator owns all shards" from the *contract*: VaultGroup ops run as an identity holding *some* grants; the eligible/returned set is the **openable subset**, not necessarily all shards. All-owning-operator is one configuration.
- **E — optional `Reducer.merge(S,S): S`** on the aggregate protocol (complements `remove`/`seed`), enabling parallel + hierarchical combine. **Central-reduce stays the default** for this slice; `merge` is the seam that unblocks distributed partial-reduce and advisor→firm rollup later.

**Load-bearing finding (beyond #312 as written):** A+B require a real behavior change, not just a new union member. `loadKeyring` throws `NoAccessError` when *this* identity's `_keyring/<userId>` is absent without checking whether the vault has *other* principals; `getKeyringInternal` then treats that as "first boot" and **`createOwnerKeyring`s a fresh owner keyring with new DEKs into the vault**. So a non-granted fan-out open today would *silently self-provision* (zero-record read, stray keyring written) instead of failing — there'd be nothing for A to classify, and B's model would be actively unsafe. Resolution (chosen): a **contained no-create open mode** used only by the read fan-out (below); global `openVault` behavior is unchanged.

## Goal

Extend the VaultGroup read surface from the MVP (one-shot `query().where().toArray()`)
with **reactive cross-shard queries** and **distributed aggregation**, so a firm can
render a live "all overdue invoices across every client" list or "total revenue per
client" dashboard without manually wiring N per-vault subscriptions or stitching N
aggregate queries.

## Scope

### In scope
- `ShardedQuery.live(opts?)` → `CrossVaultLiveQuery<R>` — reactive merged records across shards (the epic's `queryAcrossLive`).
- `ShardedQuery.aggregate(spec)` / `ShardedQuery.groupBy(field).aggregate(spec)` → a `CrossVaultAggregation` / `CrossVaultGroupedAggregation` wrapper with:
  - `.run(opts?)` — one-shot distributed reduce (the epic's `aggregateAcross`).
  - `.live(opts?)` — reactive distributed reduce (`aggregateAcrossLive`).
- Reducers: `count` / `sum` / `avg` / `min` / `max` (the existing `@noy-db/hub/aggregate` reducers) + single-field `groupBy`.
- All live primitives expose `ready: Promise<void>` (resolves after first settle) and carry `skippedVaults`.
- **(A)** `SkippedVault.reason` gains `'no-grant'`; the fan-out opens shards non-creatingly and classifies authz failures distinctly.
- **(B)** Key-custody-neutral contract stated in the subsystem doc + this spec; the implementation already returns the openable subset.
- **(E)** `Reducer.merge?(a,b): S` added to the protocol + the 5 built-ins, with unit tests. (Used as a seam; aggregate impl stays central-reduce.)

### Out of scope / deferred (with reason)
- **Framework adapter bindings** (`in-vue` / `in-react` / `in-pinia` / `in-zustand`). The cross-vault live primitives are made *structurally assignable* to the existing `LiveQuery<T>` / `LiveAggregation<R>` contracts (verified by a type test) so adapters can bind them later, but no framework package is modified in this slice.
- **Distributed partial-reduce + hierarchical rollup.** This slice adds the `Reducer.merge` *protocol* (E) but the `aggregateAcross` *implementation* stays **central reduce** (fan out the `where`-filtered records, concatenate, reduce once on the coordinator — correct for all reducers incl. `avg`). Rewriting the aggregate into a per-shard partial-state → merge-by-bucket engine (transfers tiny states; enables advisor→firm rollup) is a follow-up that *consumes* `merge`. Adding the protocol method now is the cheap, expensive-to-retrofit part; using it pervasively is deferred.
- **Multi-key `groupBy`.** `groupAndReduce` already accepts `string | readonly string[]`, so multi-key is nearly free at runtime; this slice exposes only single-field `groupBy(field)` to keep the typed row shape simple. Multi-key is a deliberate, low-cost follow-up.
- **Public Noydb engine methods** `db.queryAcrossLive` / `db.aggregateAcross`. The features are delivered via the `ShardedQuery` ergonomic surface (which is what consumers use). No new method on the core `Noydb` class → zero new core-bundle weight. Naming map: epic `queryAcrossLive` → `ShardedQuery.live()`; epic `aggregateAcross` → `ShardedQuery.aggregate().run()`.
- **`crossShardJoin`, `withCrossVaultDerivation`, fleet migration runner.** Other epic slices. `packages/hub/src/query/join.ts` remains untouched.

## Architecture

Most new code lives in the **federation module** (`packages/hub/src/federation/`), which is
already lazily loaded as its own chunk (MVP). The reactive core reaches change events
through the **already-public** `db.on('change', …)` / `db.off('change', …)`
(`NoydbEventMap['change'] = ChangeEvent`). The live/reactive surface adds **no core
weight**. Two small core touches are required by the #312 amendments: a no-create open
option on `openVault`/`queryAcross` (A, below) and the additive `Reducer.merge?` on the
aggregate protocol (E). Both are tiny and additive.

### Key-custody-neutral fan-out (#312 A + B)

The read fan-out must open shards **non-creatingly**, so a missing grant fails cleanly
instead of self-provisioning:

- **Core:** `openVault(name, { create?: boolean })` (default `true`, unchanged). When
  `create: false`, `getKeyringInternal` re-throws `NoAccessError` (and does not run
  `createOwnerKeyring`) instead of minting a keyring. `queryAcross(ids, fn, { create: false })`
  threads it through.
- **Both open paths are non-creating (#312 comment §1).** Self-provisioning must not be
  re-opened on the single-shard path: a scoped non-owner can call `shard(key)` (drill-down) or
  route a `put` to an existing shard it lacks a grant to. So **`openShard` opens non-creatingly**
  (it means "open an *existing* shard") — `shard()` and `put`-routing-to-an-existing-row both go
  through it and fail cleanly with `NoAccessError`. **`createShard` remains the sole creating
  path** (its create branch uses `openVault({ create: true })` directly; its idempotent
  `row && provisioned` branch calls the non-creating `openShard`, which still succeeds for a
  granted owner). Read fan-out (`toArray`/`live`/`aggregate`) opens via `queryAcross({ create: false })`.
- **Classification (A) — `NoAccessError` only (#312 comment §2).** `classifyShardSkip(err)`:
  `err instanceof NoAccessError` → `reason: 'no-grant'`; **everything else → `reason: 'error'`**.
  `NoAccessError` (no keyring envelope for this identity) is the *unambiguous* not-granted signal.
  `InvalidKeyError`/`DecryptionError` are **not** classified as no-grant: per `loadKeyring`,
  the "no DEK unwrapped + canary failed" path is *"wrong KEK **or whole-file corruption**"* — so
  bucketing it as the benign `'no-grant'` could mask corruption. A keyring that exists but won't
  unlock (credential mismatch) or is corrupt is a real fault to surface, not a silent skip.
  `KeyringCorruptError` and `ShardProvisioningError` (registry row present, vault *gone* — caught
  *before* the open by the `store.list` provisioning guard, unaffected by grants) likewise stay
  `'error'`. A pinning test asserts a corruption scenario surfaces as `'error'`, never `'no-grant'`.
- **Contract (B):** the eligible/returned set is the **openable subset** for the calling
  identity, not necessarily all shards. A non-granted shard appears in `skippedVaults` with
  `reason: 'no-grant'` — *expected* under scoped access, not a fault. All-owning-operator is
  one configuration. Stated in the subsystem doc + this spec so consumers don't bake in
  completeness.
- **Registry-grant prerequisite (B).** Opening the group at all requires a grant to the
  **StateManagement/registry vault** — the caller passes in an already-opened `vault-registry`
  collection handle (`openVaultGroup` doesn't self-open it), so a caller who can't open that
  vault can't construct the group. *Shard* grants then determine the openable subset *within*
  it. (Concretely: a scoped advisor needs read access to the registry vault plus grants to
  their ~40–50 client shards; the registry rows are plaintext metadata — `vaultId`,
  `partitionKey`, `schemaVersion` — no per-client DEK.)
- **Scope boundary (residual, tracked separately).** This is a *contained* fix on the
  federation open paths. Global `openVault` is unchanged: a non-granted identity opening a
  vault **outside** the federation surface still self-provisions today (the `getKeyringInternal`
  → `createOwnerKeyring` fallback fires whenever the caller's keyring is absent, without
  checking for other principals). Closing that hub-wide — `createOwnerKeyring` only on a
  genuinely-new vault (no `_keyring/*` at all) — is broad-blast-radius and out of scope here;
  filed as **#313** (the load-bearing fix for multi-tenant, since many non-federation paths
  also `openVault` by name — scoped drill-down, server-side insight executor, bundle
  import/adopt, recovery). **The `create` flag added here composes with #313's planned design**
  (create only when the vault has no `_keyring/*` at all; explicit `create: true` as the opt-in
  escape hatch for genuine create-into-existing) — so #313 tightens the `create: true` *default*
  semantics without reworking this flag: federation reads/drill-down already pass `create: false`,
  and `createShard` only ever creates genuinely-new shards.

### Registry visibility — roster existence is NOT scoped (#312 comment §3)

Making the registry the entry gate (B) means **registry-read exposes the whole roster.** The
`vault-registry` is one shared collection of **plaintext** rows; a scoped identity granted
registry-read to discover *its* shards reads **every** row — learning the `partitionKey` /
`vaultId` of *all* participants, including shards it cannot open. **Shard-level data access is
scoped; roster-level existence is not.** Two consequences:

1. **`keyOf` must return an opaque partition key.** Because `partitionKey`/`vaultId` are
   plaintext-visible to every group member, they must not encode anything sensitive — for the
   custodial adopter, **not** `keyOf: r => r.taxId` or a client name, but an opaque internal id
   (e.g. a ULID `clientId`), with sensitive identifiers living *inside* the client's vault
   records. Then the leak is bounded to "N opaque vaults exist," normally acceptable. Stated as
   guidance in the subsystem doc (the natural temptation is to key by a human identifier).
2. **Per-identity roster scoping is a known boundary, not provided here.** If an adopter needs
   an identity to see *only its assigned* registry rows (not the full roster), a single shared
   plaintext registry can't deliver that — it needs registry-row-level access control or
   per-identity registry views, a larger design out of scope for this slice. Named so adopters
   don't assume the registry grant confers row-level scoping.

   **Pre-filter optimization — must preserve A's signal (#312 comment §4).** A scoped identity's
   full-roster fan-out yields many `'no-grant'` skips (one per shard it can't open). A future
   optimization can pre-filter — intersect registry `vaultId`s with the caller's grant set
   *before* fan-out — to avoid N failing opens (no registry change needed; the caller knows its
   grants). **But it must NOT make non-granted shards silently absent** — that would turn A's
   *visible* scoping back into *invisible* scoping and hide a **misconfigured** grant (an advisor
   who *should* have shard X but doesn't would just vanish from results instead of surfacing as a
   `'no-grant'` entry the UI can flag). So the optimization must either be **opt-in**, or still
   **emit the pre-filtered shards as `'no-grant'` skips** (computed from registry ∖ grants, emitted
   without opening) — keeping B's "openable subset is *explicit*, not silently truncated" property.

Three units (live/aggregate surface):

### 1. `CrossVaultLive<S>` — the reactive core (`federation/cross-vault-live.ts`)

A generic reactive loop over a **snapshot** `S`. One implementation, two facades.

```
db.on('change') ──filter(isRelevant)──▶ scheduleRecompute ──debounce/single-flight──▶ compute(): Promise<S>
                                                                                          │
                                          snapshot = S ; error = null|err ; notify() ◀────┘
```

State & contract:
- `snapshot: S` — current full result (starts at `initialSnapshot`).
- `error: Error | null`.
- `ready: Promise<void>` — resolves after the **first** compute settles (success or error). Serves SSR / "spinner until first result" / deterministic tests.
- `subscribe(cb): () => void` — fires after each settle (including the first if subscribed before it); does **not** fire synchronously on subscribe. Returns an unsubscribe fn.
- `stop(): void` — unsubscribe from the emitter, cancel any pending schedule, clear subscribers, mark stopped (later in-flight results are discarded). Idempotent.

Reactivity rules:
- **Relevance filter** (provided by the caller). For VaultGroup: `e.collection === collectionName && e.vault.startsWith(`${groupName}--`)`. The `${groupName}--` prefix is collision-safe because the MVP validates that neither group name nor partition key contains `--`. **No registry-watching needed:** an empty newly-created shard contributes nothing, and the first data write to any shard (new or existing) matches the prefix and triggers a recompute that re-reads the registry — so dynamic shard pickup falls out of data-write events for free.
- **Single-flight + trailing recompute:** if a change arrives while a compute is in flight, set `dirty`; when it settles, if `dirty`, recompute again. Guarantees no overlapping fan-outs and that the final snapshot reflects the latest committed state.
- **Debounce/coalesce:** schedule recompute via `queueMicrotask` by default (`debounceMs: 0`) so a synchronous burst (e.g. `putMany`) collapses into one recompute; `debounceMs > 0` uses a timer. Configurable via opts.
- Change events fire **after** store commit, so a same-instance write is already reflected in the shard collection's in-memory cache when the recompute reads it. (Same-instance reactivity only — cross-process/tab propagation is a `by-*` transport concern, out of scope; co-location assumption per the epic.)

Two thin facades over the core:

```ts
// records / grouped rows — array-shaped, mirrors LiveQuery<T>
interface CrossVaultLiveQuery<T> extends LiveQuery<T> {       // value: readonly T[]; error: Error|null; subscribe; stop
  readonly skippedVaults: readonly SkippedVault[]
  readonly ready: Promise<void>
}
// scalar aggregate — mirrors LiveAggregation<R>
interface CrossVaultLiveAggregation<R> extends LiveAggregation<R> {  // value: R|undefined; error: unknown; subscribe; stop
  readonly skippedVaults: readonly SkippedVault[]
  readonly ready: Promise<void>
}
```
The facade `value` / `skippedVaults` / `error` are getters reading the core's current snapshot. `CrossVaultLiveQuery<T>` is assignable to `LiveQuery<T>` and `CrossVaultLiveAggregation<R>` to `LiveAggregation<R>` (extra members only) — the adapter-compat guarantee, asserted by a type test.

**Reference semantics (intentional divergence):** `LiveQuery`'s doc promises the same array reference mutated in place; the cross-vault compute returns a **fresh** merged array each settle. New-ref-per-update is better for Vue/React change detection. Documented so it isn't "fixed" back to in-place mutation; the type-level compat test still passes.

### 2. Distributed aggregate (`federation/aggregate-across.ts`)

Central reduce over the concatenated, `where`-filtered record stream — the same pattern the UNION materialized-view already uses:

- Ungrouped: `reduceRecords(allRecords, spec)` → `AggregateResult<Spec>`.
- Grouped: `groupAndReduce(allRecords, field, spec)` → `Row[]` where `Row = { [field]: K } & AggregateResult<Spec>`.

Wrappers (mirroring single-vault `Aggregation` / `GroupedAggregation`):
```ts
class CrossVaultAggregation<Spec> {
  run(opts?): Promise<{ result: AggregateResult<Spec>; skippedVaults: SkippedVault[] }>
  live(opts?): CrossVaultLiveAggregation<AggregateResult<Spec>>
}
class CrossVaultGroupedAggregation<F extends string, Spec> {
  run(opts?): Promise<{ results: GroupedRow<F, Spec>[]; skippedVaults: SkippedVault[] }>
  live(opts?): CrossVaultLiveQuery<GroupedRow<F, Spec>>   // grouped rows are array-shaped
}
```
The grouped cardinality cap (100k buckets, enforced inside `groupAndReduce`) applies to the **merged** stream; an overflow throws on `run()` and surfaces as `error` on `.live()`. Documented.

**`Reducer.merge` (#312 E) — protocol seam, added now, used later.** Add an optional `merge?(a: S, b: S): S` to the `Reducer<R,S>` interface (`aggregate/reducers.ts`), complementing `remove`/`seed`, and implement it on the 5 built-ins: `sum`/`count` → `a + b`; `min`/`max` → `Math.min`/`Math.max`; `avg` → `{ sum: a.sum + b.sum, n: a.n + b.n }`. It is **purely additive and optional** (no protocol break; central reduce ignores it). `merge` combines independent partial **states** (then `finalize` once) — never finalized results. This unblocks two follow-ups without committing to them now: distributed partial-reduce (per-shard state → merge-by-bucket → finalize, transferring tiny states instead of records) and hierarchical rollup (advisor-level partials → firm-level), the custodial adopter's exact shape.

### 3. `ShardedQuery` surface additions (`federation/vault-group.ts`)

Extend the MVP `ShardedQuery<T,R>` (`where`, `toArray`) with:
- `.live(opts?): CrossVaultLiveQuery<R>`
- `.groupBy<F extends string>(field: F): ShardedGroupedQuery<T, R, F>`
- `.aggregate<Spec>(spec): CrossVaultAggregation<Spec>`

and a new `ShardedGroupedQuery<T,R,F>` with `.aggregate<Spec>(spec): CrossVaultGroupedAggregation<F, Spec>`.

**Shared internals (DRY refactor of the MVP):** extract from `toArray` two reused helpers, then make `toArray`, `live`, and the aggregate computes all route through them:
- `VaultGroup.resolveEligible(opts): Promise<{ eligible: VaultRegistryRow[]; skipped: SkippedVault[] }>` — `allRows` → `minVersion` schema-drift skip → provisioning-divergence guard (`Promise.all(_shardVaultProvisioned)`).
- `ShardedQuery.fanoutRecords(opts): Promise<{ records: R[]; skippedVaults: SkippedVault[] }>` — `resolveEligible` → `queryAcross(ids, fn, { create: false })` (no-create open + configure + `await list()` hydrate + `query().where(clauses).toArray()`) → merge results + fold per-shard errors into `skippedVaults` via `classifyShardSkip(err)` (`'no-grant'` for `NoAccessError` only, else `'error'`).

Then:
- `toArray(opts)` = `fanoutRecords(opts)` (behavior identical to MVP — verified by re-running the 16 MVP tests).
- `live(opts)` = `CrossVaultLiveQuery` over compute `() => fanoutRecords(opts)`.
- `aggregate(spec).run(opts)` = `fanoutRecords(opts)` → `reduceRecords(records, spec)`.
- `aggregate(spec).live(opts)` = `CrossVaultLiveAggregation` over the same compose.
- grouped variants swap `reduceRecords` for `groupAndReduce`.

## Data flow (live records example)

```
firm.collection('invoices').query().where('status','==','overdue').live()
  → new CrossVaultLiveQuery facade over CrossVaultLive<{records, skipped}>:
      subscribeToChanges = h => { db.on('change', h); return () => db.off('change', h) }
      isRelevant = e => e.collection === 'invoices' && e.vault.startsWith('firm-clients--')
      compute    = () => shardedQuery.fanoutRecords(opts)
      initial    = { records: [], skipped: [] }
  → constructor kicks first compute (async); ready resolves after it settles
  → on each relevant committed change: microtask-coalesced, single-flight recompute
```

## Error handling
- **No grant (A):** the calling identity has no keyring for a shard (`NoAccessError` from the no-create open) → `skippedVaults` `{ reason: 'no-grant', error }`. Expected under scoped access, not a fault.
- Per-shard fan-out fault — anything **not** `NoAccessError` (incl. `InvalidKeyError`/`DecryptionError`/`KeyringCorruptError` = corruption or credential mismatch) → `skippedVaults` `{ reason: 'error', error }`.
- Schema drift (below `minVersion`) → `skippedVaults` `{ reason: 'schema-drift' }` (reused).
- Provisioning divergence (registry row, vault gone) → `skippedVaults` `{ reason: 'error', error: ShardProvisioningError }` (caught by the provisioning guard before the open; stays `'error'`, distinct from `'no-grant'`).
- Catastrophic compute failure (e.g. registry read throws, or grouped cardinality overflow) → live primitive sets `error`, retains last good snapshot, notifies; `run()` rejects.
- Empty fleet / no matching records → records `[]`; `count` 0, `sum` 0, `avg` `null` (per the `avg` reducer); grouped `[]`.

## Testing strategy

A **polling helper is mandatory** for the reactive tests — never assert "after N ticks." (Project history: the pre.6 cross-tab flake was fixed in pre.7 by polling instead of fixed `settle()` ticks; async-debounced fan-out is strictly more timing-sensitive.)
```ts
async function waitFor(pred: () => boolean, { timeout = 1000, interval = 5 } = {}) { /* poll until pred() or timeout-throw */ }
```
Prefer awaiting `lq.ready` for the first settle; use `waitFor(() => predicate)` for subsequent updates.

Cases:
1. **queryAcrossLive:** `await lq.ready` → initial value; write to a shard → `waitFor` value updates; write to a **new** partition (autoCreate) → new shard's records appear (dynamic pickup via data-write event); delete → disappears; `stop()` → no further updates; unsubscribe removes one callback; registry-read failure → `error` set, value retained.
2. **Single-flight / coalesce:** a burst of rapid puts → final value correct (assert eventual correctness via `waitFor`; optionally spy compute count ≤ writes).
3. **aggregateAcross one-shot:** `sum`/`count` across ≥2 shards; **`avg` correctness across shards** — shardA `[100,200]`, shardB `[300]` → `avg === 200` (proves central reduce, not averaging finalized averages); `groupBy('status')` with the same status spanning multiple shards → one merged bucket; `skippedVaults` (drift + provisioning) excluded from totals; empty → `count 0`, `avg null`, grouped `[]`.
4. **aggregateAcrossLive:** ungrouped + grouped value updates on change (`waitFor`); `stop()`.
5. **Adapter shape-compat (type test):** `expectTypeOf<CrossVaultLiveQuery<R>>().toMatchTypeOf<LiveQuery<R>>()` and `CrossVaultLiveAggregation<R>` ⊑ `LiveAggregation<R>`.
6. **MVP regression:** the 16 existing `federation-vault-group.test.ts` tests still pass after the `resolveEligible`/`fanoutRecords` extraction.
7. **(A) no-grant classification:** a fan-out where the identity lacks a grant to one shard (real keyring scenario: shard owned by another principal, operator has no grant) → that shard appears in `skippedVaults` with `reason: 'no-grant'` (not `'error'`); other shards return; **assert no `_keyring/<operator>` was written into the non-granted vault** (proves the no-create open didn't self-provision). Plus: provisioning-divergence still `'error'`; a genuine fault (e.g. injected store error) still `'error'`.
8. **(E) `Reducer.merge` unit tests** (`aggregate/reducers` test): for each of `sum`/`count`/`min`/`max`/`avg` — commutativity `merge(a,b) ≡ merge(b,a)`, associativity, identity `merge(init(), a) ≡ a`, and **merge-then-`finalize` equals reduce-over-concatenation** (the state-level invariant; never merge finalized results).

A showcase (`99-vault-group-live-aggregate.showcase.test.ts`) and a `features.yaml` showcase entry are added in the implementation plan.

## Files

**#312 A+B (land on the MVP base first — see Sequencing):**
- Modify `packages/hub/src/federation/types.ts` — `SkippedVault.reason` += `'no-grant'`.
- Modify `packages/hub/src/noydb.ts` — `openVault(name, { create?: boolean })` (default true) + thread `{ create }` through `queryAcross`; `getKeyringInternal` re-throws `NoAccessError` instead of `createOwnerKeyring` when `create: false`. (Small, additive; default path unchanged.)
- Modify `packages/hub/src/federation/vault-group.ts` — `classifyShardSkip(err)` helper; fan-out opens with `{ create: false }` and classifies `'no-grant'` vs `'error'`.
- Modify `docs/subsystems/vault-group.md` — state the key-custody-neutral contract (B).

**#312 E (land on the cross-vault-live branch, pre-implementation):**
- Modify `packages/hub/src/aggregate/reducers.ts` — add optional `merge?(a,b): S` to the `Reducer` interface + the 5 built-ins.

**Cross-vault live/aggregate slice:**
- Create `packages/hub/src/federation/cross-vault-live.ts` — `CrossVaultLive<S>` core + `CrossVaultLiveQuery` / `CrossVaultLiveAggregation` facades + interfaces.
- Create `packages/hub/src/federation/aggregate-across.ts` — central-reduce wrappers (`CrossVaultAggregation`, `CrossVaultGroupedAggregation`), reusing `reduceRecords` / `groupAndReduce`.
- Modify `packages/hub/src/federation/vault-group.ts` — extract `resolveEligible` / `fanoutRecords`; refactor `toArray`; add `live`, `groupBy`, `aggregate`, `ShardedGroupedQuery`.
- Modify `packages/hub/src/federation/types.ts` — option/result/row types (`LiveQueryOptions = FanoutQueryOptions & { debounceMs? }`, `GroupedRow`).
- Modify `packages/hub/src/federation/index.ts` + `packages/hub/src/index.ts` — export new public types/classes.
- Create `packages/hub/__tests__/federation-query-aggregate.test.ts` (live + aggregate + no-grant) and `packages/hub/__tests__/reducer-merge.test.ts` (E unit tests).
- Create `showcases/src/99-vault-group-live-aggregate.showcase.test.ts` + register in `features.yaml`.

## Sequencing

Respecting the already-done rebase: **A+B on the MVP base first** (so the `SkippedVault.reason` union doesn't ossify in PR #292 before it merges — #312's whole point) → **rebase cross-vault-live** → **E** + the live/aggregate slice on the cross-vault-live branch. A+B can ride PR #292 (or a small stacked PR onto it); E + the slice are the cross-vault-live PR.

## Relationship to existing work
| Prior work | Relationship |
|---|---|
| VaultGroup routing MVP (PR #292) | `live`/`aggregate` extend `ShardedQuery`; reuse `resolveEligible`/provisioning guard/`queryAcross` fan-out |
| `LiveQuery<T>` / `LiveAggregation<R>` (`query/live.ts`, `aggregate/aggregation.ts`) | Contracts the cross-vault facades mirror (adapter compat) |
| `reduceRecords` / `groupAndReduce` (`aggregate/`) | Central-reduce engine — reused unchanged |
| UNION materialized view | Precedent for "group + aggregate over a concatenated stream" |
| `db.on('change')` / `ChangeEvent` (`NoydbEventMap`) | In-process fan-in source for reactivity — no new transport |
| #312 (custodial multi-tenant adopter) | Source of amendments A (`'no-grant'`), B (key-custody-neutral contract), E (`Reducer.merge`); folded in above |
| `loadKeyring` / `getKeyringInternal` / `createOwnerKeyring` (`team/keyring.ts`, `noydb.ts`) | A's no-create open mode hangs off these; default (create) path unchanged |
| `join.ts` | Untouched (crossShardJoin deferred) |

## Held out of scope (per #312, for separate discussion)
The issue explicitly parks four related ideas; not pulled into this slice: (1) a docs note that custodial adopters can build cross-vault insight today via a trusted KMS-server executor + sync; (2) a cross-vault scoped-write / routing primitive on delegation tokens; (3) a guarantee that the reactive change-source is transport-pluggable (sync-fed, not only same-instance `db.on('change')`); (4) `extractPartition` carrying the key-custody handoff (re-wrap DEK to recipient, drop operator grant).
```
