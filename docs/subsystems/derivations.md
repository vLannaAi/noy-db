# derivations

> **Subpath:** `@noy-db/hub/derivations`
> **Factory:** `withDerivation()`
> **Cluster:** B — Write & Mutate
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
- `withMaterializedView` (collection-level query derivation)
- Scheduled / cron-style refresh
- Non-deterministic derivations with persistence
- External / sandboxed derivation runtimes
- Public CDN derivations
- Streaming materialized views (over Dim 12)
- Stale-flag persistence across vault close
- Per-record `sourceVersion` in bulk recompute paths

See the spec for the full deferred list.

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md`
- `__tests__/derivations/*.test.ts`, `showcases/src/80-with-derivation.showcase.test.ts`
