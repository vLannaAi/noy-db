# Discussion #86 — Partitioned collections: per-partition DEKs, closed-period integrity, and carry-forward snapshots

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **State:** open
- **Comments:** 1
- **URL:** https://github.com/vLannaAi/noy-db/discussions/86

---

noy-db today stores a collection as a single unit: one DEK, one ledger chain, one lazy-load, one query scan. For any consumer with **time-series or bounded-rollover data** — logs, metrics, events, orders, any data that grows monotonically over years — this shape has structural issues that no amount of indexing fixes:

1. **Cold-start cost grows linearly with history** because opening a collection loads and decrypts everything the query might touch, even when 95% of the data is from closed periods that nobody is asking about today.
2. **Key rotation cost is O(all records)** — revoking a staff member re-wraps every DEK reference in the entire history, most of which hasn't changed in years.
3. **There's no way to grant period-scoped access** — an external auditor reviewing a single fiscal year gets all-or-nothing on the whole collection, because the ACL boundary is the compartment and the crypto boundary is the collection DEK.
4. **There's no way to cryptographically close a period** — "these books are frozen on this date" is not expressible, because the ledger is one open chain that keeps appending forever.
5. **Historical aggregates rescan on every call** even when the underlying data hasn't changed in years, because there's no place to cache a rolled-up summary that the library understands as authoritative.

All five are solved by **partitioned collections**, and I think this is strong enough to belong in core — not just as a storage-shape convenience, but as a security primitive (per-partition DEKs) with a novel closing-snapshot ("carry") capability that no comparable embedded database ships today.

## Overview

Three layers. The library should own two of them; the third is explicitly out of scope.

### Layer 1 — Partitioning primitive (core)

Collections can declare themselves partitioned by a user-provided key function:

```ts
const invoices = company.collection<Invoice>('invoices', {
  schema: InvoiceSchema,
  partition: {
    by: (record) => String(new Date(record.issuedAt).getUTCFullYear()),
    // optional: obfuscate the partition label on disk
    label: (key) => hashLabel(key),   // '_p_2024' → '_p_a7f3...'
  },
})
```

Each partition is an **independent sub-unit** of the collection:

