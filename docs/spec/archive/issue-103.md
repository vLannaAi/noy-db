# Issue #103 — feat(core): NoydbBundleAdapter interface — second adapter shape for blob-store backends

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-10
- **Milestone:** v0.12.0
- **Labels:** type: feature, area: core, area: adapters

---

## Target package

`@noy-db/core`

## Spawned from

Discussion #93 — Bundle adapter shape. Full structural rationale for why consumer cloud storage doesn't fit the per-record adapter contract lives in the discussion.

## Problem

Every current adapter (`memory`, `file`, `s3`, `dynamo`, `browser`) implements the same 6-method `NoydbAdapter` interface, which assumes a **key-addressable record store**: `{compartment}/{collection}/{id}` resolves to one blob and you can `get`/`put`/`delete`/`list` by that key. This fits S3, DynamoDB, filesystems, and IndexedDB cleanly.

It does not fit consumer cloud storage — Google Drive, Dropbox, OneDrive, iCloud. Structural mismatches:

1. **Opaque file IDs, not paths.** Every `get(path)` is a metadata lookup + body fetch. Path→id resolution is not O(1).
2. **Aggressive per-user rate limits.** Drive ~12k req/user/min, Dropbox ~600/min. A cold `loadAll()` over 5,000 records trips both.
3. **No prefix streaming.** List returns metadata; bodies require N additional fetches.
4. **User's mental model is \"one file.\"** The unit of share/move/delete/restore on consumer drives is a single file. Ten thousand invisible child records violate the abstraction.

The right move is a **second adapter shape** that treats the entire compartment as a single blob. This keeps the per-record adapters honest (S3 stays record-granular because S3 genuinely is) while giving cloud-sync adapters an API that matches their physics.

## Scope

- **Define `NoydbBundleAdapter` interface in `@noy-db/core`:**
  ```ts
  export interface NoydbBundleAdapter {
    readonly name: string
    readonly kind: 'bundle'

    pullBundle(handle: string): Promise<{ bytes: Uint8Array; version: string | null }>
    pushBundle(handle: string, bytes: Uint8Array, expectedVersion: string | null): Promise<{ version: string }>
    deleteBundle(handle: string): Promise<void>
    listBundles(): Promise<Array<{ handle: string; version: string; size: number }>>
  }
  ```

- **Engine integration** — `createNoydb()` accepts either a `NoydbAdapter` (per-record) or a `NoydbBundleAdapter`. With a bundle adapter, the engine:
  - On `open()`: `pullBundle()` → `readNoydbBundle()` → `loadCompartment()`.
  - On flush (driven by `syncPolicy` from #101): `dumpCompartment()` → `writeNoydbBundle()` → `pushBundle(expectedVersion)`.
  - On conflict (`expectedVersion` mismatch): surface to the consumer-configured conflict strategy.

- **Bundle adapter conformance tests** — a new shared conformance suite for bundle adapters (parallel to the existing per-record adapter conformance in `test-harnesses/adapter-conformance`), covering happy path, optimistic concurrency conflict, delete, list, and round-trip integrity.

- **Reference implementation: `@noy-db/memory-bundle`** — in-memory bundle adapter for testing. Ships alongside the interface.

- **Bundle handles use the ULID from #100** — the handle persisted in `_meta/handle` is the exact key the bundle adapter uses. No new identifier scheme.

## Out of scope (separate issues under v0.11)

- `@noy-db/drive` — Google Drive adapter (discussion #94)
- `@noy-db/dropbox` — Dropbox adapter
- `@noy-db/icloud` — iCloud adapter (if API access materializes)
- Bundle chunking / multi-part for very large compartments
- Server-side operations (CopyObject-style) — consumer drives don't generally expose these

## Acceptance

- [ ] `NoydbBundleAdapter` interface + `kind: 'bundle'` discriminant exported from `@noy-db/core`
- [ ] Engine accepts both adapter shapes, selects the right sync codepath based on `kind`
- [ ] Optimistic concurrency via opaque `version` token, `expectedVersion` mismatch surfaces `BundleVersionConflictError`
- [ ] `@noy-db/memory-bundle` reference implementation + tests
- [ ] Shared conformance suite under `test-harnesses/bundle-adapter-conformance`
- [ ] `syncPolicy` integration — bundle adapters declare a `defaultSyncPolicy` that biases toward debounce (see #101)
- [ ] Docs: `docs/bundle-adapters.md` with interface spec, contract invariants, example consumer adapter
- [ ] Changeset

## Invariant compliance

- [x] Adapters never see plaintext — bundle body is the existing encrypted `dump()` output wrapped in the #100 container
- [x] KEK/DEK handling unchanged
- [x] Zero new crypto dependencies

## Related

- #100 — `.noydb` container format (blocks this)
- #101 — syncPolicy (composes with this)
- Discussion #93 (source)
- Discussion #94 / #94-spawned-issue — @noy-db/drive first consumer

v0.11.0.
