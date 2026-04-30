# Dimension 10 — SQL surface

## Purpose

Offer a declarative, SQL-flavoured query syntax alongside the existing chainable builder, for two reasons: **(a)** SQL is the lingua franca of data; many builders, AI agents, and data-science consumers prefer SQL strings to fluent APIs, and **(b)** SQL is a natural surface for non-developer stakeholders (accountants, analysts, ad-hoc queries from a CLI). The SQL surface compiles down to the same `QueryPlan` the chainable builder produces, so semantics are identical and there's no second evaluator to maintain.

## Current state

- The chainable builder is the only query surface: `.where`, `.join`, `.aggregate`, `.groupBy`, `.live`, `.scan`, `.toArray`, `.first`, `.count`, `.subscribe`.
- No SQL parser, no SQL planner.
- `vault.collection<T>('name').query()` is the entrypoint; there is no `vault.sql\`...\`` equivalent.

## Target state

A SQL string (or tagged template) compiles to a `QueryPlan` identical to one the builder would produce. The grammar is **SQLite-flavoured minimal SELECT** — no DDL, no transactional DML inside SQL, no vendor extensions. Type inference from collection schemas hooks into the tagged-template form so `vault.sql\`SELECT * FROM invoices WHERE amount > ${threshold}\`` returns a typed result.

## Concrete additions

**Package:**
- `@noy-db/in-sql` — parser + planner, hosted in the `in-*` family because it's a query *surface* (alternate ergonomics) like `in-tanstack-query` is. Independent of any framework.

**Hub additions:**
- `vault.sql\`...\`` tagged-template entrypoint with type inference
- `vault.compileSql(sqlString): QueryPlan` for non-tagged use (AI agents, dynamic queries)
- `Collection<T>.sql\`...\`` collection-scoped equivalent

**Grammar (initial):**
- `SELECT [DISTINCT] field, ... FROM collection [JOIN collection ON ...]*`
- `WHERE predicate` (full predicate expression matching the builder's `where`)
- `GROUP BY field [, ...]`
- `HAVING predicate`
- `ORDER BY field [ASC|DESC] [, ...]`
- `LIMIT n [OFFSET m]`
- Aggregates: `count(*)`, `sum(field)`, `avg(field)`, `min(field)`, `max(field)`
- Parameter substitution via tagged-template `${value}` (matches the builder's typed bound parameters)
- `CASE WHEN ... THEN ... ELSE ... END` for derived projections
- `WITH cte AS (...)` for one level of CTE (no recursion in v1)

**Tooling:**
- Companion CLI command (`@noy-db/cli`): `noydb sql --vault ./vault --sql "SELECT ..."` for ad-hoc queries
- IDE support hint: SQL templates with vault schema as context (deferred to ecosystem)

## Non-goals & tradeoffs

- **DDL inside SQL.** No `CREATE TABLE`, `ALTER TABLE`. Schemas are defined in TypeScript; SQL only reads.
- **DML inside SQL.** No `INSERT`, `UPDATE`, `DELETE` in v1. Mutations stay on `Collection.put`/`delete` because they need explicit transactional and permission semantics.
- **Vendor SQL dialects.** No PostgreSQL `::cast`, no MySQL backticks, no SQL Server `[brackets]`. SQLite-flavoured ANSI-ish only.
- **Recursive CTEs, window functions, lateral joins.** Deferred until proven necessary by real workloads.
- **Stored procedures, triggers, views.** Not a database. The builder/SQL is a query surface, not a programming layer.

## Dependencies / sequencing

- Query DSL is stable (it is, since v0.6). New SQL parser plugs into the existing `QueryPlan`.
- Type inference requires a stable schema-introspection API (also a Dimension 04 dependency for `in-ux-forms-*`).
- Ref-mode dispatch (strict / warn / cascade) on dangling refs must surface in SQL semantics — is `JOIN` strict by default?

## Cross-references

- `features.yaml` → `frameworks` (`in-sql` entry); may justify a new `query_surfaces` section if more land
- Related: Dimension 04 (`in-ai` and `in-tanstack-query` are complementary surfaces; AI agents prefer SQL strings), Dimension 07 (cross-collection invariants are easier to express in SQL)
- Spec anchor: `SUBSYSTEMS.md#query-and-aggregation`

## Open questions

- **Case sensitivity.** Field names and collection names — case-insensitive (SQL convention) or case-sensitive (TypeScript convention)?
- **Reserved words.** Do we reserve SQL keywords for collection / field names, or quote-wrap to allow conflicts?
- **Type inference depth.** Can the tagged-template form infer the full row shape from `SELECT a, b, c.d FROM ...`, or does it return `unknown`-typed rows when projection is non-trivial?
- **Live SQL.** Does `vault.sql\`...\`.subscribe(cb)` work, mirroring `.live()`? The semantics are clear; the question is grammar — is `LIVE SELECT` keyword extension worth introducing?
- **Performance sanity.** SQL strings encourage Cartesian-explosion patterns. Should the planner refuse plans projected to exceed Dimension 06's row ceilings, or warn and let users override?
- **Parser size.** A SQL parser is non-trivial bundle weight. Mark `in-sql` as opt-in heavy dependency from day one.
