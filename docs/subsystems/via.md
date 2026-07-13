# Field features — the Via port

The noy-db kernel is a pure encrypted document store: documents, envelopes, a query executor — and **one port**. Every capability a field can have — indexed, a reference, computed, money, translated, classified, a blob — is a **via-feature**: a declaration on the field that plugs behavior into one unified pipeline. You start with plain JSON and adopt one feature at a time; each is a separately tree-shaken chunk; anything you don't declare doesn't exist in your bundle. Underneath, every feature's promises — freshness, referential integrity, security posture, erasure — are enforced through one dependency graph and one mutation choke point, so a stale rollup, a dangling reference, a leaked derivative, or an unforgotten residue is a *kernel-refused state*, not a bug found in production.

**The architecture in one sentence:** *via-features declare, services provide engines, the kernel runs pipelines, the graph connects them.*

```ts
// rung 0 — kernel only: plain encrypted documents. No features, no chunks.
title:    {}

// each rung is one declaration + one tree-shaken chunk:
number:   via(indexed())                                   // fast lookup            (phase D)
customer: via(ref('customers', { onDelete: 'restrict' }))  // FK integrity           (phase D)
summary:  via(searchable())                                // full-text              (phase D)
subtotal: via(money({ currency: 'EUR', scale: 2 }))         // exact arithmetic       (phase A)
label:    via(i18nText({ languages: ['en', 'th'], required: 'all' }))  // locale fills + Label (phase A)
total:    via(computed(r => r.subtotal * (1 + r.vat), { deps: ['subtotal','vat'] }),
              money({ currency: 'EUR' }))                   // derived + stacked      (phase C + A)
iban:     via(classified())                                // sealed at rest         (phase B)
contract: via(blob())                                      // externalized binary    (phase B)
```

> Illustrative — the phase A entries (`money`, `i18nText`) are shipped and runnable
> as spelled above (see the `via()` composer section below for the full
> collection-option context). Phase B's `classified`/`blob` features are ALSO
> shipped, but not yet through the `via()` composer shown here — declare them
> via their own sugar keys instead, `classifiedFields`/`blobFields` (see
> [`docs/subsystems/via-classified.md`](via-classified.md) /
> [`docs/subsystems/via-blob.md`](via-blob.md)); `via(classified())` /
> `via(blob())` as spelled above remain unrunnable until the composer grows
> those brands. Phase C's `computed` entry is shipped and runnable exactly as
> spelled above, including the `money(...)` stack on the same field (see
> [`docs/subsystems/via-computed.md`](via-computed.md)). Phase D shipped a
> **different, more complete spelling** than the `indexed`/`ref`/`searchable`
> sketch above: `lookupFields`/`via(lookup(...))` — one binding, three
> backing tiers (enum/dict/first-class collection), altKeys, vocabulary, and
> `restrict`/`cascade`/`nullify` reference semantics (see
> [`docs/subsystems/via-lookup.md`](via-lookup.md)). The literal `indexed()`/
> `ref()`/`searchable()` spellings above remain unshipped design sketches.

## The grammar (the naming system this arc completes)

noy-db speaks **prepositions**; the grain is the tier. `for` and `with` are JS reserved words — `via` is legal, pipeline-true ("the value passes via the seal, via the formula, via the index"), the sibling of `by-` ("by way of"), and security-honest where `like` would read as simulation.

| Prefix | Tier | Reads as | Examples |
|---|---|---|---|
| **2-letter** `to- in- on- as- by- at-` | family packages (where noy-db meets the world) | data goes *to*, runs *in*, unlock *on*, export *as*, sync *by*, sealed *at* | `to-postgres`, `in-react`, `as-csv` |
| **3-letter** `via-` | **field grain** (how a value flows) | the value passes *via* these features | `via(money({ currency: 'EUR' }), indexed())` |
| **4-letter** `with-` | vault grain (what the vault is equipped with) | the vault comes *with* these services | `withSync()`, `withPeriods()` |

**Collection = the meeting point, not a tier.** Everything collection-level decomposes: per-collection *configuration* of `with-` services (conflictPolicy, crdt, lazy), kernel-fixed validation (schema), aggregated field declarations (sugar for per-field `via(...)`), and collection *topology* already defined by `with-` factories. No third preposition.

## The `via()` composer

Fields declare their features using `via(...)`, the unified field-feature declaration surface. `viaFields` is a **sibling** collection option next to `schema` — never a key inside `schema` — and holds one `via(...)` per declared field:

```ts
const invoices = vault.collection<Invoice>('invoices', {
  schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
  viaFields: {
    total: via(money({ currency: 'EUR', scale: 2 })),
  },
})
```

A field can stack more than one descriptor in a single `via(...)` call, and different fields can each declare their own feature(s) in the same `viaFields` map:

```ts
const invoices = vault.collection<Mixed>('invoices', {
  schema: z.object({
    id: z.string(),
    total: z.union([z.number(), z.string()]),
    note: z.record(z.string(), z.string()),
  }),
  viaFields: {
    total: via(money({ currency: 'EUR', scale: 2 })),
    note: via(i18nText({ languages: ['en', 'th'], required: 'all' })),
  },
})
```

