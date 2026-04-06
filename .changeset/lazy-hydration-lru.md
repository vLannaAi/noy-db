---
"@noy-db/core": minor
---

Add lazy collection hydration with LRU eviction.

```ts
const invoices = compartment.collection<Invoice>('invoices', {
  prefetch: false,
  cache: { maxRecords: 1000, maxBytes: '50MB' },
});

await invoices.get('inv-001');     // adapter.get on miss; populates LRU
await invoices.put('inv-002', r);  // write-through, inserts in LRU
for await (const r of invoices.scan({ pageSize: 500 })) { /* ... */ }
```

The default `prefetch: true` keeps v0.2 behavior unchanged — eager mode loads everything into memory on first access. Setting `prefetch: false` switches to lazy mode where:

- `get(id)` populates the LRU on miss; subsequent reads are O(1) hits
- `put()` writes through the adapter and updates the LRU
- `scan()` streams via `listPage` and **does not pollute the LRU**
- `list()` and `query()` throw with a clear redirect to `scan()`
- `count()` works via `adapter.list()` (just enumerates ids, no record fetch)
- Indexes are not supported in lazy mode (rejected at construction time — v0.4 will lift this)

Cache options:

- `maxRecords` — number of records to keep before LRU eviction
- `maxBytes` — total decrypted byte budget. Accepts a number or `'50KB' | '50MB' | '1GB'`
- Both can be set; eviction happens until both budgets are satisfied

Diagnostics:

- `collection.cacheStats()` returns `{ hits, misses, evictions, size, bytes, lazy }` for monitoring and devtools

Closes #15.