- **Its own DEK** (default on, opt-out for consumers that explicitly don't need per-partition grants).
- **Its own lazy-load.** Query planning prunes partitions that can't possibly match; only matched partitions are opened, decrypted, and loaded.
- **Its own ledger chain**, with parent-hash linkage to the previous partition's closing head (see the "closed partitions" section).
- **Its own schema version**, recorded at partition creation time. Closed partitions are frozen at their close-time schema — no retroactive migration (see "schema drift" below for rationale).

Query API changes are minimal because the partitioning is **transparent** in the common case:

```ts
// Explicit partition scope (fast — one partition only)
invoices.query()
  .where('year', '==', 2024)
  .toArray()

// Range across partitions (fast — two partitions only)
invoices.query()
  .where('year', 'in', [2023, 2024])
  .toArray()

// No partition predicate — LOUD warning, requires .all() opt-in
invoices.query()
  .where('amount', '>', 1000)
  .all()                         // explicit: "yes, scan every partition"
  .toArray()

// Without .all(), above throws PartitionScopeRequired to prevent accidental full-history scans
```

The query planner is a tiny thing: recognize `where()` clauses on the partition field, compute which partitions the predicate could match, open only those. For `==`, `in`, and `>=`/`<=` range predicates on the partition key, this is O(partitions) planning and zero runtime cost.

### Layer 2 — Closing snapshots / carry (core)

This is the piece I think is novel. No comparable library ships it, and it generalizes cleanly across domains.

When a partition is closed, the consumer computes a **summary** and the library stores it as the **opening state** of the next partition. From then on, queries against the current partition can read the carry directly instead of re-scanning closed partitions for historical aggregates:

```ts
// At year-end, consumer computes what they want to carry forward
const summary = {
  runningTotal: 1_250_000,
  openInvoiceIds: ['inv-a', 'inv-b'],
  lastSequence: 4711,
  // ... whatever the consumer decides is worth caching
}

await invoices.partition('2024').close({
  carry: summary,
  // closing is a ledger event in BOTH partitions
  // outgoing: "closed with head hash X at time T"
  // incoming: "opened with parent head X and carry C"
})

// Later, in the 2025 partition:
const carry = await invoices.partition('2025').previousCarry()
// → { runningTotal: 1_250_000, openInvoiceIds: [...], lastSequence: 4711 }

// Queries that would have scanned all history now scan current + read carry
const runningTotal = carry.runningTotal + invoices
  .query()
  .where('year', '==', 2025)
  .aggregate({ delta: sum('amount') })
  .value.delta
```

**Why this is a library feature and not a userland convention:**

1. **The library knows when partitions close.** Close time is the natural moment to compute the carry — the data is about to become immutable, the ledger chain is about to finalize. A userland cache has no principled way to know when "the source of truth for this carry is now frozen."
2. **The ledger anchors the carry cryptographically.** The closing event records `{outgoing head, carry hash, closed at}`. Tampering with the carry after close breaks the chain. A userland cache is just a file with no integrity story.
3. **Parent-chain linkage lets consumers verify the full history.** `verify()` on the current partition walks back through carries and parent hashes, validating the full multi-year sequence as one logical chain. Userland can't produce this.
4. **Query integration.** The query DSL can treat the carry as a known static input to aggregations, enabling optimizations the consumer can't express without intrusive integration into the library's internals.

**The carry is general-purpose, not accounting-specific:**

| Domain | Carry content |
|---|---|
| Logs | Rotation count, last-seen sequence number, retained summary counts by level |
| Metrics | Last-seen aggregate, histogram state, cardinality estimate |
| Event sourcing | Snapshot checkpoint — the replayed state at end-of-period |
| CRM | Customer lifetime value as-of, cohort counts, retained contact list |
| Accounting | Trial balance, open invoices, running P&L state |
| Inventory | On-hand quantities, WIP values, cost basis |

The library provides the **shape and the integrity anchor**. The consumer provides the summarization logic. That's the right line.

### Layer 3 — Domain-specific summarization (EXPLICITLY NOT core)

noy-db has no business knowing what a trial balance is, what a cost basis is, or what a cohort looks like. Domain-specific helpers — "compute opening balance from invoices + payments + disbursements" — belong in userland or in third-party packages, never in core. The core library ships the primitive; domain authors fill in the summarization.

## The killer feature: per-partition DEKs enable period-scoped access grants

This is the argument I'd lead with if pitching to a security-oriented maintainer. Partitioning isn't just a storage shape — with per-partition DEKs it becomes a **granular access-control primitive** that composes with the existing keyring system and enables capabilities no comparable library offers:

1. **External auditor gets one period only.** Wrap the 2024 DEK in the auditor's keyring; leave 2023 and 2025 out. They can mathematically decrypt 2024 and mathematically cannot decrypt the others. Not "the ACL says no" — "the crypto says no." For regulated-industry audits of specific fiscal periods, this is exactly the compliance story every consumer with sensitive historical data wants.

2. **Period-scoped compliance requests.** Tax authority, regulator, legal discovery — all of these are typically scoped to a single period. Per-partition DEKs make "provide only period X" expressible and verifiable.

3. **Key rotation cost drops by orders of magnitude.** Revoking a staff member today re-wraps every DEK in the compartment. With per-partition DEKs, rotation only touches partitions the revoked principal could actually access — typically the current period plus a few recent ones. For a ten-year-old collection, this is a 10× (or more) reduction in the most expensive operation the library performs.

4. **Cold-storage old periods.** Archived partitions can have their DEKs removed from active keyrings entirely and stored offline (hardware key, sealed envelope, printed paper key). The ciphertext sits in the adapter untouched until a specific historical query needs it, at which point the offline DEK is brought online temporarily and removed again. This is the zero-knowledge equivalent of tape archive.

5. **Closed-period cryptographic integrity.** Each partition's ledger finalizes at close with a hash that becomes part of the permanent record. Subsequent tampering is detectable by anyone holding the closed head — including auditors, regulators, or the consumer's own future self. "These books are closed" becomes a mathematically provable statement rather than a convention.

Zero-knowledge + per-partition DEKs + closed-period integrity is a combination I don't think any other embedded database ships, and it's the reason this feature deserves to be in core rather than in a userland layer on top.

## Query optimization: carries turn historical scans into O(1) lookups

For any query that needs "history up to now," the carry becomes the primary data source and the current partition becomes the only thing scanned:

| Query shape | Before partitioning | With partitions + carry |
|---|---|---|
| Current period totals | Scan all history, filter | Open current partition only |
| Year-to-date metric | Scan all history | Open current partition only |
| Outstanding items as of today | Scan all history (because a record from N years ago could still be open) | Current partition + carry of `openIds` from previous close |
| N-year trend | Scan all partitions, aggregate | Read N carries — **zero record scans**, the aggregation was computed at close time |
| Lifetime total | Scan all history | Read most recent carry (rolled up) |

The last two are the cases that beat even specialized time-series databases. The carry has already done the aggregation at close time; reading it is O(1) regardless of how much history exists. Any dashboard that shows multi-year metrics gets a performance profile that's structurally better than "index it harder."

Cost: close-time computation isn't free, and the consumer has to correctly identify what's worth carrying. But close-time runs *once per period* (typically once per year for accounting, once per day for logs, once per hour for metrics) and can be async. Amortized cost relative to query time is effectively zero.

## Interactions with every open discussion

This feature composes with every other proposal currently under discussion, and the proposal needs to explicitly say how:

1. **#64 joins.** Partition pruning runs before joins. Cross-partition joins need care — if the right side of a join is in a different partition than the left, opening the right side triggers a second partition load. Document this as "joins stay within a single partition scope unless `.all()` is explicit."
2. **#65 aggregations.** Carries ARE precomputed aggregations. `.aggregate()` with `.live()` on a partitioned collection should read carries for closed periods and stream-update only the current partition. This is the most important composition — `.aggregate()` without carry-awareness would recompute historical aggregates every tick, defeating the point.
3. **#66-ish sync v2.** Per-partition sync is a natural fit: sync the current partition frequently (every 30 seconds), closed partitions rarely or never. Bandwidth savings match the access pattern.
4. **#67 blob attachments.** Blob storage partitions the same way. A PDF from 2022 lives in the 2022 blob partition and inherits its DEK — which is exactly what you want for period-scoped access control, because the auditor who gets the 2024 year also gets 2024's attached PDFs and nothing else.
5. **#70 exports + XML comment.** Exports get a partition-scoped variant: export a single partition, export a range of partitions, or export *just the carries* ("give me the 5-year summary" is literally reading five carries into a report). The `exportStream()` primitive should surface partition metadata alongside record streams.
6. **#78 i18n.** Dictionaries are probably **not** partitioned — labels are time-invariant and sharing them across years is the right default. Multi-lang content fields within records are partitioned naturally along with the records they live in. This is a small paragraph in the proposal, not a design question.

## Concrete design questions

1. **Partition key source.** Function-based (`partition.by: (record) => string`) is flexible and validates inside the schema pipeline. Field-based (`partition.field: 'year'`) is simpler. I lean function-based — it covers field-based as a one-liner (`(r) => String(r.year)`) and it handles composite keys (`(r) => `${r.year}-${r.quarter}``) without a second API.

2. **Partition naming and obfuscation.** The partition label on disk can be the raw key (`_p_2024`) or a one-way hash of it (`_p_a7f3...`). Hashing prevents time-series signal from leaking through partition names but breaks easy debugging and manual recovery. Proposal: raw by default, optional `label: (key) => string` transform for consumers who need the obfuscation.

3. **Query planner predicate support.** Minimum: `==`, `in`, `>=`, `<=`, range. The planner recognizes these on the partition key and prunes. Anything more complex falls back to "must use `.all()` explicitly or error." Small, boring, safe.

4. **Schema drift across partitions.** Per-partition schema version, frozen at close. Closed partitions are read through the schema they were closed with. New partitions use the current schema. No retroactive migration — it matches accounting reality (you don't retroactively change the chart of accounts from 5 years ago) and avoids the migration-on-read complexity. Consumers who genuinely need to migrate old partitions can explicitly `reopen()` them (see below).

5. **Closed partition mutability.** Real accounting has prior-period adjustments. Closed partitions should support mutation, but only through an explicit `reopen()` operation that:
   - Records the reopen as a ledger event with reason and principal.
   - Invalidates the carry (sets a flag; subsequent queries using the carry get a warning).
   - Requires a matching `close()` call that recomputes the carry before the partition is re-frozen.
   - Preserves the original close hash in the ledger for audit trail — "closed at H1, reopened at T, re-closed at H2" is the visible sequence.
   This is the single thing most prone to getting wrong and most visible to downstream auditors, so the API has to make it impossible to reopen silently.

6. **Cross-partition transactions.** What if a mutation spans partitions (e.g. an event at year-end that affects both the closing period and the opening period)? I lean: forbid it. The close boundary is the transaction boundary. The consumer either writes to the outgoing partition before close or the incoming partition after — never both atomically.

7. **Carry contract ergonomics.** The closing function runs at close time against the to-be-closed partition's data. If expensive, closing is slow. If buggy, the carry is wrong forever (until reopen+reclose). The library should:
   - Encourage idempotent, deterministic closing functions.
   - Ship a `dryRunClose()` that computes the carry without writing it, so consumers can validate.
   - Record the closing function's source hash (or an explicit version tag) in the ledger, so "what logic produced this carry" is auditable.

8. **Per-partition DEK management.** Who creates the DEK for a new partition? Probably: the library, automatically on first write, wrapped into the keyrings of every principal who currently has access to the collection. Who rotates it? Same rules as existing DEK rotation, scoped to the partition. Can a principal have access to *some* partitions and not others? **Yes — that's the whole point.** `grant()` and `revoke()` gain a `partition` parameter.

9. **Partition enumeration and existence leaks.** `listPartitions()` returns the partitions the caller can unlock, not all partitions that exist. Same principle as the cross-compartment enumeration proposal (#63) — no existence leaks for partitions the caller has no key material for.

10. **Default behavior for non-partitioned collections.** Existing collections keep working unchanged. Partitioning is opt-in via the schema. A collection without `partition` config behaves exactly as today. Migration to partitioned is an explicit, one-time operation — not something that happens automatically.

11. **Ledger chain verification across partitions.** `verify()` on the current partition walks back through carries and parent hashes, validating the full sequence. A mode flag `{ scope: 'current' | 'full-history' }` controls how far back it walks. Default: current partition only (O(current-size)). Opt-in: full history (O(all-records)).

12. **Adapter support.** Adapters need to know how to enumerate partition-prefixed keys, but this is already covered by `list(compartment, collection)` — it just lists more names now. No adapter contract change. Existing adapters work as-is; partition-aware optimizations (e.g. DynamoDB query by partition prefix) are adapter-specific enhancements that don't block the core feature.

## Non-goals (explicit scope exclusions)

1. **Automatic partition management.** The consumer decides when to close a partition. The library does not close partitions on a schedule or on a size threshold. "Year-end" is an accounting concept; the library doesn't know accounting.
2. **Domain-specific carry helpers.** No "compute trial balance" in core. Belongs in userland.
3. **Partition-level replication policies.** Different partitions can't replicate to different backends in v1. All partitions use the same adapter. (A future sync-v2 discussion could revisit this.)
4. **Cross-partition joins as a first-class feature.** Joins within a partition are the happy path. Cross-partition joins require explicit `.all()` opt-in and are not optimized.
5. **Shared partitions across compartments.** Each partition belongs to exactly one compartment. No cross-tenant sharing.

## What I'd like out of this discussion

- **Scope alignment** on the three-layer split: Layer 1 (partitioning + query planning + per-partition DEKs) and Layer 2 (carries + closing-snapshot integrity) in core, Layer 3 (domain-specific summarization) explicitly out.
- **Security review of the per-partition DEK model** before anyone writes code. This is the part where a design bug would be catastrophic. Specifically: how partition DEKs are derived, wrapped, rotated, and enumerated; how `grant()`/`revoke()` extend to partition scope; how the closed-period head hashes compose with the existing v0.4 ledger.
- **Explicit position on carry ergonomics**: idempotent/deterministic requirement, dry-run API, closing-function versioning in the ledger. These are the consumer-facing details most prone to footguns.
- **Roadmap placement.** This composes with #64/#65/#66/#67/#70/#78 in ways that affect all of them. I'd argue for v0.7 at the earliest — it needs joins, aggregations, and exports to be at least designed before partition interactions can be finalized. Shipping it earlier would force revisions.
- **A "no" on automatic partition management and domain-specific helpers**, documented, so consumers stop asking. Same treatment as the SQL-frontend and MySQL-export positions.

Not a proposal for a specific API surface yet — this is the scope, invariant, and security-design discussion. A follow-up epic would split into small issues: partition primitive + query planner, per-partition DEK derivation + key management, ledger chain linking + close/reopen semantics, carry storage + `previousCarry()` API, schema version freezing, export integration, sync integration.


> _Comments are not archived here — see the URL for the full thread._