### Sugar equivalence — existing spellings preserved

The feature-specific sugar keys (`moneyFields`, `i18nFields`, `dictKeyFields`) compile to the same internal bindings as `viaFields`, with identical stored envelopes and `describe()` output — verified byte-for-byte in `packages/hub/__tests__/via/compose.test.ts`:

```ts
// Sugar spelling (still works, identical internals):
const sugarCol = vault.collection<Invoice>('invoices', {
  schema,
  moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
})

// via() spelling (canonical):
const viaCol = vault.collection<Invoice>('invoices', {
  schema,
  viaFields: { total: via(money({ currency: 'EUR', scale: 2 })) },
})
```

Both produce the same declarations, byte-identical persisted records, and identical introspection (`describe()` output). Existing code using a sugar key continues without change; new code can use the composable `via()`/`viaFields` surface instead. Declaring the **same field** under both a sugar key and `viaFields` throws `ValidationError` naming the field — one declaration site per field.

## The phased write & read pipeline

All field features run in a **kernel-orchestrated phased pipeline**, pinned by the kernel to ensure cross-feature ordering and dependency correctness:

```
WRITE:  derive (C) → normalize (A) → validate (kernel) → encode (B) → store
READ:   load → decode (B) → present (A)
```

For each phase, features run in **declared stack order** (the order they appear in `via(...)`). The runner lives in the kernel; collection.ts calls it at the existing write/read call sites, replacing today's hand-wired money/i18n branches. Zero-via fields skip the runner entirely (identity fast path — no regression for plain documents).

The **feature stack order** is deterministic and pinned in one place (`compileViaBindings`). Today `collection.describe()` carries each feature's `describeFragment` contribution; surfacing the full per-field via-stack, phase order, declared dependencies, and staleness state is planned for phase C (the dependency graph makes those inspectable).

## Architecture guards & enforcement

The kernel enforces two new **architecture rules** (checked by `pnpm check:architecture` at build time — `via-layering` and `via-enclave-isolation`):

