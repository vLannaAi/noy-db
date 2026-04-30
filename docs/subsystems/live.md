# live

> **Subpath:** *(currently always-core; `@noy-db/hub/live` extraction is a planned follow-up)*
> **Factory:** `withLive()` *(planned)*
> **Cluster:** A — Read & Query
> **LOC cost:** ~210 (planned — off-bundle when not opted in)

## What it does

Reactive subscriptions on collections and queries. `collection.subscribe(cb)` fires on every put/delete; `query.live()` returns a reactive value that re-runs the query when any input changes, propagating to subscribers. Joined queries merge change-streams from every join target.

## When you need it

- Vue / Pinia / React stores that need to re-render on data changes
- Real-time UIs (dashboards, live feeds, presence indicators)
- Collaborative features where remote pulls should update local UI

## Opt-in (current — always-on)

```ts
const stop = invoices.subscribe((event) => {
  // event: { type: 'put' | 'delete', id, record }
  console.log(event)
})

const live = invoices.query()
  .where('status', '==', 'open')
  .live()
live.subscribe(() => render(live.value))

// later
live.stop()
stop()
```

## API

- `collection.subscribe(cb)` → unsubscribe function
- `query.live()` → `LiveQuery<T>` with `.value`, `.subscribe()`, `.stop()`
- Framework integrations (`@noy-db/in-vue`, `@noy-db/in-react`, ...) wrap these into native reactive primitives

## Behavior when NOT opted in (post-extraction)

- `collection.subscribe(...)` and `query.live()` will throw with a pointer to `@noy-db/hub/live`
- One-shot reads (`.toArray()`, `.first()`, `.count()`) stay in core

## Pairs well with

- **joins** — reactive joins merge change-streams from every join target
- **crdt** — CRDT collection updates surface through live queries
- **sync** — pulls fire change events, propagating to live subscribers

## Edge cases & limits

- Subscriptions are in-process; cross-tab / cross-process reactivity needs an external coordinator (BroadcastChannel, sync engine)
- `live()` re-runs the query on every change — for hot collections, prefer `subscribe()` + manual delta application
- Stop subscriptions on unmount to avoid memory leaks

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `__tests__/query-live.test.ts`
- `packages/in-vue/src/composables.ts`
