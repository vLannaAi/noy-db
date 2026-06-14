# derivations

> **Subpath:** `@noy-db/hub/derivations`
> **Factory:** `withDerivation()`
> **Cluster:** C — Derived data
> **LOC cost:** ~preview (off-bundle when not opted in)
> **Status:** preview, ships in 0.1.0-pre.11

## What it does

`withDerivation` lets a vault declare deterministic data derivations of one or
more typed outputs from a source record. The derive function runs on plaintext
(after DEK unwrap, inside the encrypted boundary) and its outputs are encrypted
with the same DEK before reaching the store — listing the storage backend
cannot reveal the derivation graph.

## When you need it

- Splitting a large source record into derived projections for faster reads
  (e.g. PDF source → extracted metadata + searchable text)
- Materialized side-data that must stay encrypted under the same DEK as its
  source
- Workflows where some outputs are expensive (lazy) and others cheap (eager)
- Bulk recompute paths after a strategy change (`vault.deriveAll`)

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withDerivation } from '@noy-db/hub/derivations'

const pdfDerivation = withDerivation<Pdf, { meta: PdfMeta; text: PdfText }>({
  source: 'pdfs',
  deterministic: true,
  outputs: {
    meta: { shape: 'record', collection: 'pdf-meta' },
    text: { shape: 'record', collection: 'pdf-text' },
  },
  derive: (pdf) => ({
    meta: { len: pdf.body.length, pages: pdf.pages.length },
    text: { content: extractText(pdf.body) },
  }),
  lifecycle: 'eager', // or 'lazy'
})

const db = await createNoydb({
  store: ...,
  user: ...,
  derivationStrategies: [pdfDerivation],
})
```

## API

### `derive(source, ctx)` and the read-only vault facade

The `derive` function receives a second argument: a `DerivationContext`
carrying the same `ReadOnlyVaultFacade` guards see as `ctx.vault`. Use it
to fetch sibling records without denormalising them onto the source row.

```ts
withDerivation<Allocation, { receipt: Receipt }>({
  source: 'allocations',
  deterministic: true,
  outputs: { receipt: { shape: 'record', collection: 'receipts' } },
  derive: async (alloc, ctx) => {
    const payment = await ctx.vault.collection<Payment>('payments').get(alloc.paymentId)
    const bill = await ctx.vault.collection<Bill>('bills').get(alloc.billId)
    return {
      receipt: {
        id: alloc.id,
        paymentId: alloc.paymentId,
        issuedAt: payment!.paymentDate,
        clientId: bill!.clientId,
        appliedAmount: alloc.appliedAmount,
      },
    }
  },
  lifecycle: 'eager',
})
```

`ctx.vault` exposes `.get(id)`, `.list()`, and `.query()` — no write
capability is reachable from the facade. The strategy hash incorporates
`derive.toString()`, so the function source pins the inputs; whatever
sibling reads happen inside `derive` must be deterministic given the
same source record (the consumer's responsibility — the hash does not
fingerprint sibling-record content).

Available on both lifecycles: the eager dispatch and the lazy
resolve-on-read paths both pass the same facade.

### Declared sibling sources (#344)

`sources: ['a', 'b']` declares sibling collections whose writes re-fire
this derivation. A write to any declared sibling re-runs `derive`
against the PRIMARY `source` record at the SAME id (a silent no-op if no
primary record exists there). Siblings participate in cycle detection.

```ts
withDerivation<Allocation, { receipt: Receipt }>({
  source: 'allocations',
  sources: ['payments', 'bills'],  // sibling writes re-derive at the same id
  deterministic: true,
  outputs: { receipt: { shape: 'record', collection: 'receipts' } },
  derive: async (alloc, ctx) => ({ /* … */ }),
  lifecycle: 'eager',
})
```

This retires the hand-rolled "poke a sibling" pattern (writing a no-op
back to the source to force a re-derive when a referenced record
changed).

### FK-keyed triggers — reverse-denormalization (#376)

`sources[]` re-fires at the **same id**. `triggerBy` re-fires keyed by a
**foreign key**: a write to a PARENT collection fans out to every source
record whose FK matches the parent's id. The canonical use is keeping a
denormalized field on the children in sync with a parent change.

```ts
withDerivation<Sale, { self: Sale }>({
  source: 'sales',
  deterministic: true,
  // A write to buyers re-derives every sale where sale.buyerId === buyer.id.
  triggerBy: [{ collection: 'buyers', on: 'buyerId' }], // `on` = the FK ON the source
  // Self-write: patch ONLY buyerName back onto the sale (field-level provenance).
  outputs: { self: { shape: 'record', collection: 'sales', denorm: ['buyerName'] } },
  derive: async (sale, ctx) => {
    const b = await ctx.vault.collection<Buyer>('buyers').get(sale.buyerId)
    return { self: { ...sale, buyerName: b?.companyName ?? null } }
  },
  lifecycle: 'eager',
})
```

- **Self-write + `denorm`.** A record output whose `collection` equals the
  `source` is a *self-write* and MUST declare `denorm: [...]`. Only those
  fields are merged onto the **raw stored record** — the rest of the user's
  record (and any i18n maps) is never clobbered, and no whole-record
  `_derivedFrom` tag is added (the record stays user-owned). The self-write
  edge is exempt from cycle detection; a **value-equality guard** breaks the
  recursion: when the patch changes nothing, no write is issued.
- **Fan-out cost.** The match runs through the FK index when the source
  declares `indexes: ['<on>']` (O(matching rows)); otherwise it scans
  (O(N) — fine for small child sets; index the FK to scale). An optional
  `maxFanout` on the trigger entry throws `DerivationCapExceededError`
  before any write.
- `triggerBy.collection` must differ from `source`; `on` is required.

### Rollups — aggregate onto a parent field (#376 slice 2)

`withRollup` is the inverse of a join: instead of reading children on
demand, the parent carries a **maintained summary** folded from its
children by foreign key. It recomputes on child insert, update, AND
delete — gap-free.

```ts
import { withRollup } from '@noy-db/hub/derivations'

