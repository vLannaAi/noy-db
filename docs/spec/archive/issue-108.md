# Issue #108 — feat(adapters): SQL-backed adapters — @noy-db/to-postgres + @noy-db/to-mysql (encrypted-blob KV)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-23
- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, area: adapters

---

## Target packages

`@noy-db/to-postgres` (new), `@noy-db/to-mysql` (new) — filed as one umbrella issue because they share the same storage schema, the same 6-method adapter implementation, and differ only in driver + dialect specifics.

## Spawned from

Discussion #66 — SQL query frontend, the "what about actually storing records in mysql/to-postgres backend" branch. The position on runtime SQL queries is separate (see #107 for `@noy-db/decrypt-sql` export and the discussion for the no-runtime-frontend stance); this issue covers the much simpler and invariant-preserving case: **use Postgres or MySQL as a dumb key-value store for encrypted envelopes.**

## Problem

noy-db today ships adapters for file, S3, DynamoDB, memory, and browser. Many consumers already run Postgres or MySQL and would rather reuse that infrastructure than take a dependency on a new cloud vendor (DynamoDB lock-in) or manage S3 lifecycle separately. There's no architectural reason SQL databases can't be the backing store — they just need to store opaque encrypted envelopes the same way the DynamoDB adapter does.

**Critically: this does not ship a SQL query frontend.** Postgres/MySQL are used here purely as key-value stores. noy-db's query DSL runs in core, after decryption, over the in-memory record set. The SQL database never sees plaintext, never runs a `WHERE` on record content, and doesn't need to understand the schema. That's the whole point — it keeps the zero-knowledge invariant intact while giving consumers a familiar, ubiquitous backing store.

## Scope

### Shared storage schema

```sql
CREATE TABLE noydb_storage (
  compartment  TEXT        NOT NULL,
  collection   TEXT        NOT NULL,
  id           TEXT        NOT NULL,
  envelope     JSONB       NOT NULL,     -- {_noydb, _v, _ts, _iv, _data} — ciphertext
  version      BIGINT      NOT NULL,     -- for expectedVersion optimistic concurrency
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (compartment, collection, id)
);
CREATE INDEX noydb_storage_compartment ON noydb_storage (compartment);
CREATE INDEX noydb_storage_compartment_collection ON noydb_storage (compartment, collection);
```

MySQL variant uses `JSON` instead of `JSONB`, `BIGINT UNSIGNED` for version, and `DATETIME(6)` for `updated_at`. Otherwise identical.

**The database schema is a noy-db implementation detail, not a consumer-facing schema.** Consumers never write `SELECT ... FROM noydb_storage` — they use noy-db's query DSL. The table layout is documented for ops reasons (backup planning, monitoring, capacity) but is not part of the public API and can change in minor versions.

### Adapter implementation

Both adapters implement the existing 6-method `NoydbAdapter` interface:

```ts
import { createPostgresAdapter } from '@noy-db/postgres'
import { Pool } from 'pg'

const adapter = createPostgresAdapter({
  pool: new Pool({ connectionString: process.env.DATABASE_URL }),
  table: 'noydb_storage',       // opt-in override for custom table name
})

const db = await createNoydb({ auth, sync: adapter })
```

Method mapping:
- `get(c, col, id)` → `SELECT envelope FROM noydb_storage WHERE compartment=$1 AND collection=$2 AND id=$3`
- `put(c, col, id, env, expectedVersion)` → `INSERT ... ON CONFLICT (compartment, collection, id) DO UPDATE SET envelope=$4, version=version+1 WHERE version=$5` (conflict → `VersionConflictError`)
- `delete(c, col, id)` → `DELETE FROM noydb_storage WHERE ...`
- `list(c, col)` → `SELECT id, envelope FROM noydb_storage WHERE compartment=$1 AND collection=$2`
- `loadAll(c)` → `SELECT collection, id, envelope FROM noydb_storage WHERE compartment=$1`
- `saveAll(c, data)` → transaction with `DELETE WHERE compartment=$1` + bulk `INSERT`

### Driver choice

- **Postgres**: `pg` (node-postgres) — de facto standard, stable, zero drama. Adapter accepts either a `Pool` or a `Client`.
- **MySQL**: `mysql2` — modern, promise-native, prepared-statement support. Adapter accepts a `Pool` or a `Connection`.
- Drivers are **peer dependencies** (same pattern as `@noy-db/dynamo` with `@aws-sdk/client-dynamodb`). The consumer installs the driver; noy-db doesn't pin versions.

