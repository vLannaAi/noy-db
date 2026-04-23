# Issue #107 — feat(as-sql): @noy-db/as-sql — SQL dump export for migration (postgres/mysql/sqlite)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-23
- **Milestone:** Fork · As (@noy-db/as-*)
- **Labels:** type: feature

---

## Target package

`@noy-db/decrypt-sql` (new) — sibling of the planned `@noy-db/decrypt-{json,csv,xlsx}` family documented in ROADMAP.md.

## Spawned from

Discussion #66 — SQL query frontend. The full position on *runtime* SQL (not shipping) lives in that discussion and in ROADMAP.md. This issue covers the different, smaller, and actually-valuable SQL surface: **one-way export for migration**.

## Problem

SQL-literate consumers routinely ask "how do I move my noy-db data to Postgres?" or "how do I hand my accountant a dump they can load into their tool?" The honest answer today is "export JSON, write a script." That's fine but leaves a real migration use case on the table that a ~400-line string formatter would cover cleanly.

Shipping a **SQL export format** is structurally different from shipping a SQL query frontend:

- One-way, at export time, offline — not a runtime query engine
- Zero maintenance bill — a dialect-aware string formatter over the existing `exportStream()` primitive (#72, already shipped in v0.5)
- Fits the existing `@noy-db/decrypt-*` family already in the roadmap, inherits its mandatory plaintext-exit warning block
- Serves the real use case SQL-literate consumers actually ask for: **migration**

## Scope

### API

```ts
import { decryptSql } from '@noy-db/decrypt-sql'

const sql = await decryptSql(company, {
  dialect: 'postgres',              // 'postgres' | 'mysql' | 'sqlite'
  include: ['invoices', 'payments', 'clients'],   // or omit for all collections
  mode: 'schema+data',              // 'schema-only' | 'data-only' | 'schema+data'
  tableNames: (collection) => collection,          // mapping hook
  metadataColumns: true,            // include _noydb_version / _noydb_ts columns
})
// → string: "CREATE TABLE invoices (...); INSERT INTO invoices VALUES (...); ..."
```

Streaming variant for huge compartments:

```ts
for await (const chunk of decryptSqlStream(company, { dialect: 'postgres' })) {
  await writeFile.write(chunk)
}
```

### Dialect coverage

- **Postgres** — `JSONB` for nested objects, `TIMESTAMPTZ` for dates, `NUMERIC` for decimals, `TEXT` for strings, `UUID` where schemas declare it
- **MySQL** — `JSON` for nested objects, `DATETIME(6)` for dates, `DECIMAL` for decimals
- **SQLite** — permissive typing, `TEXT` + `REAL` + `INTEGER` + `BLOB`, JSON stored as text

### Schema inference

Standard Schema v1 schemas drive column type generation:

- `z.string()` → `TEXT`/`VARCHAR`
- `z.number()` → `NUMERIC`/`REAL`
- `z.boolean()` → `BOOLEAN`/`TINYINT(1)`
- `z.date()` → `TIMESTAMPTZ`/`DATETIME(6)`
- `z.object({...})` → `JSONB`/`JSON` (not flattened — nested shape preserved)
- `z.array(...)` → `JSONB`/`JSON`

### Relational features

- **`ref()` fields → `FOREIGN KEY` constraints** in `CREATE TABLE` output. Dangling-ref modes surface as warnings in the generated SQL preamble comments.
- **`_v` / `_ts` envelope metadata** → optional `_noydb_version BIGINT` and `_noydb_ts TIMESTAMPTZ` columns, default on, opt-out via `{ metadataColumns: false }`.
- **`dictKey` (v0.8)** → two tables in the dump: one for the dictionary (`<dict_name>` table with `key` + one column per locale) and one for the records (with FK to the dictionary). Preserves the relational shape accountants expect.
- **`i18nText` (v0.8)** → sidecar translations table (one row per `(record_id, locale)` pair), matches gettext/`.po` conventions and survives round-tripping to Postgres cleanly.

### Safety and UX

- **Authorization-aware** — same ACL gating as `exportStream()`. A caller who can't read a collection can't dump it.
- **Mandatory plaintext-exit warning block** in the package README per the `@noy-db/decrypt-*` family policy documented in ROADMAP.md (ROADMAP.md:348).
- **No round-trip import** — this is one-way export for migration. Importing back from `.sql` is out of scope; if you want round-trip, use the existing `exportJSON` / `importJSON` path or the future `.noydb` container (#100).

## Non-goals

- **Not a runtime query frontend.** See discussion #66.
- **Not a DDL emitter for ongoing use.** One-shot export, not a sync channel.
- **Not a SQL importer.** One-way export only.
- **No view generation.** Plain tables only.
- **No indexes in the dump** beyond primary keys and foreign keys. Index strategy is consumer choice on the target DB.
- **No triggers, no stored procedures, no grants.** The dump is schema + data, nothing else.

## Acceptance

- [ ] `@noy-db/decrypt-sql` package in `packages/decrypt-sql/`
- [ ] `decryptSql(compartment, options)` returning a complete SQL string
- [ ] `decryptSqlStream(compartment, options)` async iterator for huge compartments
- [ ] Three dialects implemented: postgres, mysql, sqlite
- [ ] Schema inference from Standard Schema v1 covers the seven type cases above
- [ ] `ref()` fields emit `FOREIGN KEY` constraints in declaration order (topological sort to avoid forward-reference errors)
- [ ] Authorization-aware — honors the same ACL gating as `exportStream()`
- [ ] Round-trip test: dump → load into a Postgres Docker container → validate row counts and FK integrity
- [ ] Same for MySQL and SQLite
- [ ] README with mandatory plaintext-exit warning block
- [ ] Changeset
- [ ] Full turbo pipeline green

## Invariant compliance

- [x] Same authorization gate as `exportStream()` — adapters still never see plaintext
- [x] Plaintext exit is explicit, documented, ACL-checked, and paired with the warning block policy
- [x] No runtime crypto changes
- [x] No new crypto dependencies

## Related

- Discussion #66 (source — position on runtime SQL)
- #72 — `exportStream()` / `exportJSON()` (already shipped, this consumes it)
- ROADMAP.md `@noy-db/decrypt-*` family section (ROADMAP.md:311)
- #85 — dictKey query DSL integration (v0.8, determines dictionary table layout)
- #82 — i18nText schema type (v0.8, determines sidecar translation table layout)

v0.11.0.