withRollup<Sale, Buyer>({
  from: 'sales',          // child collection (the trigger)
  key: 'buyerId',         // FK on the child → parent id
  into: 'buyers',         // parent collection
  field: 'revenueByYear', // field on the parent to maintain
  compute: (sales) => groupSumByYear(sales, 'total'),
})
```

- On a `from` write/delete the parent at id `child[key]` is recomputed:
  `compute(children where child[key] === parentId)` is patched onto
  `parent[field]`. A parent write also recomputes its own aggregate, so a
  **parent created after its children** still fills in.
- Only `field` is patched onto the parent's raw record (other fields and
  i18n maps untouched); a value-equality guard suppresses no-op writes.
- The aggregate gathers children through the FK index when the `from`
  collection declares `indexes:[key]` (O(children)), else a scan.
- Eager-only in this slice. Desugars to a derivation carrying a `rollup`
  marker; dispatch handles it without the executor.

> **Why not a materialized view?** An MV aggregates children into a
> *parallel* collection (`buyer-totals.get(id)`); it cannot write the
> aggregate onto a field of the parent `buyers` record. `withRollup` does.

> **Scope (#376).** Slice 1 = `triggerBy` reverse-denormalization; slice 2
> = `withRollup` (this section) + rollup-on-delete. `vault.forget()` does
> not auto-re-derive (it bypasses the put path) — recompute explicitly if a
> forgotten record must drop out of an aggregate.

### Optional outputs (#144)

Declare an output as `optional: true` to let `derive` return `null` for
that key:

```ts
outputs: {
  receipt: { shape: 'record', collection: 'receipts', optional: true },
},
derive: (alloc) => ({
  receipt: alloc.servicesNetPortion > 0
    ? { id: alloc.id, paymentId: alloc.paymentId, appliedAmount: alloc.appliedAmount }
    : null,
})
```

Semantics:

- `null` (or `undefined`) for an optional output → no write fires.
- If a previous derivation emitted an output at this id, it's **deleted**
  (tombstone for derived data). The eager path captures the prior
  envelope on the active TxContext so the delete rolls back alongside
  the source op on transaction failure (#133).
- A never-emitted optional output is a silent no-op.
- Returning `null` for a required output (default — no `optional` flag)
  still throws `DerivationOutputShapeError`.

Same behavior on eager and lazy lifecycles, and through `vault.deriveAll()`.

#### Tombstone-vs-onDelete composition

A tombstone is a **system-internal** delete: the derivation engine
revoking its own prior emission because the source flipped to the
"no output" branch. User `onDelete` guards registered on the output
collection are **not** consulted on tombstones — same way amendments
bypass user-facing hooks. If they fired, a consumer registering both
(a) an `optional: true` derivation and (b) an `onDelete: () => throw`
on the output collection would deadlock: every flip-to-null source
write would block on the user's own append-only rule.

Concretely: if you ship a `paymentAllocation → receipt` derivation with
`optional: true`, AND `receipts.onDelete: throw` for legal-document
immutability, **the tombstone bypass keeps both coherent**. Users can
no longer manually delete a receipt (good), and the system can still
revoke its own prior emission when the underlying allocation
restructures (also good).

The bypass is scoped to the system-internal delete path
(`Collection._internalDelete`); a user-initiated `Collection.delete`
on the same record still fires `onDelete` normally.

### Lifecycles

- **`eager`** — derive runs synchronously inside the source-write transaction.
  Outputs are written via the same `Collection.put` pipeline. Recommended for
  small, fast derive functions.
- **`lazy`** — source-write marks output ids stale; first read of any output
  triggers the derive. Recommended when the derive is expensive and most
  sources are written without being read.

### Strict vs non-strict

Default (`strict: false`): per-output failures are isolated. Other outputs
commit; the failed output is absent from the store and re-attempts on next
`vault.deriveAll`.

`strict: true`: a single output failure rolls back the source write (only
when wrapped in `withTransactions`). Use for outputs that must remain
consistent with the source.

### `vault.deriveAll(collection)`

Re-derive every record in the named source collection. Useful after a strategy
change (the strategyHash mismatch forces a recompute on next visit, but
`deriveAll` is the explicit bulk path).

```ts
const { derived, failed } = await vault.deriveAll('pdfs')
```

### `_derivedFrom` metadata

Every derived record carries:

```ts
{
  _derivedFrom: {
    source: 'pdfs',
    sourceId: 'abc',
    sourceVersion: 3,
    derivedAt: '2026-05-18T...',
    strategyHash: 'sha256-...', // changes when the strategy changes
  }
}
```

`strategyHash` is the v1 mechanism for detecting strategy drift: a record
whose hash doesn't match the current strategy is recomputed by
`vault.deriveAll`.

### Composition order

Derivations fire **after** the store write and ledger append. A guard that
blocks a source write also blocks the derivation that would have fired from
it.

```
Collection.put
  1. Permission check
  2. GuardRegistry.check
  3. Encrypt + store.put
  4. Ledger append
  5. DerivationRegistry           ← this doc
