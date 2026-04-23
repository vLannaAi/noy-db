# Issue #131 — feat(core): pluggable conflict policies — LWW, FWW, manual, custom merge fn

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.9.0
- **Labels:** type: feature, area: core

---

## Summary

Sync v2 (#v0.9) conflict resolution layer. When two users write the same record concurrently and then sync, the library must deterministically pick a winner or surface the conflict to the caller.

## Proposed API

```ts
// Collection-level conflict policy
const invoices = company.collection<Invoice>('invoices', {
  conflictPolicy: 'last-writer-wins', // default (current behaviour)
  // conflictPolicy: 'first-writer-wins',
  // conflictPolicy: 'manual',
  // conflictPolicy: (local, remote) => mergedRecord,
})

// Manual mode: surface conflicts via sync event
sync.on('conflict', ({ collection, id, local, remote, resolve }) => {
  // Call resolve(merged) to commit, or resolve(null) to defer
  resolve(local._ts > remote._ts ? local : remote)
})
```

## Conflict types

- `last-writer-wins` (default) — higher `_ts` wins. Deterministic. Current v0.x behavior.
- `first-writer-wins` — lower `_v` (earlier version) wins. Useful for append-only records.
- `manual` — surfaces a `conflict` event; caller resolves. Unresolved conflicts are queued.
- `CustomMergeFn` — synchronous `(local: T, remote: T) => T`. Must be pure.

## Out of scope

- CRDT mode (separate issue #85+)
- Field-level merge (requires CRDT)
- Conflict UI (consumer responsibility)

## Related

- Spawns from v0.9 sync v2 milestone
- Per-locale CRDT merging for `i18nText` fields gated on CRDT mode
