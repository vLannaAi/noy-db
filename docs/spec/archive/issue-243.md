# Issue #243 — feat(core): collection.subscribe(cb) — ergonomic all-records change stream

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.15.2 — First adoption patch (pilot #1 feedback)
- **Labels:** type: feature, area: core

---

Reported by pilot #1 (2026-04-23): *"query().live() exists for filtered sets, but no way to subscribe to all changes in a collection for the audit-trail / inbox-style UI."*

## The reality + the gap

The change-event stream **does exist** — `db.on("change", (e: ChangeEvent) => ...)`. It fires for every mutation on every collection. The pilots gap is ergonomic:

1. They have to filter `e.collection === "invoices"` in every handler.
2. They have to subscribe at the `Noydb` level instead of the `Collection<T>` level (less composable with their Pinia-per-collection organisation).
3. `query().live()` is not a great fit because it is a reactive *value*, not an event *stream* — running a `.live()` with no `.where()` clauses means the entire collection hydrates as the value, emitting every time anything changes. That works but semantically they want "inbox-of-events" not "current array state".

## Proposed API

```ts
// Per-collection, event-stream semantics
const unsubscribe = invoices.subscribe((event) => {
  if (event.type === "put") console.log("new / updated:", event.id, event.record)
  if (event.type === "delete") console.log("deleted:", event.id)
})

// Cleanup
unsubscribe()
```

Thin wrapper over the existing `db.on("change")` that filters to `this.collectionName` and unwraps the envelope. ~30 lines of hub code, 0 new primitives.

## Success criteria

- `collection.subscribe(cb)` fires for every put/delete on that collection, post-commit.
- Returns an `unsubscribe` function. Works outside component lifecycle.
- Matches the ergonomics pattern pilot is using with Pinia: one subscribe per Pinia store, one collection-change listener active per store.
- Documented in START_HERE.md + showcase #01 gains a `step N — subscribe to all changes` block.

Small ergonomic addition — fits v0.15.2 adoption patch. No interface change on the NoydbStore contract; purely hub surface.