```

### Errors

All extend `NoydbError`:

- `DerivationCycleError(path[])` — graph contains a cycle
- `DerivationDepthError(limit, attempted)` — cascade exceeded `maxDepth`
- `DerivationOutputUnknownError(collection)` — output collection unknown
- `DerivationOutputShapeError(outputKey, detail)` — derive returned wrong shape

## Behavior when NOT opted in

- `createNoydb({ derivationStrategies: [...] })` is the only way to register
  derivations; without it, no derive function fires
- `vault.deriveAll(collection)` throws with a pointer to
  `@noy-db/hub/derivations`
- `DerivationCycleError` / `DerivationDepthError` /
  `DerivationOutputUnknownError` / `DerivationOutputShapeError` are still
  importable from `@noy-db/hub/derivations` but are never thrown by core

## Pairs well with

- **guards** — guards run before encryption; a blocked source write
  short-circuits the derivation that would have fired
- **transactions** — `strict: true` derivations require `withTransactions` so
  output failures can roll back the source write
- **history** — every committed derivation output fires its own ledger entry
  through the standard `Collection.put` pipeline

## Edge cases & limits

### Zero-knowledge guarantee

The derive function executes after DEK unwrap, on plaintext. The store never
sees plaintext. Outputs are encrypted with the same DEK as the source before
they reach the store. `_derivedFrom` metadata lives inside the encrypted
payload, not in the plaintext envelope.

### Cycle detection

Cyclic graphs (A → B → A, self-loops, etc.) are rejected at `vault.openVault`
with `DerivationCycleError`. The graph is the union of every strategy's
source + output collection set.

### Behavior notes

- **Lazy stale-tracking is in-memory only in v1.** A vault close-and-reopen
  loses pending stale flags. Derived records with a matching `strategyHash`
  are treated as fresh; `vault.deriveAll()` is the explicit recompute path
  after strategy changes.
- **`sourceVersion: 0` on bulk recomputes.** `vault.deriveAll()` and the
  lazy-resolution path stamp `_derivedFrom.sourceVersion = 0` because the
  envelope `_v` isn't easily plumbed through `Collection.list()`. v2 may
  thread the version through.
- **Recursion guard.** The dispatch hook in `Collection.put` skips when the
  incoming record carries a `_derivedFrom` field — a defense-in-depth check
  alongside the openVault cycle validator.

### Deferred to v2

- Cache-tier backends (`to-cache-*`)
- Built-in derivers (PDF, image, etc.)
- Scheduled / cron-style refresh
- Non-deterministic derivations with persistence
- External / sandboxed derivation runtimes
- Public CDN derivations
- Streaming materialized views (over Dim 12)
- Stale-flag persistence across vault close
- Per-record `sourceVersion` in bulk recompute paths

See the spec for the full deferred list.

## Materialized Views

> **Factory:** `withMaterializedView()`
> **Subpath:** `@noy-db/hub` (re-exported)
> **Spec:** `docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md`

`withMaterializedView` (v2) is the query-level companion to v1's
record-level `withDerivation`. Where `withDerivation` projects one
source row into N typed outputs, `withMaterializedView` materializes
the result of an entire `Query<T>` — filter, groupBy, aggregate, join
— into a queryable collection that is kept fresh on source writes.

```ts
import { withMaterializedView, sum, count } from '@noy-db/hub'

