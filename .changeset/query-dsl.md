---
"@noy-db/core": minor
---

Add reactive query DSL via `collection.query()`. Returns a chainable, immutable `Query<T>` builder with operators `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `contains`, `startsWith`, `between`, plus a `.filter(fn)` escape hatch and `.and()`/`.or()` composition. Terminal methods: `.toArray()`, `.first()`, `.count()`, `.subscribe()`, `.toPlan()`. Plans are JSON-serializable for devtools and Web Worker offloading. All filtering runs client-side after decryption — preserves zero-knowledge.

The legacy predicate form `collection.query(record => boolean)` is still supported as an overload for backward compatibility.

Closes #12.
