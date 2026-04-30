# Dimension 07 — Domain semantic primitives

## Purpose

Add a layer of *correctness invariants* that bleed across many app types in regulated or accounting-adjacent domains: gap-free serial sequences, coupled-entry transactions, dependent-field invalidation, computed fields, declarative cross-record invariants. Today these are reimplemented per-app; this dimension promotes the recurring patterns to first-class hub primitives so they're audited once and reused everywhere.

## Current state

The hub already provides several *opt-in* correctness primitives via `with*()` strategies: `withHistory`, `withPeriods` (time-partitioning), `withTransactions` (atomic apply via `runTransaction`), `withConsent` (privacy gates), `withI18n` (multi-locale fields), `withSchema` (Zod/Valibot validation), `withBlobs`, `withAggregate`. These cover *what data looks like* and *how it is mutated* but not *what invariants must hold across mutations* in domain terms (accounting, finance, regulatory).

## Target state

A composable layer of declarative invariants the application opts into via `with*()` factories. Each is **enforced at write time**, **checked at load time** (for retroactive bugs), and **integrated with `withTransactions`** so a violation rolls back the whole transaction. The application gets accounting-correct, audit-correct behaviour without reinventing it.

## Concrete additions

**`withSerialSequence(field, options)`** — gap-free serial-number guarantor.
- Reservation-on-write; rejected writes don't burn numbers.
- Formula support: `formula: '{prefix}-{year}-{seq:6}'`, with `{year}` bound to the period (depends on `withPeriods`).
- Per-vault, per-period, or per-collection scope.
- Backfill detection: refuses to write a record whose serial would create a gap unless the gap is explicitly justified (`reason` field).

**`withCoupledTransactions({ pairs: [...] })`** — invariant-coupled multi-record updates.
- "Every debit has a matching credit"; "every order has a matching invoice"; "every booking has matching availability decrement."
- Pairs declared as predicate + matching predicate; mutations rejected if the pair invariant breaks at transaction commit.
- Composes inside `runTransaction` — the whole transaction reverts on violation.

**`withGroupedFields({ source, dependents, onSourceChange })`** — dependent-field invalidation.
- "When `body_en` changes, mark `body_fr` and `body_de` as stale."
- `onSourceChange: 'invalidate' | 'recompute' | 'block'` — invalidate sets a flag, recompute calls a user-provided function, block refuses the write.
- Composes with `withI18n` for the translation case explicitly.

**`withComputedFields({ field, formula, on })`** — materialised derived columns *within a record*.
- `on: 'read' | 'write'` — read-time (lazy) or write-time (materialised).
- `formula` is a deterministic function over other fields of the same record; multi-record formulas use cross-collection joins (depends on Dimension 10 / SQL surface for ergonomics).
- Re-derivation triggered when source fields change.
- This is the *narrow case* of Dimension 14's general `withDerivation` primitive — same record, same DEK, same envelope, no separate storage routing. For derivations that span shapes (record → blob → vector) or live in different storage tiers (primary vs CDN cache), use `withDerivation` instead.

**`withInvariant(name, predicate, on)`** — declarative cross-record invariants.
- "Sum of `amount` in collection `entries` for a given `account_id` equals balance in `accounts`."
- `on: 'write' | 'read' | 'both'` — write-time enforcement (reject violations) and/or load-time audit (warn or reject corrupt data).
- Materialised result cached via `withAggregate` where compatible.

**`withPositiveAmount`, `withCurrencyConsistent`, `withNoFutureDates`** — opinionated shorthands wrapping `withInvariant` for the most common cases.

## Non-goals & tradeoffs

- **Full ORM relations.** This is not a relational layer; collections remain independent. Cross-collection invariants are expressed as predicates, not foreign keys.
- **Cross-vault enforcement.** Invariants are vault-scoped. Multi-tenant invariants require explicit cross-vault joins (deferred to Dimension 11).
- **ACID across stores.** noy-db is memory-first; transactions are atomic per-vault. Distributed-transaction semantics are out of scope.
- **Hidden side effects.** Computed fields are deterministic; they don't trigger network calls or mutations beyond their declared field.

## Dependencies / sequencing

- `withHistory` (already exists) is the audit substrate; invariants log violations to history.
- `withTransactions` (already exists) is the rollback substrate.
- Query DSL (already exists) is the predicate language.
- For full ergonomics on `withComputedFields` cross-collection formulas, Dimension 10 (SQL surface) is helpful but not required.

## Cross-references

- `features.yaml` → propose new `domain_primitives` section, parallel to `frameworks` and `transports`
- Related: Dimension 03 (computed fields surface in printable exports), Dimension 04 (`in-ux-forms-*` renders validators wired to invariants), Dimension 12 (`withIdempotenceKey`, `withOrdering` invariants for streams), Dimension 13 (`withEmbeddingConsistency` for source-record-changes-trigger-re-derivation), Dimension 14 (`withDerivation` is the general case of `withComputedFields`)
- Spec anchor: new `SUBSYSTEMS.md#domain-correctness` section
- Recipe target: `accounting-app.md` already exists; this dimension makes its examples enforceable rather than illustrative

## Open questions

- **Lazy-mode compatibility.** Cross-record invariants need to evaluate without loading the whole vault. Does the index-side-car (v0.22) carry enough to evaluate sums / counts cheaply, or does invariant maintenance need its own incremental evaluator?
- **Failure UX.** When a write rejects because of an invariant, what does the application see? A typed exception per invariant, a generic `InvariantError` with a name, or a `ViolationReport` aggregating multiple violations?
- **Performance ceiling.** Eager-mode 50K-record vaults are fine; what's the upper bound on invariant-checked writes per second? Need benchmarking via Dimension 06 (`to-bench`).
- **User-defined vs library-supplied.** Where does the line fall between "invariants the user writes inline" and "invariants the library ships as named primitives"?