const pnd1 = withMaterializedView<Pnd1Row>({
  name: 'pnd1',
  query: (db) =>
    db.collection<Compensation>('compensations')
      .query()
      .groupBy('clientId')
      .aggregate({ tax: sum('taxAmount'), count: count() }),
  rowKey: (row) => row.clientId,
  sources: ['compensations'],  // required for aggregate / groupBy
  refresh: 'eager',
})
```

### Strategy fields

| Field | Required? | Meaning |
|-------|:---------:|---------|
| `name` | yes | Stable identity. Default output collection name. |
| `query: (db) => Query<TRow>` | yes | Materialized query, run at registration + every refresh. |
| `rowKey: (row) => string` | yes | Stable id derivation. Explicit — no default. |
| `refresh: 'eager' \| 'lazy' \| 'manual'` | yes | Refresh policy (see below). |
| `sources?: string[]` | only for aggregate / groupBy | Explicit dependencies. Plain `Query<T>` shapes are auto-analyzed. |
| `predicates?: { ... }` | no | Declared deterministic predicates (see § below). |
| `output?: { collection?, partition? }` | no | Custom output name + same-collection partition discriminator. |
| `onEmpty?: 'delete' \| 'keep'` | no, default `'delete'` | What to do when re-materialization yields zero rows for a previously-emitted key. |
| `strict?: boolean` | no, default `false` | Re-throw row-write failures to enable transactional rollback. |
| `maxRows?: number` | no, default `100_000` | Row-count ceiling; throws `MaterializedViewTooLargeError` before any writes. |

### Multi-key groupBy in MV queries

The `query` callback can use multi-key `groupBy(...fields)` the same
way any other `Query<T>` can. The `rowKey` callback then composites
the grouped fields into a stable id — the choice of encoding is
yours, but it must be deterministic:

```ts
withMaterializedView<Pnd1Row>({
  name: 'pnd1-by-period',
  query: (db) =>
    db.collection<Compensation>('compensations')
      .query()
      .groupBy('clientId', 'period')
      .aggregate({ tax: sum('taxAmount') }) as unknown as Query<Pnd1Row>,
  rowKey: (row) => `${row.clientId}|${row.period}`,  // composite id
  sources: ['compensations'],
  refresh: 'eager',
})
```

The deep mechanics of multi-key buckets (field-order invariance,
cardinality ceilings) live in
[`aggregate.md` § Multi-key groupBy](./aggregate.md#multi-key-groupby).
The walkthrough lives in showcase
[`85-with-multikey-groupby`](../../showcases/src/85-with-multikey-groupby.showcase.test.ts).

### UNION sources — `withMaterializedView` reading from multiple collections

A materialized view can read from MULTIPLE sibling source collections in
ONE declaration via `unionSources`. Per-source `map` projects each arm
into the MV's row shape; `groupBy` + `aggregate` then run on the
concatenated stream.

```ts
withMaterializedView<{ period: string; vat: number }>({
  name: 'monthlyVat',
  unionSources: [
    { collection: 'taxReceipts', map: r => ({ period: r.issuedAt.slice(0, 7), vat:  r.vatAmount }) },
    { collection: 'creditNotes', map: r => ({ period: r.issuedAt.slice(0, 7), vat: -r.vatAmount }) },
  ],
  groupBy: 'period',
  aggregate: { vat: sum('vat') },
  rowKey: row => row.period,
  refresh: 'eager',
})
```

**Mutually exclusive with `query`** — a strategy uses one or the other.
Registration rejects strategies that declare both, or neither, or
`unionSources` with fewer than 2 arms, or duplicate collection names
across arms.

**Per-source `map` is the schema-unification boundary.** The two source
collections may have different schemas; each arm's `map` projects to the
MV's row shape (the strategy's type parameter). The hub does NOT compare
schemas across arms — consumer responsibility is that every `map` returns
the same shape.

**Source-write hooks fire on every arm.** A write to ANY collection in
`unionSources` re-fires the MV refresh path. Naturally visible via the
registry's dependency reverse-index.

**Composes with multi-key `groupBy`.** UNION arms can roll up to a
composite key — e.g. `groupBy: ['clientId', 'period']` over taxReceipts ∪
creditNotes produces one row per (client, period) tuple.

**Exact money aggregation — `moneyFields` (#350).** Add a `moneyFields`
map on the union-form strategy to make `sum`/`min`/`max` over the
declared (mapped/aggregated) money fields exact BigInt, matching the
query-form path. Without it, union-MV money sums drift in float. Each
arm's `map()` should emit the raw decoded money value for those fields.

```ts
withMaterializedView<{ period: string; vat: MoneyString }>({
  name: 'monthlyVat',
  unionSources: [
    { collection: 'taxReceipts', map: r => ({ period: r.issuedAt.slice(0, 7), vat:  r.vatAmount }) },
    { collection: 'creditNotes', map: r => ({ period: r.issuedAt.slice(0, 7), vat: -r.vatAmount }) },
  ],
  moneyFields: { vat: true },   // exact BigInt sum/min/max
  groupBy: 'period',
  aggregate: { vat: sum('vat') },
  rowKey: row => row.period,
  refresh: 'eager',
})
```

**Per-arm `join` (#347).** Each `unionSources` arm may declare
`join: [{ field, as }]` to attach a right-side record under an alias
before `map()` runs — the same `ref()`-driven resolution as query-form
`.join()`. The right-side collections must be listed in `sources[]` so
their writes trigger refresh.

```ts
unionSources: [
  {
    collection: 'taxReceipts',
    join: [{ field: 'clientId', as: 'client' }],  // resolves via ref()
    map: r => ({ period: r.issuedAt.slice(0, 7), vat: r.vatAmount, clientName: r.client.name }),
  },
  // …
],
sources: ['clients'],  // right-side collections, for refresh tracking

