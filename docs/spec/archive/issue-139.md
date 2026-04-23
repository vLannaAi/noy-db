# Issue #139 — fix(browser): IndexedDB CAS not atomic — split readwrite transactions allow concurrent clobber

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.10.0
- **Labels:** type: bug, priority: medium, area: adapters

---

## Bug

The IndexedDB `put()` implementation in `packages/browser/src/index.ts` uses **two separate transactions** for the version check and the write — making the compare-and-swap non-atomic.

```ts
// current (broken)
const { store: readStore } = await tx('readonly')    // tx 1
const existing = await idbRequest(readStore.get(k))
// ← a concurrent writer can slip in here
const { store, complete } = await tx('readwrite')    // tx 2
store.put(value, k)
```

Two concurrent callers with the same `expectedVersion` can both pass the version check (each in their own readonly tx), then both succeed on the write. Result: **silent clobber** — last writer wins with no `ConflictError`.

## Expected behaviour

Exactly one concurrent writer succeeds. All others receive `ConflictError`. This is the contract every other adapter with real CAS (`@noy-db/dynamo`, `@noy-db/memory`) upholds.

## Root cause

The check and the write must share a single `readwrite` transaction. IndexedDB's `readwrite` transaction holds an exclusive lock on the object store for its duration — that lock is what makes the CAS atomic.

```ts
// fix
const { store, complete } = await tx('readwrite')    // one tx
const existing = await idbRequest(store.get(k))      // get inside the same tx
if (existing?._v !== expectedVersion) throw new ConflictError(...)
store.put(value, k)
await complete
```

## Impact

Low in practice today — normal single-tab use has no concurrent writers. Becomes a real hazard in:
- Multi-tab scenarios where two tabs open the same compartment and write concurrently
- Service worker + main thread writing to the same origin simultaneously

## Note on localStorage backend

The `localStorage` backend in the same package is **not affected** — its `getItem` + `setItem` are synchronous and therefore already atomic within a single tab.

## Context

Identified during D2 (conflict integrity) analysis of the adapter probe design — see discussion #138.
