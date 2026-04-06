---
"@noy-db/core": minor
---

Add secondary indexes to the query DSL.

Declare indexes per-collection:

```ts
const invoices = compartment.collection<Invoice>('invoices', {
  indexes: ['status', 'client'],
});
```

The query executor consults indexes when a `where` clause uses `==` or `in` against an indexed field, falling back to a linear scan otherwise. Indexed queries are measurably faster than linear scans on collections with thousands of records.

Properties:

- **In-memory only.** Indexes are built during hydration and maintained incrementally on `put`/`delete`. Persistent encrypted index blobs are deferred to a follow-up — at the v0.3 target scale of 1K–50K records, hydrate-time index building is essentially free, so persistence buys nothing measurable.
- **Zero-knowledge preserved.** Adapters never see plaintext index data. The index lives entirely in memory after decryption, alongside the existing record cache.
- **Backward-compatible.** Collections without `indexes:` work exactly as before. The query DSL falls back to a linear scan transparently.
- **Single-field hash indexes only** for v0.3. Composite, sorted, and unique-constraint indexes will land in v0.4 as additive variants.

Closes #13.