**Known gap (pre.14 hangover):** `Collection.delete` does NOT yet trigger
eager MV refresh — only `put` does. UNION (and single-source) MVs with
`onEmpty: 'delete'` re-tombstone on the next `put` to any source, or via
`vault.refreshView('mvName')`. A follow-up PR will wire delete-time
dispatch.

See showcase [`86-with-union-mv`](../../showcases/src/86-with-union-mv.showcase.test.ts).

### Refresh modes

- **`eager`** — every source write re-runs the query inside the same
  transaction. Outputs land synchronously. Pairs with `withTransactions`
  + `strict: true` for atomic source-and-MV updates.
- **`lazy`** — source writes mark the MV stale (in-memory). The next
  read (`.get(id)` or `.list()`) on the MV's output collection triggers
  the re-materialize before returning. Recommended for expensive views
  with read-light workloads.
- **`manual`** — only `vault.refreshView(name)` triggers
  re-materialization. Useful for time-dependent queries whose `ctx`
  changes externally, or very expensive views that opt out of the
  source-write hook entirely.

### `vault.refreshView(name)`

```ts
const { written, deleted, failed } = await vault.refreshView('pnd1')
```

Manual entry-point. Returns the executor's full result counts including
tombstones (`deleted`). Throws if the MV name isn't registered.