1. **`kernel` imports nothing from `via/*`** — all via-features are in the `via/` layer; the kernel holds only the port contract and runner. One frozen grandfather: `kernel/query/join.ts` imports i18n's `applyI18nLocale` from `via/i18n/core.js` for join-layer presentation (sync, i18n-text-only resolution of a joined right-side field) — issue #626 tracks converging it onto the Via seam instead.
2. **`via/*` never imports `kernel/enclave/`** — this rule bans importing the enclave, not "crypto.subtle directly": crypto should reach a feature only through a scoped context (`ViaCryptoCtx`). Phase B built `ViaCryptoCtx` (the kernel's `sealedSlots`/`reservedEnvelopes` capability factories, `kernel/enclave/record-keys/sealed-slots.ts`) and used it to reroute `via/i18n/dictionary.ts`'s `DictionaryHandle` off its former direct `kernel/enclave/index.js` import (the one grandfather this rule used to carry, predating #623) onto `reservedEnvelopes('_dict_')` — **the allowlist is now empty** and every `via/**` file, including the new `via-classified`/`via-blob`, is enclave-clean by construction — statically; the rule only bans a static `import ... from`. The reveal/verify engines reach the enclave through the Check-13-allowlisted (`enclave-classify-index-only`) dynamic strategy seam in `via/classified/active.ts` (`await import('../../kernel/enclave/classify/...')`), which Check 15 does not see.

`ViaCryptoCtx` is kernel-internal machinery for feature *authors* (a `ViaBinding`'s `encodeAtRest`/`decodeAtRest`/`erase` hooks receive it as a parameter — see `kernel/via.ts`) — not something a collection consumer calls directly. `sealedSlots` seals/unseals individual fields into their own `iv:data` slot under per-record key material (the mechanism `via-classified` seals recoverable fields with); `reservedEnvelopes(prefix)` is a whole-envelope encrypt/decrypt door scoped to collection names under a declared prefix, for reserved kernel-managed collections like `_dict_*` (see `packages/hub/__tests__/via/crypto-ctx.test.ts`).

## Implementation phases

The via-port lands in five phases, each with its own feature set, integration depth, and cross-repo governance:

| Phase | What | Status | Issues |
|---|---|---|---|
| **A** | Core port (contract, registry, pipeline runner), `via-money`, `via-i18n` (sugar compatibility) | Landed on `feat/623-via-port`, unreleased | #623 (milestone #28) |
| **B** | Security features: `via-classified`, `via-blob`; posture enforcement (query/export/forget); `ViaCryptoCtx` (`sealedSlots`/`reservedEnvelopes`) | Landed on `feat/629-via-phase-b`, unreleased | #629 (milestone #28) |
| **C** | Formula & graph: the `ViaGraph` dependency graph + taint algebra, `via-computed` (virtual + materialized), taint enforcement (fixes #636), sync/cutover/restore dispatch (fixes #621), frozen-output skip+audit (fixes #637), forget fanout (fixes #622) | Landed on `feat/638-via-phase-c`, unreleased | #638 (milestone #28) |
| **D** | Lookup layer: the `via-lookup` binding (`lookup`/`enum`/`dict`, three backing tiers, altKeys, vocabulary, `restrict`/`cascade`/`nullify` ref semantics) | Landed on `feat/650-via-phase-d`, unreleased | #650 (milestone #28) |
| **E** | External SPI — publish the contract; plugin sandboxing; posture non-forgeability | Deferred | TBD |

Each phase is self-contained; work in earlier phases does not block later ones. Phase A ships with zero via-features in the kernel — all behavior lives in the features themselves, tree-shaken away if unused.

Phase A's whole-branch review filed three follow-ups rather than blocking the phase — all **phase-A review follow-ups**, not new phases: **#625** (restore the index-accelerated `==`/`in` fast path for fixed-mode money `where()` clauses — the `indexProbe` hook), **#626** (converge `kernel/query/join.ts`'s join-layer i18n resolution onto the Via seam — see the grandfather note above), and **#627** (a `viaFields`-declared money field skips the late-attach reconcile when a collection is constructed twice before the declaration — the late-attach gap).

### Phase B — security features + posture enforcement

Phase B retrofits the two remaining security-sensitive field kinds — classified fields (`via/classified/`) and blobs (`via/blob/`) — as via-features, and makes every binding's declared `ViaPosture` (`encryptedAtRest`/`queryable`/`exportable`/`forgettable`) an *enforced* contract instead of documentation: the query DSL refuses a `queryable: 'none'` field (`FieldNotQueryableError`), `Vault.exportStream()`/`exportJSON()` deliberately redact a `exportable: false` field to the literal string `'[sealed]'`, and `vault.forget()` consults `forgettable` and folds each sealed-posture binding's `erase()` hook into its erasure report. See [`docs/subsystems/via-classified.md`](via-classified.md) and [`docs/subsystems/via-blob.md`](via-blob.md) for the per-feature detail — two things worth knowing before reading either:

- **`via-blob` is deliberately thin.** Blob content (chunked AEAD, per-blob key lifecycle) is real cryptographic engine work that the `via-enclave-isolation` rule forbids under `via/*` — so unlike `via-classified`, `via-blob`'s binding carries only declaration + posture + `describeFragment` + an `erase` hook; the content-crypto machinery stays service-side at `with-shape/blobs/` (unchanged, pre-dating the via port). `via-blob` declares no `encodeAtRest`/`decodeAtRest` hooks and never touches `ViaCryptoCtx`.
- **Two pieces of erase-hook wiring are real, tested, and stay production-dormant on purpose.** `via-classified`'s `erase()` hook is live for `_sealed`-slot shred/residue classification (`vault.forget()` routes through it whenever a `classifiedFields` binding is compiled in — see `forget-classified-erase.test.ts`), but its *sealed-CEK prefix-purge* participation (`purgeSealedCekEnvelopes`) is never wired in, and `via-blob`'s `erase()` hook (`purgeBlobsForRecord`) is never wired in at all. Both are proven (by the pre-existing `forget-sealed-erasure.test.ts`/`per-blob-cek.test.ts` suites) to be **vault-level operations, unconditional on any given collection declaring `classifiedFields`/`blobFields`** — routing them exclusively through a per-collection via binding would silently stop shredding for undeclared collections. `vault.forget()` keeps calling both directly (the sealed-CEK `_sealed_cek/*` prefix-delete, and `collection.blob(id).shredAllForRecord()`); the hooks themselves are unit-tested and wireable by a future, collection-scoping-aware caller. Making that scoping decision is a future product call, not a phase-B gap.

### Phase C — dependency graph, taint enforcement, sync dispatch, frozen-output, forget fanout

Phase C adds the one dependency graph every derived value flows through: `ViaGraph`
(`kernel/via-graph.ts`), a per-vault, kernel-owned model of *what depends on what* and *what
security posture a derived value inherits*. Every derivation/rollup/MV strategy, every `computed`
`deps` entry, and every `ViaBinding.deps` declaration registers into it at collection-declare time;
`assertAcyclic()` supersedes the derivation/MV registries' own local cycle-detection DFS with one
shared implementation.

**The taint algebra** (`foldPosture(a, b)`) folds two `ViaPosture`s to the strictest per-axis
result — `encryptedAtRest`: sealed wins over envelope; `queryable`: the least-capable rung on
`none < det-exact < ordered < full`; `exportable`: logical AND; `forgettable`: logical OR (a
forgettable source forces its derived field forgettable too):

```ts
foldPosture(CLASSIFIED, MONEY)
// { encryptedAtRest: 'sealed', queryable: 'det-exact', exportable: false, forgettable: true }
```

(from `packages/hub/__tests__/via/graph.test.ts` — 27 tests covering all four axes, transitive
chains, multi-source folds, cross-collection folds, and cycle rejection with correct
`DerivationCycleError`/`MaterializedViewCycleError` attribution). `effectivePosture(target)`
recurses through chained derivations (memoized); `taintedPostures(collection)` and
`taintSealedFields(collection)` scope that to one collection; `taintProvenance(collection)` names
which immediate source(s) forced a target away from `DEFAULT_POSTURE`; `dependentsOf`/
`derivedArtifactsOf` enumerate a collection's dependents for dispatch/erasure fan-out.

**Taint enforcement (#636)** makes the graph's fold *load-bearing*, closing the leak where a
`computed` field could silently copy a classified field's plaintext into an ordinary, unredacted
field. `ViaPipeline.postureFor(field)` now consults the graph's taint overlay first — the single
bridge that makes the existing query gate and `redactForExport` enforce it with zero new surface —
and a **materialized** derived field whose effective `encryptedAtRest` folds to `'sealed'` is
actually sealed at rest via the same `ctx.sealedSlots` capability `via-classified` uses; a
**virtual** one (never stored) is redacted on every `present()` instead. `describe()` surfaces each
tainted field's effective posture and provenance. See
[`docs/subsystems/via-computed.md`](via-computed.md#taint-propagation--inherits-the-strictest-source-posture-636)
for the full worked examples, the declare-time typo guard, its KNOWN LIMIT, and the
declaration-order asymmetry between the single-call and cross-call versions of that guard.
**BEHAVIOR CHANGE:** any existing `computed`-from-classified configuration now inherits the
classified posture — sealed at rest / non-exportable / non-queryable — where it previously did not;
this is a deliberate, pre-1.0 security fix (see the [changeset](../../.changeset/via-phase-c.md)).

### Formula-output posture (#642) — the #636-principle completion

#636/#638's taint enforcement covered a `computed` field's own declared `deps`; it left one gap
open, demonstrated live during the phase C whole-branch review: a with-formula edge
(derivation/rollup/MV) folds its effective posture from its source's whole-record `'*'` node, which
never carried a registered posture at all — it always fell back to `DEFAULT_POSTURE`, no matter how
classified the source collection was. A derive/rollup/MV `fn` receives DECRYPTED records by design
(`sealedAsHandles: false`), so a `fn` that copied a classified field's plaintext into its output
landed that plaintext UNSEALED — exportable, queryable, synced. **#642 closes it: every formula
output derived from a classified-bearing collection is now sealed at rest / non-exportable /
query-refused by default**, for both target shapes:

- **Rollup targets** (a REAL field on the parent, e.g. `buyers.total`) — inherits the fold
  automatically through the existing field-specific taint overlay; no separate opt-in.
- **Derivation/MV/overlay OUTPUT collections** (the whole-record `'*'` target) — a new
  collection-level `defaultPosture` fallback (`ViaTaintOverlay.defaultPosture`,
  `ViaPipeline.postureFor`'s O(1) fallback, no fold-per-call) seals every non-`_`-prefixed field of
  the output record (`taintBinding`'s `sealAllFields` mode; `_derivedFrom` and other reserved keys
  are explicitly excluded).

```ts
const people = v.collection<Person>('people', { classifiedFields: { ssn: ssnSpec() } })
const leaks = v.collection<Leak>('leaks')          // a plain derivation OUTPUT collection
await people.put('p1', { id: 'p1', name: 'Alice', ssn: '123-45-6789' })
;(await leaks.get('p1'))?.ssnCopy   // SealedHandle — sealed at rest, not plaintext
leaks.query().where('ssnCopy', '==', '123-45-6789')   // throws FieldNotQueryableError
```

(from `packages/hub/__tests__/via/formula-output-posture.test.ts`, Shape A — the derivation-output
case; Shape B pins the identical three surfaces — at-rest/query/export — for a rollup target).
**No migration story**: pre-1.0, no shipped consumer uses formula outputs today, so there is nothing
to migrate.

**Axis-scoped, not a blanket clamp.** The fold only tightens the axes a classified source can
actually justify — `encryptedAtRest` (sealed wins), `exportable` (AND), `forgettable` (OR, since a
forgettable source forces its derived output forgettable too) — `queryable` is left at the base
posture's own value and is never pulled down by a wildcard contributor. A blob/money/i18n-only
source (never classified) therefore never clamps a formula output's queryability — only its
`forgettable` bit may OR in:

```ts
// source collection has only a blob field (queryable:'none', forgettable:true) — no classified field
posture.queryable    // 'full' — NOT 'none'; blob does not propagate its own unqueryability
posture.forgettable  // true — BLOB's forgettable:true still ORs in
```

(`packages/hub/__tests__/via/wildcard-fold.test.ts`, "TRAP 2"). A `ref` edge's `'*'` source is
excluded from the fold entirely — the fold is kind-scoped to `derivation`/`rollup`/`mv`/`overlay`
edges only, not `ref`/`computed` — so a lookup-referencing field stays `DEFAULT_POSTURE` even when
its backing dimension has a classified field, keeping the countries-matrix recipe byte-identical
(`wildcard-fold.test.ts`, "TRAP 1").

**Explicit per-declaration declassification is deferred to phase E** — not built here; there is
currently no way to opt a formula output field back out of an inherited seal.

**KNOWN LIMIT — reconcile-path ordering gap.** The cross-collection re-apply
(`reapplyDependentOverlays`) that keeps an already-open dependent's overlay fresh when its source
registers a classified field late is wired at the fresh-`vault.collection()`-construction call site
only. A classified field attached to an already-open source via **reconcile** (a second
`vault.collection()` call on the same name, not a fresh open) does not refresh an already-open
DEPENDENT's stale overlay — only the reconciled collection's own overlay refreshes. Not covered by
any test; a follow-up candidate, not fixed in this pass. See also
[`docs/subsystems/via-computed.md`](via-computed.md) (its "Declare-time guard" section) for the
sibling KNOWN LIMIT on the `computed` side — a `deps` entry naming a real-but-**wrong** field still
passes construction and still leaks, since the guard only validates that `deps` names *some* known
field, not that it names the field `fn` actually reads. Both limits share the same root cause (no
runtime read-tracking or schema-aware dependency validation) and are candidates for the same future
fix.

**KNOWN LIMIT — the MV leg is currently theoretical for classified sources.** All three MV refresh
modes (eager/lazy/manual) pre-open their source collection during `openVault`'s
`_initMaterializedViews` (the spec's `query()` callback runs at registration time), and the
pre-existing classified retro-declare guard (`ClassifiedConfigError`, `collection.ts:1357`) then
refuses `classifiedFields` declared on that already-open source — so an MV over a classified source
is structurally unreachable today, even though the fold above would apply mechanically the moment
that ordering constraint ever lifts.

**Sync/cutover/restore dispatch (#621)** closes the gap where a sync-applied write never triggered
its derivations/materialized views — only a *local* `put()` did. A batched, per-target-deduped wave
(`kernel/via-dispatch.ts#runGraphDispatchWave`) now runs once at the end of `pull()`/`push()`
(`Vault._beginGraphBatch`/`_flushGraphBatch`, wired into `SyncEngine`), and also on schema cutover
and restore. Per-target dedup means N synced children of one rollup parent recompute the parent
exactly once, not N times; a collection with zero dependents in the graph is skipped entirely with
no decrypt (the same #553 zero-cost guarantee money/i18n-only collections already had). A
per-record-keyed source is decrypted with the correct id threaded through, not a default/wrong key.

```ts
// 3 synced sales sharing one rollup parent → exactly one wave-driven recompute, not 3
const pullResult = await dbB.pull('demo')
expect(computeCalls).toBe(2) // 1 wave-driven (deduped from 3) + 1 self-triggered cascade from its own write
```

(from `packages/hub/__tests__/via/sync-dispatch.test.ts`; the flipped choke-point pin —
`mutation-choke-point.test.ts`'s "sync-apply ... invalidates cache AND dispatches derivations" test
— is the exact parity pin phase A/B left as a documented gap, now closed).

**Sync-applied deletes now recompute rollup parents too (#640).** Before this pass,
`_invalidateSyncApplied` hardcoded every sync-applied mutation as a `'put'`, so a remotely-deleted
rollup child never recomputed its parent aggregate — only a *local* delete did
(`dispatchRollupsOnDelete`). The choke point (`with-party/team/sync.ts`'s `SyncEngine.applyRemote`)
now classifies each applied envelope as `'put'` or `'delete'` and threads the action through the
widened `cacheInvalidator` seam; `GraphBatch` gains a delete leg (`GraphTouch.deletes: Map<string,
readonly RollupDeleteIntent[]>`, ids/names only — no record payload, no key material); the dispatch
wave (`runGraphDispatchWave`) routes deleted ids to the SAME rollup-recompute trio a local delete
uses (batched, deduped per parent+field), never `dispatchDerivations`/MV-on-delete — mirroring the
`mutation-choke-point.test.ts:85-99` pin that a delete is dispatch-inert for derivations/MVs, both
locally and over sync:

```ts
// db2 pulls a delete of a rollup child from db1; orderCount is registered ONLY on db2
await db2.sync('demo')  // pull()
;(await db2Buyers.get('b1'))?.orderCount  // recomputed WITHOUT the deleted child — not stale
```

(from `packages/hub/__tests__/via/sync-delete-rollup.test.ts`). **KNOWN LIMIT — the miss scope.**
The deleted child's prior (pre-invalidation) value is read from the LRU/cache (`_peekCached`)
synchronously, right before the cache entry is dropped, so the parent-resolving intents can be
computed with no extra I/O. If that read misses — a **cold or evicted child** (lazy-mode LRU
eviction of the child before the sync-apply lands) **or an un-hydrated eager collection whose first
sync op for that child is a delete** (`ensureHydrated()` never ran, so the eager cache never held a
record to peek) — the miss is silent and freshness-only: that one child's rollup-parent intents are
skipped, no recompute happens for it, and no error is raised. Correctness is otherwise intact (the
recompute reads the REMAINING children from the store, so nothing double-counts); this is a
follow-up candidate, not fixed here. The sync-delete path also stays narrower than the local-delete
path by design: it recomputes only the rollup leg, not `dispatchMaterializedViewsOnDelete`/
`dispatchArrayDerivationsOnDelete` — both #640's issue text and the `mutation-choke-point.test.ts`
pin scope sync-delete dispatch to rollups only; wiring MV/array-derivation-on-delete into the
sync-delete wave is a candidate follow-up, not a regression of this pass.

**Riders.** `push()`/`pull()` now wrap `persistMeta()` in a `finally` that flushes the graph batch
even when `persistMeta()` throws — previously a throw there left `_graphBatch` open, silently
dropping that wave's touches until the next `begin()` replaced it (#644 item 1). Both the puts leg
and the new deletes leg of the dispatch wave additionally emit a structured
`'derivation:wave-error'` event (`{ collection, id, error }`) alongside the pre-existing
`console.warn` on a non-`PeriodClosedError` per-id failure, so a pull that completed with a failed
recompute is programmatically discoverable, not just logged (#644 item 3):

```ts
db.on('derivation:wave-error', (e) => { /* e.collection, e.id, e.error */ })
```

**Frozen-output rule (#637)**: before phase C, a derivation/rollup/MV output landing in a period
[closed](periods.md) threw `PeriodClosedError` straight through the *legal source write* that
triggered the recompute. Now every output-write call site — live local-write dispatch,
`vault.deriveAll()`, `vault.refreshView()`, and the sync dispatch wave — routes through
`putDerivedOutput`, which **skips** the write (the historical output stands) and emits a structured
`'derivation:skipped-frozen'` event (plus a `'lifecycle'` audit-ledger entry when `withHistory()` is
active) instead of throwing:

```ts
db.on('derivation:skipped-frozen', (e) => events.push(e))
await expect(sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })).resolves.toBeUndefined()
expect(events[0]).toMatchObject({ source: { collection: 'sales', id: 's1' }, target: { collection: 'buyers', id: 'b1' }, period: 'FY2026-Q1' })
expect((await buyers.get('b1'))?.totalSpent).toBe(beforeTotal) // unchanged — skipped, not partially applied
```

(from `packages/hub/__tests__/derivations/frozen-output.test.ts`). In the sync dispatch wave
specifically, one frozen target in a multi-record batch does not abort the whole `pull()`/`push()`
or starve a co-batched healthy target; a *non*-`PeriodClosedError` throw from one touched record is
likewise isolated per-id (surfaced via `console.warn`, not silently swallowed, not aborting the
wave) — both pinned in the same test file's wave-specific describe block. `vault.deriveAll()`'s
result gained an additive `skippedFrozen` counter, distinct from `derived` (a frozen-skip is not
counted as a successful write).

**Forget fanout (#622)**: `vault.forget()` now asks the graph (`derivedArtifactsOf`) for the
forgotten record's derived artifacts and fans out. **Record-grain** artifacts — MV rows, array-shape
derivation rows, same-id record-shape derivation copies — are **erased**. **Aggregate-grain**
rollups are **recomputed** without the forgotten contribution in open periods, or **skip + audit**
(via the same `putDerivedOutput`/frozen-output machinery above) in closed ones — the subject's own
record is still fully shredded either way, independent of the aggregate freeze:

```ts
const result = await vault.forget('subj-1')
expect((await buyers.get('b1'))?.totalSpent).toBe(50)       // recomputed without the forgotten sale
expect(result.derivedAggregatesRecomputed).toBe(1)
expect(result.recordsShredded).toBe(1)
```

(from `packages/hub/__tests__/via/forget-fanout.test.ts` — the seam map's finding that no test
anywhere combined forget × derivation/MV becomes this file's first coverage). `ForgetResult` gains
three additive fields: `derivedRecordsErased`, `derivedAggregatesRecomputed`,
`derivedResidueFrozen: readonly string[]` (`"${collection}:${id}"` entries for each skipped
aggregate) — all pre-existing `ForgetResult` fields are byte-shape-unchanged (pinned by a full
key-snapshot test).

See [`docs/subsystems/via-computed.md`](via-computed.md) for the `computed(fn, { deps, mode })`
feature itself — declaring fields, virtual vs. materialized semantics, composition with other
features, the declare-time guard and its known limit, and the binding architecture.

### Phase D — the lookup layer: `lookup`/`enum`/`dict`, altKeys, vocabulary, ref semantics

Phase D (#650) collapses the legacy `dictKey()`/`staticDict()` code-field pattern and a
first-class reference-collection pattern into **one** `'lookup'` `ViaBinding` with three backing
tiers (enum: inline keys, no store; dict: a reserved `_dict_<name>` micro-collection; matrix: a
first-class collection like `countries`). `dictKey()`/`staticDict()` become **aliases** onto this
binding — byte-identical stored envelopes, `describe()` output, and join dressing, locked by
`packages/hub/__tests__/via/lookup-alias-parity.test.ts`. New capability the aliases don't have:
`altKeys` (candidate values that normalize to a canonical key on `ingest`, e.g. an ISO3 code
normalizing to its ISO2 canonical), `vocabulary: 'closed'` write-time membership refusal (closing
#649, where the dictKey doc comment promised this and the code didn't do it), and
`restrict`/`cascade`/`nullify` reference semantics on delete and `forget()` (closing #648, where
`DictKeyInUseError` was declared, documented, and never thrown). #647 additionally makes reserved
(`_dict_*`) collections participate in sync for the first time — they used to bypass the mutation
choke point and the dirty log entirely, so dictionary edits never crossed `push()`/`pull()`, only
backup/bundle export.

Task 6 also retires the #626 kernel→via grandfather: `kernel/query/join.ts` no longer imports
`via/i18n/core.js` directly for join-layer locale resolution — it calls a sync
`presentForJoin` hook the `Collection` builds from its own i18n + lookup bindings instead. Task 7
extends that same sync snapshot+locale seam to the matrix tier (Task 6 had only wired reserved
tier) and wires `ViaBinding.describeFragment` — declared since #623, zero consumers until now —
into `describe()`'s new normalized `lookup` block. Both architecture guards this phase touches
(`via-layering`, `via-enclave-isolation`) end the phase with **empty** allowlists, each proven to
still fire on a synthetic violation (`via-guards-empty.test.ts` — both guards' synthetic-fire
proofs live in one file, merged #650 whole-branch fix wave to remove a shared-working-tree race
between two subprocess-driven test files).

See [`docs/subsystems/via-lookup.md`](via-lookup.md) for the full feature — tiers, altKeys,
vocabulary, presentation/join-dressing, sorting, reference semantics, reserved-tier sync, and the
`describe()` `lookup` block, all backed by `packages/hub/__tests__/via/countries-matrix.test.ts`'s
canonical countries-matrix example.

### Milestone #31 — late-attach parity, cycle detection at declare time

Five follow-up fixes, landed together on one branch, close gaps the phase A-D reviews surfaced.

**Late-attach (reconcile) parity for i18n/dictKey/lookup (#664).** A SECOND-OR-LATER
`vault.collection(name, {...})` call against an already-open collection ("late attach" /
"reconcile") always supported `moneyFields`/`computed`/`fieldMeta`/`meta`/`classifiedFields` — but
`i18nFields`/`dictKeyFields`/`lookupFields` on that same kind of call were silently ignored before
this fix, with no error. `kernel/via-reconcile.ts` closes the gap by rebuilding the collection's
`ViaPipeline` in place (`Collection._setVia`, the writer seam #666 added for exactly this). Every
tier attaches, with one deliberate exception: a lookup field backed by another first-class
collection (the "matrix" tier) REFUSES to late-attach unless that backing collection is already
open, in this vault session, in eager (prefetch-enabled) mode — a clear `ValidationError` at
declare time beats a confusing failure the first time a query touches the field. **The collision
guard** that already ran at fresh construction (refusing two via families claiming the same field)
now also runs on every late-attach call, both within the incoming call's own fields and against
the collection's already-declared fields — no partial attach on a collision. See
[`docs/subsystems/via-lookup.md`](via-lookup.md#late-attach-reconcile--tier-scoped-664) for the
full tier-by-tier story, the collision guard's exact behavior, and three known late-attach
residuals (`describeAsync({resolveDictLabels:true})`, `describe()`'s legacy top-level field list,
and join-side `presentForJoin` dressing — each captured once at fresh construction and not
re-derived by a later reconcile call).

**Declare-time mutual-rollup cycle refusal (#639).** Two (or more) `withRollup()` strategies whose
targets mutually depend on each other (collection A rolls a value into B's field `x`; B rolls a
value into A's field `y`) used to be silently *declarable* — the cycle was invisible to
`ViaGraph.assertAcyclic()`'s traversal, because a rollup's target is a real field node that the
graph writes into but never reads FROM, so the depth-first search dead-ended on it instead of
looping back. The fix teaches `assertAcyclic`'s traversal (not the graph's stored edges — a
purely traversal-local expansion, so no new edge is materialized and no posture-folding input
changes) that writing a real field on a collection is *also* a write to that collection: visiting
field node `(C, f)` now additionally expands the edges sourced at `(C, '*')`, closing the missing
reachability step. The refusal fires at `Noydb.openVault()` time (not at `withRollup()`
construction, and not at a later `.collection()` call) — every derivation/MV strategy validates
against the graph during vault open — and throws `DerivationCycleError`, the same class every
other declare-time cycle (a plain derivation loop, an MV cycle) already throws:

```ts
const bRollsUpA = withRollup({ from: 'a', key: 'aId', into: 'b', field: 'x', compute: () => 0 })
const aRollsUpB = withRollup({ from: 'b', key: 'bId', into: 'a', field: 'y', compute: () => 0 })
const db = await createNoydb({ store, user, secret, derivationStrategies: [bRollsUpA, aRollsUpB] })
await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
```

(from `packages/hub/__tests__/derivations/rollup.test.ts`, "mutual/rotating cycle refusal at
declare time" — covers a 2-collection mutual cycle, a 3-collection rotation, and an acyclic chain
control that still resolves). Scope is deliberately narrow: a rollup-shaped cycle only (field→`'*'`
containment); the symmetric `'*'`→field expansion that would catch an exotic whole-record-
derivation-output↔field-computed cycle was evaluated and explicitly NOT built — it would tighten
detection to full write-reachability and risk rejecting derivation+computed graphs that pass
today, a broader behavior change than this issue asked for. No runtime depth/reentrancy guard was
added either — this is a declare-time sentinel fix, not a runtime cycle breaker.

**Computed-first present order (#665)** — see
[`docs/subsystems/via-computed.md`](via-computed.md#present-order-665--computed-runs-before-dressing-after-money)
for the full story: a virtual `computed` field's output now exists before i18n/lookup's dressing
`present()` hooks run on it (previously dressing ran first and found nothing to dress), with money
carved out to keep its own pre-#665 present position (money DECODES its input, unlike i18n/lookup
which only ADD a `Label`/`Formatted` key — running money after a virtual computed on the same
field would misread the computed field's raw major-unit output as a stored scaled-int).

**Bare-array lookup fields (#661)** — see
[`docs/subsystems/via-lookup.md`](via-lookup.md#bare-array-fields--element-wise-support-661): a
plain field whose own value is an array (not the pre-existing `[].`-wildcard multi-value path) now
gets the same element-wise altKey normalization and closed-vocabulary enforcement as every other
lookup shape, including at a dotted (non-wildcard) path.

**`indexProbe` — the index-accelerated fast path restored for fixed-mode money `where()` (#625)**
— see [`docs/subsystems/via-money.md`](via-money.md#indexing--the-fast-path-and-an-honest-mixed-era-caveat-625):
an optional `ViaBinding.indexProbe(op, payload)` hook lets a binding hand the query builder a
STORED-form operand for a direct index bucket lookup on `==`/`in`, restoring the fast path phase A
originally lost for money fields (multi-currency money and every other operator still scan — there
is no single stored-form value a hash index can serve for those). Ships with an honest mixed-era
caveat for pre-money-declaration legacy data (documented on the money page).

## See also

- [`docs/superpowers/specs/2026-07-10-via-port-design.md`](../superpowers/specs/2026-07-10-via-port-design.md) — full phase A design spec
- [`docs/superpowers/specs/2026-07-11-via-phase-b-design.md`](../superpowers/specs/2026-07-11-via-phase-b-design.md) — full phase B design spec
- [`docs/superpowers/specs/2026-07-11-via-phase-c-design.md`](../superpowers/specs/2026-07-11-via-phase-c-design.md) — full phase C design spec
- [`docs/subsystems/via-money.md`](via-money.md) — money feature docs
- [`docs/subsystems/via-i18n.md`](via-i18n.md) — i18n feature docs
- [`docs/subsystems/via-classified.md`](via-classified.md) — classified feature docs
- [`docs/subsystems/via-blob.md`](via-blob.md) — blob feature docs
- [`docs/subsystems/via-computed.md`](via-computed.md) — computed feature docs (virtual + materialized)
- [`docs/subsystems/via-lookup.md`](via-lookup.md) — phase D: lookup feature docs (`lookup`/`enum`/`dict`)
- `packages/hub/src/kernel/via.ts` — the port contract and kernel runner (incl. `ViaCryptoCtx`, `ViaEraseCtx`/`ViaEraseReport`, `resolveOrderLabel`)
- `packages/hub/src/kernel/via-pipeline.ts` — the phased runner (incl. `postureFor`, `redactForExport`, `eraseSealed`, `describeFragments`)
- `packages/hub/src/kernel/via-compose.ts` — the `via()` composer + sugar/`viaFields` merge
- `packages/hub/src/kernel/enclave/record-keys/sealed-slots.ts` — `ViaCryptoCtx`'s kernel-side capability factories
- `packages/hub/src/kernel/via-graph.ts` — phase C: the `ViaGraph` dependency graph + taint algebra
- `packages/hub/src/kernel/via-dispatch.ts` — phase C: sync/cutover/restore batched dispatch wave, `putDerivedOutput`, forget fanout
- `packages/hub/src/kernel/via-taint-binding.ts` — phase C: the taint-enforcement `ViaBinding`
- `packages/hub/src/via/money/` — phase A: money binding
- `packages/hub/src/via/i18n/` — phase A: i18n binding
- `packages/hub/src/via/classified/` — phase B: classified binding
- `packages/hub/src/via/lookup/` — phase D: the lookup binding (descriptors, registry, snapshot, handle)
- `packages/hub/src/via/blob/` — phase B: blob binding
- `packages/hub/src/via/computed/` — phase C: computed binding
- `packages/hub/__tests__/via/formula-output-posture.test.ts` — the #642 formula-output posture
  suite (both target shapes × three surfaces + the ordering gap)
- `packages/hub/__tests__/via/wildcard-fold.test.ts` — the #642 `ViaGraph` `'*'`-fold unit suite
  (axis-scoping, kind-scoping, the ref-identity/blob traps)
- `packages/hub/__tests__/via/sync-delete-rollup.test.ts` — the #640 sync-applied-delete rollup
  recompute suite (dedup/ordering/freshness + the `derivation:wave-error` event)
- `packages/hub/src/kernel/via-reconcile.ts` — milestone #31: the late-attach reconcile dispatch
  (i18n/dictKey/lookup, #664)
- `packages/hub/__tests__/via/reconcile-lookup.test.ts`, `reconcile-i18n-dictkey.test.ts`,
  `reconcile-guard.test.ts` — milestone #31: the #664 late-attach suites (tier coverage, collision
  guard, combined-family single-call attach)
- `packages/hub/__tests__/via/graph.test.ts`, `packages/hub/__tests__/derivations/rollup.test.ts`
  — milestone #31: the #639 mutual-rollup declare-time cycle refusal suites