### Optimistic concurrency

Postgres and MySQL both support the `WHERE version=$expected` pattern cleanly. The `put()` implementation uses a conditional UPDATE and checks `rowCount` — if zero, the version didn't match and the adapter throws `VersionConflictError` with the actual stored version. Same contract as the existing DynamoDB adapter.

### Transactions

- **Intra-adapter writes** use transactions where the 6-method contract naturally calls for them (e.g., `saveAll()` is one transaction).
- **Cross-adapter consistency** is unchanged — noy-db does not promise cross-backend transactions, same as today.
- **Per-put autocommit** is the default for `put()` / `delete()` — matches DynamoDB and S3 semantics.

### Migrations

A `npx noydb-postgres migrate` / `npx noydb-mysql migrate` CLI ships the schema DDL and creates the table if absent. Idempotent. Consumers who want to manage DDL themselves can run the SQL from the README.

### What these adapters do NOT do

- **No SQL query frontend.** Records are opaque JSONB envelopes; the database does not introspect them. See discussion #66 for the full position.
- **No schema-per-collection.** All collections in a compartment share the single `noydb_storage` table. The `collection` column discriminates. This matches the DynamoDB single-table design.
- **No JSONB path indexes on record content.** Would require plaintext fields — invariant violation. Indexes are on the `(compartment, collection, id)` tuple only.
- **No cross-compartment JOIN at the SQL level.** Cross-compartment queries go through `queryAcross` in core.
- **No LISTEN/NOTIFY or MySQL binlog integration** for reactive sync in v1. The sync engine handles change notification; reusing Postgres's notification channel is a v0.9 sync v2 enhancement (separate issue if a consumer asks).

## Non-goals

- SQLite — already covered by `@noy-db/file` for the single-process-embedded use case, and would duplicate effort without distinct value. Revisit if a consumer asks for multi-process SQLite access.
- Aurora / Cloud SQL / PlanetScale convenience wrappers — these all speak vanilla Postgres/MySQL, and the base adapters work against them unchanged. Document in the README.
- Managed migration framework (Flyway/Liquibase style) — out of scope. The adapter ships one DDL file; consumers integrate with whatever their project already uses.

## Acceptance

- [ ] `@noy-db/postgres` package in `packages/postgres/` implementing the 6-method `NoydbAdapter` interface
- [ ] `@noy-db/mysql` package in `packages/mysql/` with the same shape
- [ ] Shared adapter conformance suite green (both adapters pass `test-harnesses/adapter-conformance`)
- [ ] Optimistic concurrency via `expectedVersion` — verified by a concurrent-writer test
- [ ] `pg` / `mysql2` declared as peer dependencies, not direct dependencies
- [ ] `createPostgresAdapter({ pool, table? })` and `createMysqlAdapter({ pool, table? })` factory functions
- [ ] DDL migration CLI for both packages, idempotent
- [ ] Integration tests against real Postgres 15+ and MySQL 8+ in Docker in CI
- [ ] READMEs covering: install, DDL setup, connection config, ops notes (backup, monitoring, capacity)
- [ ] ROADMAP.md entry under v0.11 adapter expansion
- [ ] Changesets for both packages
- [ ] Full turbo pipeline green

## Invariant compliance

- [x] **Zero-knowledge preserved** — Postgres/MySQL see only encrypted envelopes `{_noydb, _v, _ts, _iv, _data}`. No plaintext, no schema introspection, no content-based queries.
- [x] **6-method adapter contract unchanged** — both adapters use only the existing interface.
- [x] **AES-256-GCM + per-collection DEKs** unchanged — same crypto path as every other adapter.
- [x] **Optimistic concurrency** via `expectedVersion` — honored via conditional UPDATE.
- [x] **KEK never persisted** — unchanged, session-scoped in core.
- [x] **No new crypto dependencies** — `pg` and `mysql2` are pure driver libraries, no crypto.

## Related

- Discussion #66 (source — the "SQL-backed adapter" branch of the discussion)
- #107 — `@noy-db/decrypt-sql` (SQL export for migration, sibling from the same discussion)
- `@noy-db/dynamo` — reference single-table adapter this mirrors in shape

v0.11.0.