### `_materializedFrom` metadata

Every materialized row carries:

```ts
{
  _materializedFrom: {
    mvName: 'pnd1',
    queryHash: 'sha256-...',        // identity of the query structure
    sourceVersions: { compensations: 7 },
    materializedAt: '2026-05-21T...',
  }
}
```

Lives **inside the encrypted payload**, not in the unencrypted envelope
— the storage backend cannot infer the MV graph from listing. Same
zero-knowledge shape as v1's `_derivedFrom`.

### Tombstoning (`onEmpty: 'delete'`)

When a re-materialization produces zero rows for a key that previously
had rows, the prior row is deleted via the `Collection._internalDelete`
bypass. Same composition story as v1's `optional: true` tombstones:
user `onDelete` guards on the output collection do **not** fire on
housekeeping deletes. This keeps consumers free to register
`onDelete: throw` rules on MV output collections without deadlocking
their own refresh path.

Opt out with `onEmpty: 'keep'` if zero is a meaningful read state.

### Cycle detection

The cycle detector walks the unified graph of derivations + MVs +
overlays at `openVault` and rejects cycles with
`MaterializedViewCycleError`. Same-collection edges (an MV whose
source equals its output) are allowed **only** when `output.partition`
provably disjoints the source filter (`==` against a different value,
`!=` against the value, `in` lists that exclude it). Naïve
same-collection MVs without a partition filter throw.

### Errors

All extend `NoydbError`:

- `MaterializedViewCycleError(path[])` — cyclic MV graph
- `MaterializedViewSourceUnknownError(mv, source)` — `sources` declared a name the vault doesn't know
- `MaterializedViewTooLargeError(mv, rowCount, limit)` — `maxRows` exceeded

### `declaredDeterministicPredicates`

Some filters can't be expressed as `.where(field, op, value)` — date
arithmetic, multi-field conditions, references to external time. The
`predicates` field declares named functions that the query can call:

```ts
withMaterializedView<Invoice>({
  name: 'overdue',
  predicates: {
    isOverdue: {
      hash: 'is-overdue-v1',
      fn: (inv, ctx) => inv.status === 'open' && inv.dueDate < (ctx as { asOf: string }).asOf,
    },
  },
  query: (db) => db.collection<Invoice>('invoices').query()
    .wherePredicate('isOverdue', { asOf: '2026-05-20' }),
  rowKey: (r) => r.id,
  refresh: 'eager',
})
```

The predicate's `hash` field + a canonical-JSON hash of the `ctx`
argument both fold into the MV's `queryHash`. **Bumping `hash`**
(because the function's meaning changed) or **changing `ctx`** (e.g.
moving `asOf`) **forces a refresh on next visit** — no ad-hoc
invalidation logic in product code.

Consumer responsibility: bump `hash` when the function semantics
change. Failing to bump after a non-equivalent change leaves stale
rows around until the next explicit refresh.

