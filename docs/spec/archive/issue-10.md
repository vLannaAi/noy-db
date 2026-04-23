# Issue #10 — @noy-db/pinia — defineNoydbStore (greenfield path)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-06
- **Milestone:** v0.3.0
- **Labels:** type: feature, release: v0.3, area: pinia

---

# `defineNoydbStore` — greenfield Pinia path

Part of #6 (v0.3 release).

## Scope

New package `packages/pinia/` published as `@noy-db/pinia`. Exports `defineNoydbStore(id, options)` — a drop-in replacement for `defineStore` that wires a Pinia store to a NOYDB compartment + collection automatically. Returned store exposes `items`, `byId(id)`, `count`, `add()`, `update()`, `remove()`, `refresh()`, `$ready`, `$ledger`. Compatible with `storeToRefs`, Vue Devtools, SSR, and `pinia-plugin-persistedstate`.

## Why

This is the central API for the v0.3 adoption goal. "Zero to working encrypted Pinia store in under two minutes" means `defineNoydbStore` exists and works in one line.

## Technical design

- `packages/pinia/src/defineNoydbStore.ts` — wraps `defineStore` from `pinia` with a setup-style factory that injects the NOYDB collection.
- Options: `{ compartment: string; collection?: string; schema?: StandardSchemaV1; cache?: { maxRecords?: number; maxBytes?: string }; prefetch?: boolean }`. `collection` defaults to the store id.
- Resolves the active `Noydb` instance from a context provided by either the Nuxt module (#2) or the augmentation plugin (#5). Throws a clear error if no instance is bound.
- `items` is a `shallowRef<T[]>` updated on every mutation. `byId` is a memoized lookup.
- `$ready` is a `Promise<void>` that resolves once the underlying collection has hydrated (or stays `idle` during SSR and resolves on the client).
- `$ledger` exposes the collection's ledger tail for devtools and verification.
- Schema validation runs through Standard Schema interfaces — works with Zod, Valibot, ArkType, Effect Schema. Validation runs before `add()`/`update()`.
- Tree-shakeable: pulling in `defineNoydbStore` must not pull in the query DSL or indexes from #6/#7 unless those features are actually used.

## Acceptance criteria

- [ ] **Implementation:** `packages/pinia/src/index.ts` exports `defineNoydbStore`. ESM + CJS, full `.d.ts`.
- [ ] **Unit tests:** `__tests__/defineNoydbStore.test.ts` with at least 14 `it()` blocks covering: greenfield instantiation against `@noy-db/memory`, `items` reactivity on `add`/`update`/`remove`, `byId` lookup, `count` reactivity, `$ready` resolves once per instance, schema validation throws on invalid input, persistence round-trip across reopen, multi-store isolation (two stores in two compartments do not bleed), `storeToRefs` returns reactive refs, SSR returns empty state without touching `crypto.subtle`, error thrown when no Noydb instance is bound, `$ledger` reports the latest entries, `prefetch: false` defers hydration until first access, `cache.maxRecords` enforced.
- [ ] **Integration tests:** end-to-end test that boots a real Pinia instance, mounts a Vue component using `useStore()`, and asserts reactive updates across two components.
- [ ] **Type tests:** `vitest expect-type` ensuring the returned store type is the intersection of the Pinia store and the NOYDB additions, with the schema record type flowing through.
- [ ] **Docs:** `packages/pinia/README.md` with the greenfield example from ROADMAP.md "4. `@noy-db/pinia` — greenfield path".
- [ ] **Changeset:** new package release at `0.3.0`.
- [ ] **CI:** `pinia` package added to the existing test matrix; no new workflow needed.
- [ ] **Bundle:** `defineNoydbStore` <8 KB gzipped.

## Dependencies

- Blocked by: #6 (query DSL — the store reuses the same record interface and exposes `query()`)
- Blocks: #1 (templates emit code calling `defineNoydbStore`), #2 (auto-imported by the Nuxt module), #10 (reference demo)

## Estimate

L

## Labels

`release: v0.3`, `area: pinia`, `type: feature`
