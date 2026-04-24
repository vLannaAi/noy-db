# Issue #13 — Encrypted secondary indexes in @noy-db/core

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-06
- **Milestone:** v0.3.0
- **Labels:** type: feature, release: v0.3, area: core

---

# Encrypted secondary indexes

Part of #6 (v0.3 release).

## Scope

Add per-collection secondary indexes to `@noy-db/core`. Indexes are declared at collection definition: `indexes: ['status', 'dueDate', { fields: ['clientId', 'status'] }]`. Computed client-side after decryption, then stored as a separate AES-256-GCM encrypted blob alongside the collection. Adapters never see plaintext index data. Index maintenance hooks fire on `add`/`update`/`remove`. Used by the query DSL (#6) for fast-path lookups, but the DSL works without indexes too.

## Why

Indexes are required to hit the v0.3 acceptance criterion "indexed queries are measurably faster than linear scans on a 10K-record benchmark". They unlock the power surface for any consumer with more than a few thousand records per collection.

## Technical design

- New module `packages/core/src/index/`:
  - `types.ts` — `IndexDef = string | { fields: string[]; unique?: boolean }`.
  - `builder.ts` — builds an index from the in-memory record array.
  - `maintenance.ts` — incremental update hooks for add/update/remove.
  - `storage.ts` — encrypts/decrypts the index blob using the collection's DEK with a fresh IV; stores under id `__noydb_index_<name>` via the existing 6-method adapter contract (no new adapter methods).
- Index storage shape: `{ _noydb: 1, _v, _ts, _iv, _data }` — same envelope as records, so adapters need no changes.
- Index payload (after decryption): `{ name, fields, type: 'hash' | 'sorted', entries: Array<[key, recordId[]]> }`.
- On `compartment.open()`, indexes are loaded lazily on first query that could use them; first miss triggers a build from in-memory records and a write-back.
- Composite indexes serialize their key as a stable joined string.
- The query executor in #6 checks for an index covering the leading `where` clause before scanning.
- `unique: true` indexes throw on duplicate insert.
- Indexes are invalidated and rebuilt on key rotation.

## Acceptance criteria

- [ ] **Implementation:** `packages/core/src/index/` with the four files above; `Collection` config accepts `indexes`.
- [ ] **Unit tests:** at least 18 `it()` blocks across `builder.test.ts`, `maintenance.test.ts`, `storage.test.ts`. Cover: single-field hash index build, sorted index build, composite index build, incremental add/update/remove, unique constraint enforcement, encrypted blob round-trip, IV uniqueness across writes, tamper detection on the index blob, lazy load on first query, rebuild on key rotation, adapter only sees ciphertext for indexes (assert by spying on a memory adapter), index name collision rejected, removing a record cleans up empty buckets.
- [ ] **Integration tests:** seed 10K records, build a `status` index, run an indexed query, assert it returns identical results to a non-indexed run.
- [ ] **Benchmark test:** `bench/indexed-vs-linear.bench.ts` using vitest's `bench` API; CI gate ensures indexed query is at least 5× faster than linear scan on 10K records.
- [ ] **Type tests:** `IndexDef` types check; field names constrained to schema keys when a schema is provided.
- [ ] **Docs:** add an "Indexes" section in `docs/guides/end-user-features.md` and the core README.
- [ ] **Changeset:** included in core `0.3.0`.
- [ ] **CI:** existing core test job runs the bench in a guarded mode.
- [ ] **Bundle:** index module <4 KB gzipped; core total stays under 30 KB.

## Dependencies

- Blocked by: nothing (parallel with #6; the indexed-fast-path test in #6 depends on this landing first, but the basic DSL does not)
- Blocks: nothing strict; #6's "indexed query fast path" test requires this.

## Estimate

L

## Labels

`release: v0.3`, `area: core`, `type: feature`
