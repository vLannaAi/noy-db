# routing

> **Subpath:** *(currently always-core; planned for `@noy-db/hub/routing` before v0.26)*
> **Factory:** `withRouting()` *(planned)*
> **Cluster:** G — Operations
> **LOC cost:** ~1,985 (planned — off-bundle when not opted in)

## What it does

Multi-store routing (route different collections to different backends), store middleware (retry, circuit breaker, metrics, logging, caching, health check), sync-policy declarations for indexed-store optimization, lazy-mode + LRU cache primitives, and bundle-store wrapping. The "advanced storage operations" cluster.

## When you need it

- Hot/cold tiering (memory store for working set, S3 for archive)
- Resilience middleware (retry transient failures, trip a circuit on persistent ones)
- Bundle-as-store (one `.noydb` file as the backing store)
- Lazy mode for vaults beyond the in-memory cap
- Custom logging / metrics around store operations

## Opt-in (current — always-on)

```ts
import {
  routeStore, wrapStore, createBundleStore,
  withRetry, withCircuitBreaker, withMetrics, withLogging, withCache,
} from '@noy-db/hub'

const routed = routeStore({
  default: postgres({ url: '...' }),
  '_blob*': r2({ /* ... */ }),
  '_audit_*': dynamoDb({ /* ... */ }),
})

const resilient = wrapStore(routed, [
  withRetry({ maxAttempts: 3 }),
  withCircuitBreaker({ failureThreshold: 5 }),
  withMetrics({ onCall: ... }),
])

const db = await createNoydb({ store: resilient, ... })
```

Lazy mode:

```ts
vault.collection<Invoice>('invoices', {
  prefetch: false,
  cache: { maxRecords: 5_000, maxBytes: '50MB' },
})
```

## API

- `routeStore({ default, [pattern]: store, ... })` — pattern-based routing
- `wrapStore(store, [middleware...])`
- `createBundleStore(...)` — read/write a `.noydb` bundle as a regular store
- Middleware: `withRetry`, `withCircuitBreaker`, `withHealthCheck`, `withMetrics`, `withLogging`, `withCache`

## Behavior when NOT opted in (post-extraction)

- `routeStore`, `wrapStore`, etc. will throw with pointers to `@noy-db/hub/routing`
- Plain single-store usage stays in core

## Pairs well with

- **indexing** — lazy mode requires indexes for non-trivial queries
- **bundle** — bundle-store wraps a `.noydb` file
- **sync** — sync-policy declarations live here

## Edge cases & limits

- Routing patterns are evaluated in order; first match wins. Default catches anything unmatched
- Circuit breaker auto-recovers via half-open probes; `recover()` forces an immediate retry
- Cache middleware is store-level (not record-level) and respects expectedVersion CAS

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `__tests__/route-store.test.ts`, `__tests__/store-middleware.test.ts`, `__tests__/bundle-store.test.ts`
- `showcases/src/03-store-routing.showcase.test.ts`, `showcases/src/08-resilient-middleware.showcase.test.ts`
