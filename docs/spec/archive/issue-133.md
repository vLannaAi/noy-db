# Issue #133 — feat(core): partial sync — filter by collection name or modifiedSince timestamp

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.9.0
- **Labels:** type: feature, area: core

---

## Summary

Allow sync to operate on a subset of collections or records, reducing bandwidth and latency for large compartments.

## Proposed API

```ts
// Sync only specific collections
await sync.push({ collections: ['invoices', 'clients'] })
await sync.pull({ collections: ['invoices'] })

// Sync only records modified after a timestamp
await sync.pull({ modifiedSince: '2026-04-01T00:00:00Z' })

// Combine
await sync.pull({
  collections: ['invoices'],
  modifiedSince: lastSyncTimestamp,
})
```

## Adapter requirements

Adapters that support partial sync implement `listSince(compartment, collection, since: string): Promise<string[]>`. Falls back to full scan for adapters that don't implement it.

## Related

- Enables efficient mobile sync in the first consumer's offline-first workflow
- Pairs with sync transactions (separate issue)
