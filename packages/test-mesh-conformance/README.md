# @noy-db/test-mesh-conformance

Contract tests for the `by-*` family port. Every `NoydbMesh` implementation — `by-peer`, `by-tabs`, the reserved `by-server`/`by-room`, or your own — runs the same suite.

```ts
import { runMeshConformanceTests } from '@noy-db/test-mesh-conformance'
import { pairInMemory, channelCoordination } from '@noy-db/by-peer'

runMeshConformanceTests('my-transport', {
  pair: () => {
    const [x, y] = pairInMemory()
    return [channelCoordination(x), channelCoordination(y)] as const
  },
})
```

## The fixture is a PAIR, not an instance

That is the whole point. A mesh's defining property is that **two participants see each other**; a suite built around a single instance passes on an implementation that shares nothing — which is exactly the implementation that lets a schema cutover proceed while another writer still believes the vault is normal.

Mutation-checked against `by-peer`: disabling the broadcast fails **5 of 9**; disabling the staleness filter fails exactly **1**.

## What it checks

A usable default fence before anything is written; `setFence` → `readFence` on the same participant **and across the pair**; `observeFence` firing on the other side and stopping after unsubscribe; `reportPresence` reachable from the other side; `reachableWriters` excluding entries older than `staleMs`; `observePresence` firing; and vault isolation.

Two of those carry most of the weight. **Cross-participant visibility** is the property a single-instance test cannot see. And **staleness filtering** is what stops a dead writer hanging a drain barrier until timeout — the failure the filter exists to prevent.

Every observation goes through a polling `waitFor`, because delivery is asynchronous on every transport: push-based ones deliver on a microtask, `StoreMesh` on its next poll. An implementation that only ever delivers on the next poll is conformant — slow, but conformant.

## ⚠️ `StoreMesh` cannot run this suite, and neither side can fix it alone

`StoreMesh` is hub's store-polling fallback — the implementation most consumers actually run when no `by-*` transport is injected. It is **not covered here**, and the reason is structural rather than an omission:

- **the kit cannot import it** — it is internal, deliberately not exported (`port/by/index.ts` says so outright, its only consumer being `with-shape/schema-update`);
- **hub cannot import the kit** — the kit peer-depends on hub, so that is a build cycle turbo refuses.

The sealer kit does not hit this only because `MemorySealer` happens to be exported. **Generalise before the next vertical: a port's in-hub default implementation is coverable by its published kit only if it is on the published surface.** Closing it for `by-*` means deciding whether an internal default belongs on the public surface — a real decision, not a test change.

Until then `StoreMesh`'s conformance is asserted only indirectly, by the schema-fence tests that happen to exercise it.
