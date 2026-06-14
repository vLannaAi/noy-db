# Managed bidirectional link collection — `vault.link` (#377 design B)

> **Status:** DESIGN — awaiting maintainer decisions (see § Decisions needed).
> **Pilot:** Speedex purchase-line ↔ sale-line linking.
> **Relationship to #377-A:** `refArray` (shipped, PR #381) is the lightweight M:N.
> This is the richer, first-class junction. They coexist; B is not a replacement.

## Problem

`refArray` (design A) gives an id-array field per-element integrity — good for
"a post has tags". But it is **uni-directional** (the array lives on one side),
not **queryable as links** (no first-class "what is X linked to" without scanning
the owning collection), and has **no link-level metadata** (you can't annotate a
link, e.g. `quantity` on an order↔product line). A real M:N relationship —
purchase-line ↔ sale-line, with a suggest-links flow and bidirectional
navigation — wants a managed junction.

## Design A vs B — when to use which

| | `refArray` (A, shipped) | `vault.link` (B, this spec) |
|---|---|---|
| Storage | id array on the owning record | dedicated junction collection |
| Direction | uni (array on one side) | bidirectional, symmetric |
| Query | scan owner / `checkIntegrity` | `links(name).of(id)` both directions |
| Link metadata | none | optional per-link fields |
| Integrity | per-element on the owner | both endpoints, managed |
| Cost | zero new collection | one `_links_*` collection |

Recommendation in docs: reach for A for simple tag-like sets; reach for B when
links are themselves entities (queryable both ways, annotatable, suggest-flows).

## Proposed API

Mirrors the managed-collection pattern of `vault.dictionary()` /
`vault.sequence()` (handle-cache field + lazy accessor; grounded in `vault.ts`).

```ts
// Declare (registers the link spec; idempotent like collection({ refs }))
vault.link('saleLineLinks', {
  a: ref('saleLines'),
  b: ref('purchaseLines'),
  onDelete: 'cascade',        // when an endpoint is deleted, drop its link rows
})

// Operate via the handle
const links = vault.links('saleLineLinks')
await links.connect(saleLineId, purchaseLineId, { qty: 3 }) // optional metadata
await links.disconnect(saleLineId, purchaseLineId)
const forSale = await links.of(saleLineId)     // → [{ a, b, ...meta }] touching saleLineId
const exists  = await links.has(saleLineId, purchaseLineId)
```

### Storage

- A reserved `_links_<name>` collection (new prefix + `isLinkCollectionName`
  guard in `vault.collection()`, mirroring `_dict_*` / `_sequences`).
- Row key = canonical `"${aId}\x00${bId}"` (null-byte joiner, same disjointness
  trick as partitioned sequences). Row body = `{ aId, bId, ...meta }`, encrypted
  under the `_links_<name>` DEK obtained via the vault's `getDEK` (memoized
  promise, like `SequenceStore`).
- Handle = `LinkSetHandle` modeled on `DictionaryHandle` (direct adapter access,
  role-checked writes, emitter `change` events, ledger append when present, a
  sync cache for snapshot).

### Integrity & cascade

- `connect()` validates both endpoints exist (strict) — reuses the
  `enforceRefsOnPut`-style target lookup.
- `onDelete: 'cascade'` — when endpoint A or B is deleted, drop every link row
  touching it. **Implementation: a link-aware cleanup callback registered with
  the vault and invoked from `enforceRefsOnDelete`**, alongside the existing
  ref cascade (Path 2 in the map). Cleaner than registering phantom refs because
  link rows use composite keys + direct adapter access, not `Collection.list()`
  field matching. Reuse `cascadeInProgress` (cycle safety) and register dropped
  rows on `txCtx._executed` for tx-atomic rollback (matching #346).
- `onDelete: 'strict'` — block endpoint delete while links exist;
  `onDelete: 'warn'` — leave orphan link rows, surfaced by `checkIntegrity()`
  (extend it to walk link collections).

### `.of(id)` and queryability

- `of(id)` scans the link collection for rows where `aId === id || bId === id`.
  O(links) — acceptable for v1. An optional secondary index on `aId`/`bId` can
  come later if pilots need it.
- **Joinability via the query DSL is deferred** (Decision 3). The current
  `applyOneJoin` is single-FK equi-join (one-to-one / many-to-one) and cannot
  attach an *array* of right-side records through a junction. `links(name).of(id)`
  is the v1 query surface; DSL `joinThrough()` is a follow-up.

## Decisions needed

1. **Link metadata (annotated links).** Support optional per-link fields
   (`connect(a, b, { qty })`) in v1, or pure connect/disconnect first?
   **Recommendation: support metadata in v1** — it's the difference between a set
   and a real relationship, and the pilot's line-linking wants `qty`. Cheap (the
   row body already exists).
2. **Symmetric vs directed.** Is `(a,b)` the same link as `(b,a)`? For
   sale↔purchase the endpoints are *typed* (different collections), so the pair
   is inherently ordered by slot (a=saleLines, b=purchaseLines). **Recommendation:
   slot-typed (directed by slot), not symmetric** — `connect(saleId, purchaseId)`;
   `of(id)` matches either slot. Same-collection self-links (a and b same target)
   are allowed but out of v1 scope to optimize.
3. **Query DSL `joinThrough()`.** Ship a junction-aware join primitive now, or
   defer to a follow-up? **Recommendation: defer.** It needs a new `JoinLeg` kind
   + `applyLinkJoin` + array-attach semantics — a meaningful query-layer change
   that shouldn't gate the storage/handle primitive. `of(id)` covers the pilot.
4. **Backup inclusion.** `_links_*` rides the regular `dump()` (`adapter.loadAll`
   returns `_`-collections), like `_dict_*`. Confirm no addition to the special
   `_internal` snapshot is needed. **Recommendation: rely on loadAll path
   (no change), add a round-trip test.**

## Build plan (sketch, after decisions)

1. `_links_*` reserved prefix + guard + `vault.link()` registry + `vault.links()`
   accessor + `LinkSetHandle` (connect/disconnect/has/of) with DEK + emitter +
   ledger, modeled on `DictionaryHandle`.
2. Endpoint validation on connect; `onDelete` cascade/strict/warn via the vault
   cleanup callback in `enforceRefsOnDelete`; `checkIntegrity` extension.
3. Optional link metadata (Decision 1).
4. Tests: connect/disconnect/has/of, both-endpoint validation, cascade/strict/warn
   on endpoint delete, tx-atomic cascade rollback, backup round-trip, reserved-name
   guard. Showcase: sale-line ↔ purchase-line with a suggest-links flow + cascade.
5. New `features.yaml` entry (`id: link-collection`) + `docs/core/` doc; position
   vs `refArray`.

This is a meaningfully larger build than #377-A (a new managed collection type +
cascade integration + handle). Recommend it as its own milestone slice, sequenced
after the pilot confirms `refArray` doesn't already cover their line-linking need.
