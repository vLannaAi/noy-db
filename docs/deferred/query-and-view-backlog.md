# Deferred: query, view, and guard capabilities

Capabilities that were specified, deliberately cut, and never picked up. Each
entry keeps the *reason* — that is the part worth preserving, since the feature
itself is easy to re-imagine and the cost is not.

Nothing here has a waiting consumer. Where a deferral did grow one, it is a
GitHub issue instead.

---

## Materialized views

**Arbitrary `mergePolicy` callback on overlay views.** Only the single-field
read-shadow primitive shipped. Field-level merges, priority lattices, and
history-aware reconciliation were cut together — a user-supplied merge function
turns a declarative overlay into arbitrary code on the read path, which is a
different reasoning burden entirely.

**Multi-overlay stacking.** A virtual collection has exactly one base and one
overlay. Overlay-B shadowing the result of overlay-A needs a resolution order
nobody has needed yet, and `base` is validated to be a *concrete* collection
precisely to keep that door shut.

**Automatic write-to-base.** The overlay cannot create or modify base rows. The
base is owned by whatever wrote it. Relaxing this makes the overlay a write path
and the ownership question real.

**Scheduled refresh (`{ every: '1h' }`).** There is no general cron or scheduler
primitive in the hub, and adding one to serve MV refresh alone would be the tail
wagging the dog. It pairs naturally with a hooks/triggers primitive if one is
ever built.

**Streaming and MapReduce views.** Streaming MVs need an incremental stream
primitive that does not exist. MapReduce views (`map` + optional `reduce`) are a
different shape and would want their own spec rather than an option on this one.

**Recursive UNION, and index-accelerated multi-key `groupBy`.** No consumer;
both add dependency-analyser complexity. Multi-key `groupBy` inherits the
existing property that `groupBy` cannot be index-accelerated — that limitation is
unchanged, not newly introduced.

---

## Query DSL

The substantial items — outer joins, anti-join, self cross-join with a shared
alias, and cross-join over MV virtual collections — are **tracked as a GitHub
issue**, not here, because the NULL-propagation work they imply is real and
someone will eventually want it.

What stays deferred without an issue:

**Cost-based query planning for cross-join.** Evaluation is left-to-right as
declared; putting the smaller side first is the consumer's responsibility. A
planner is worth building when someone has a query it would actually rescue.

**Arbitrary cross-partition correlation** (shard A ⋈ shard B). Excluded by the
join layering invariant: cross-vault correlation goes through the fan-out path,
not through the single-vault join. This is a boundary, not a backlog item — it
would only change as part of a federation redesign.

**Reactive and aggregated sharded joins.** `.live()` and `.aggregate()` on a
joined sharded query throw by design. Cross-shard right-side change propagation
is the hard part, and it is unbuilt.

---

## Guards

**Per-field amendment.** Amending only specific frozen fields needs field-level
amendment context threaded through the guard pipeline. The all-or-nothing
amendment shipped.

**Time-limited amendment windows.** An `unlockForAmendment` with an expiry is a
separate UX flow, and it pairs with the session-tier machinery rather than the
guard machinery.

**Guards on bulk store operations** (`loadAll` / `saveAll`). The single-record
case was validated first, deliberately; the bulk path is uncommon.

**Cross-vault guards.** Requires cross-vault plaintext access — the same
unresolved key-custody question that blocks cross-vault derivation. Do not build
this before that question has an answer.

**Guard DAGs** (a guard whose check reads a derived collection). Composes badly
with derivation cycles; would need the cycle detection the via graph now has, so
this is more tractable than when it was cut.

---

## Derivations

**Lazy-mode array-shape derivations.** Needs new stale-tracking semantics.

**Identity-skip optimisation** (write only when content differs). Requires
per-row hash tracking; deferred until someone measures a slowdown rather than
predicts one.

**Persisted index over derived-source ids.** The sidecar is sufficient for
dispatch; a real index only matters for consumers who want to *query* derived
outputs by source.

**Streaming / chunked derive.** For sources with very large fanout the current
API returns the whole array at once.

**Read-time drift validation.** Re-evaluate a computed value on read and flag
disagreement with the stored one — catches formula changes after the fact. Cut
because it puts computation on every read to detect a rare authoring event.

---

## Retrieval

**HNSW / IVF / quantization, and ORAM with attested enclaves.** Brute-force
vector search suffices at the scale this targets; approximate-nearest-neighbour
structures add a dependency and real complexity. Access-pattern hiding (ORAM)
is research-grade and was always labelled as such — it is listed so nobody
mistakes its absence for an oversight.

**Managed plaintext vector backends** (pgvector, Vectorize, Qdrant, …). Gated
deliberately: the backend would see plaintext vectors, and embedding inversion
turns that into a PII leak. This is the same reasoning that keeps the query DSL
inside the hub, applied to vectors. It is a *decision*, not a gap.

**Sub-document chunking.** One vector per record over the declared source
fields. Multiple vectors per record is a genuine capability gap for long
documents.

**Weighted / score-normalized rank fusion.** Rank-based fusion is the robust
default; BM25 and cosine scores are not comparable, and min-max normalization
shifts with the result set — so the "better" fusion is not obviously better.
