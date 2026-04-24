# Issue #14 — Paginated listPage() and streaming scan() in @noy-db/core + adapters

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-06
- **Milestone:** v0.3.0
- **Labels:** type: feature, release: v0.3, area: core, area: adapters

---

# Paginated `listPage()` and streaming `scan()`

Part of #6 (v0.3 release).

## Scope

Add an optional adapter extension `listPage(compartment, collection, cursor?, limit?)` to `@noy-db/core`'s adapter interface (the original 6 methods stay sacred — this is an *optional* extension declared via capability flag). Add `collection.scan()` returning an `AsyncIterable<T>` that streams decrypted records page by page so 100K-record collections can be processed without loading everything into memory. Implement `listPage` in `@noy-db/memory`, `@noy-db/file`, `@noy-db/dynamo`, `@noy-db/s3`, and `@noy-db/browser`.

## Why

The v0.2 model loads everything into memory. The v0.3 acceptance criterion says streaming `scan()` must handle 100K records under 200MB peak memory. This is the foundation for lazy hydration (#9) and for any consumer with large compartments.

## Technical design

- Optional adapter capability: `adapter.listPage?: (compartment, collection, cursor?, limit?) => Promise<{ items: EncryptedEnvelope[]; nextCursor: string | null }>`. The 6-method core contract is unchanged; this is an *additional* method discovered via `'listPage' in adapter`.
- Cursors are opaque adapter-defined strings (DynamoDB: `LastEvaluatedKey` JSON; file: numeric offset; memory: numeric offset; s3: continuation token).
- `Collection.scan(opts?: { pageSize?: number })` returns `AsyncIterable<T>` and uses `listPage` when available, falling back to `loadAll` + slice for adapters without it (with a warning).
- `Collection.listPage({ cursor?, limit? })` is the typed wrapper applications call directly.
- The Pinia store's `loadMore()` (used by #4) calls `listPage` under the hood.
- Encryption boundary respected: every page is decrypted in core after the adapter returns ciphertext.

## Acceptance criteria

- [ ] **Implementation:** `Adapter` type updated with optional `listPage`; `Collection.scan()` and `Collection.listPage()` implemented; all five built-in adapters add `listPage`.
- [ ] **Unit tests:** at least 16 `it()` blocks total across the touched packages. Core: scan yields all records in order, scan respects `pageSize`, scan terminates on null cursor, listPage round-trip, fallback path for adapters without `listPage` emits a warning. Memory: pagination by offset. File: pagination by sorted filename. DynamoDB: cursor encodes `LastEvaluatedKey`. S3: cursor encodes continuation token. Browser: pagination over IndexedDB cursor.
- [ ] **Integration tests:** seed 10K records via `@noy-db/memory`, scan with `pageSize: 500`, assert all records returned exactly once.
- [ ] **Memory benchmark:** end-to-end test that seeds 100K records to `@noy-db/file` and scans them; asserts peak heap stays under 200MB (using `process.memoryUsage().heapUsed` deltas).
- [ ] **Type tests:** `expect-type` confirms `scan()` returns `AsyncIterable<T>` and `listPage` types narrow correctly.
- [ ] **Docs:** new section in `docs/packages/stores.md` describing the optional capability; update `docs/guides/end-user-features.md`.
- [ ] **Changeset:** minor bumps on core + all five adapter packages.
- [ ] **CI:** existing test matrix; add the 100K-record memory benchmark behind a `BENCH=1` env flag so it runs only on the release branch.
- [ ] **Bundle:** core stays under 30 KB; each touched adapter stays under 10 KB.

## Dependencies

- Blocked by: nothing
- Blocks: #9 (lazy hydration uses pagination internally)

## Estimate

L

## Labels

`release: v0.3`, `area: core`, `type: feature`