`.wherePredicate()` is only available on `Query<T>` instances produced
by an MV that declared the predicate map. A bare query throws
`"no predicates registered on this query"` if you try to call it.

## Overlay views

> **Factory:** `withOverlayedView()`
> **Subpath:** `@noy-db/hub` (re-exported)
> **Spec:** `docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md` § Composition with operator-editable lifecycle

Overlays let a vault expose a **virtual collection** that merges two
concrete collections — typically an MV's output as `base` and a
user-writable `overlay` for operator overrides. A single-field shadow
predicate decides which side wins per row.

```ts
import { withOverlayedView } from '@noy-db/hub'

const pnd1 = withOverlayedView({
  name: 'pnd1',
  base: 'pnd1-aggregate',       // MV output collection
  overlay: 'pnd1-overlay',      // user-writable collection
  shadowField: 'dataStatus',
  shadowValue: 'override',
})
```

Read semantics: `vault.collection('pnd1').get(id)` returns the overlay
row **iff** `overlay[shadowField] === shadowValue`, otherwise the base
row. The binary `shadowValue` full-override path is the default when no
`mergeMode` is declared.

### Field-level merge (#348)

Pass `mergeMode: { kind: 'field-merge', rules: [...] }` to merge
per-field instead of swapping the whole row. Rules are evaluated in
declaration order; the **first** rule whose `whenStatus` matches the
overlay row's shadow field wins. The matched rule pulls its
`overlayFields` from the overlay over the base row — every other field
comes from base.

```ts
withOverlayedView({
  name: 'pnd1',
  base: 'pnd1-aggregate',
  overlay: 'pnd1-overlay',
  shadowField: 'dataStatus',
  mergeMode: {
    kind: 'field-merge',
    rules: [
      { whenStatus: 'amount-corrected', overlayFields: ['taxAmount'] },
      { whenStatus: 'reclassified',     overlayFields: ['clientId', 'category'] },
    ],
  },
})
```

When `mergeMode` is absent the binary `shadowValue` full-override path
is unchanged.

Write semantics: `.put(id, record)` on the virtual collection routes
to the overlay collection. The `id` argument must agree with the
record's identity per the overlay's `rowKey`; mismatches throw
`OverlayIdMismatchError`.

### Why this exists

Consumer pattern: an MV computes the "right" answer deterministically,
but a regulated-domain operator needs to override specific rows (an
accountant marks a row as `dataStatus: 'override'` and edits the
amount). Without overlays, consumers had to either abandon the MV
(lose determinism) or write sentinel rows back to the source (lose
provenance). The overlay split keeps both paths honest.

### Constraints

- `base` must be a **concrete** collection (a real source or an MV
  output) — not itself a virtual overlay name. Multi-overlay stacking
  is a v3 non-goal; enforced at `openVault` via
  `OverlayBaseIsVirtualError`.
- `overlay` must be a vault-known collection that is **not** an MV
  output. Operator writes go through the overlay's normal write
  pipeline, so its own `withGuard` / `withDerivation` registrations
  apply.
- `name` must not collide with any concrete collection or MV output —
  enforced via `OverlayNameCollisionError`.

### Errors

All extend `NoydbError`:

- `OverlayBaseIsVirtualError(overlay, base)` — base resolves to another overlay's virtual name
- `OverlayCollectionUnavailableError(overlay, missing)` — overlay or base collection not registered
- `OverlayNameCollisionError(name, existing)` — virtual name collides with a concrete collection or MV
- `OverlayIdMismatchError(actual, expected)` — `put(id, record)` where id doesn't equal `rowKey(record)`

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md`
- `docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md`
- `__tests__/derivations/*.test.ts`, `__tests__/materialized-views/*.test.ts`, `__tests__/overlay-views/*.test.ts`
- `showcases/src/80-with-derivation.showcase.test.ts`
- `showcases/src/81-with-mv-eager.showcase.test.ts`
- `showcases/src/82-with-mv-lazy.showcase.test.ts`
- `showcases/src/83-with-overlay.showcase.test.ts`
- `showcases/src/84-with-mv-predicates.showcase.test.ts`
