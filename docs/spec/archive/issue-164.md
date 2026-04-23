# Issue #164 — feat(core): routing & blob enhancements — write-behind queue, auto-health, middleware, presigned URLs, lifecycle policies

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-10
- **Closed:** 2026-04-10
- **Milestone:** v0.12.0
- **Labels:** type: feature, area: core, area: adapters

---

## Overview

Meta-issue collecting enhancement ideas for the store routing layer (#162, #163) and blob store (#105). These are features that emerge naturally from the v0.12 primitives and address real production patterns.

Grouped by impact and implementation complexity. Each can be a separate PR.

---

## Tier 1 — High impact, natural extension of existing primitives

### E1. Write-behind queue for suspended routes

**Problem:** \`suspend()\` drops writes into \`NullStore\` — they vanish. The sync engine's dirty tracking captures changes for sync targets, but not for the primary store. If the primary is overridden to \`memory()\` and the tab crashes, data is lost.

**Proposal:** An optional write-behind log that buffers operations during suspension and replays them on \`resume()\`:

\`\`\`ts
store.suspend('blobs', { queue: true })
// writes are queued in memory (or a fallback store)

store.resume('blobs')
// queued writes are replayed against the restored store
// returns { replayed: number, failed: number }
\`\`\`

**Design:** The queue is a \`DirtyEntry[]\`-like log with full envelopes. On \`resume()\`, entries are replayed in order with their original \`expectedVersion\`. Conflicts (version advanced while suspended) are surfaced via the existing conflict resolution strategy.

**Borderline:** queue size limit — if the user is offline for hours, the queue can grow unbounded. A \`maxQueueSize\` option with LRU eviction keeps memory bounded. When the queue overflows, oldest entries are dropped and the developer is notified via a \`'route:queue-overflow'\` event.

---

### E2. Hydrate-on-override

**Problem:** \`override('default', memory())\` starts with an empty store. The developer must manually \`loadAll()\` from the original and \`saveAll()\` into the override. This is error-prone and verbose.

**Proposal:** An option to automatically hydrate the override store from the original:

\`\`\`ts
// Pull all data from IDB into memory before switching
await store.override('default', memory(), { hydrate: true })

// Or hydrate specific collections only
await store.override('default', memory(), { hydrate: ['invoices', 'clients'] })
\`\`\`

**Design:** \`override()\` becomes async when \`hydrate\` is specified. It calls \`loadAll()\` on the original store, filters by collection if specified, and \`saveAll()\` into the override store before activating the switch. Reads during hydration still go to the original store (atomic switchover after hydration completes).

---

### E3. Auto health-based suspend/resume

**Problem:** The developer must detect unreachable stores and call \`suspend()\`/\`resume()\` manually. This is the same boilerplate every consumer writes.

**Proposal:** Built-in health monitoring with automatic suspend/resume:

\`\`\`ts
const store = routeStore({
  default: dynamo({ table: 'myapp' }),
  blobs: s3Store({ bucket: 'myapp-blobs' }),
  health: {
    checkIntervalMs: 30_000,       // ping every 30s
    suspendAfterFailures: 3,        // suspend after 3 consecutive failures
    resumeAfterSuccess: 1,          // resume after 1 successful ping
    onSuspend: (route) => { ... },  // callback for UI notification
    onResume: (route) => { ... },
  },
})
```

**Design:** A background timer calls \`ping()\` on each store. After N consecutive failures, the route is auto-suspended. After M successes, it's auto-resumed. The \`onSuspend\`/\`onResume\` callbacks let the developer update UI ("Working offline — changes will sync when connected").

**Composes with:** \`syncPolicy\` (\`onUnload\` push should skip suspended routes), \`SyncTarget[]\` (suspend individual sync targets independently).

---

### E4. Store middleware / interceptors

**Problem:** Cross-cutting concerns (logging, metrics, retry, caching, rate limiting) require wrapping every store method manually. There's no composable pattern.

**Proposal:** A \`wrapStore(store, ...middlewares)\` function:

\`\`\`ts
import { wrapStore, withRetry, withLogging, withMetrics } from '@noy-db/hub'

const resilientStore = wrapStore(
  dynamo({ table: 'myapp' }),
  withRetry({ maxRetries: 3, backoffMs: 1000 }),
  withLogging({ level: 'debug' }),
  withMetrics({ onOperation: (op) => statsd.increment(\`noydb.\${op.method}\`) }),
)
\`\`\`

**Built-in middlewares:**
- \`withRetry({ maxRetries, backoffMs, jitter })\` — retry with exponential backoff
- \`withLogging({ level, logger })\` — log every operation
- \`withMetrics({ onOperation })\` — emit metrics per method call
- \`withCircuitBreaker({ failureThreshold, resetTimeoutMs })\` — circuit breaker pattern
- \`withCache({ ttlMs, maxEntries })\` — read-through cache for \`get()\` calls

**Design:** Each middleware is a function \`(next: NoydbStore) => NoydbStore\`. They compose left-to-right (first middleware is outermost). The pattern is identical to HTTP middleware (Hono, Express) but for store operations.

---

## Tier 2 — Medium impact, blob-specific

### E5. Blob presigned URL passthrough

**Problem:** Serving a 50 MB PDF currently requires: S3 → server → decrypt → serve. For public-facing or authenticated downloads, the server is an unnecessary proxy.

**Proposal:** A \`BlobSet.presignedUrl(slot, opts?)\` method that returns a URL the browser can fetch directly:

\`\`\`ts
const url = await blobs.presignedUrl('invoice.pdf', { expiresIn: 3600 })
// → https://myapp-blobs.s3.amazonaws.com/...?X-Amz-Signature=...
\`\`\`

**The catch:** noy-db data is encrypted. The presigned URL returns ciphertext. Two approaches:

**(A) Service worker decryption:** A service worker intercepts the fetch, decrypts the ciphertext using the in-memory DEK, and serves the plaintext to the page. The DEK is passed to the worker via \`postMessage\`. The URL is a local \`blob:\` URL or a synthetic \`sw://\` URL.

**(B) Client-side decrypt-after-fetch:** The browser fetches the ciphertext via the presigned URL, then \`BlobSet.decryptResponse(response)\` decrypts it into a usable \`Response\`. No service worker needed, but the full ciphertext is in memory.

**(C) Unencrypted blob tier (opt-in):** For blobs that are explicitly marked as non-sensitive (e.g., company logo, public templates), store them unencrypted in S3 and serve presigned URLs directly. This breaks the zero-knowledge guarantee for those specific blobs — the developer opts in per-slot.

**Requires:** \`NoydbStore\` extension: \`presignUrl?(vault, collection, id, expiresIn): Promise<string>\`. Only S3 and GCS stores implement this.

---

### E6. Content-aware blob routing

**Problem:** All blob chunks go to the same store regardless of content type. But different content types have different access patterns and cost profiles.

**Proposal:** Route blobs by MIME type:

\`\`\`ts
const store = routeStore({
  default: dynamo({ table: 'myapp' }),
  blobs: {
    routes: {
      'image/*': cdnStore({ bucket: 'images', cdn: 'https://cdn.myapp.com' }),
      'video/*': streamStore({ bucket: 'videos', transcoder: '...' }),
      'application/pdf': s3Store({ bucket: 'documents' }),
    },
    default: s3Store({ bucket: 'myapp-blobs' }),
  },
})
\`\`\`

**Design:** BlobSet knows the MIME type at \`put()\` time (auto-detected or explicit). The router matches the MIME type against glob patterns. \`BlobObject.storeHint\` records which route was chosen so reads go to the correct store.

---

### E7. Blob lifecycle policies

**Problem:** Orphan blobs (\`refCount: 0\`) accumulate until \`blobGC()\` runs. Blobs not accessed in months waste storage. No declarative way to express retention rules.

**Proposal:** Declarative lifecycle rules evaluated during \`compact()\`:

\`\`\`ts
const db = await createNoydb({
  store: routeStore({ ... }),
  blobLifecycle: {
    // Delete orphans (refCount: 0) after 7 days
    orphanRetentionDays: 7,
    // Move blobs not accessed in 90 days to cold storage
    archiveAfterDays: 90,
    archiveStore: s3Glacier({ bucket: 'archive' }),
    // Hard delete after 365 days in archive
    expireAfterDays: 365,
  },
})
\`\`\`

**Composes with:** age-tiered routing (archive blobs move to the cold blob store), \`blobGC()\` (lifecycle runs as part of GC).

---

## Tier 3 — Lower priority, infrastructure

### E8. Quota-aware overflow

**Problem:** localStorage has a 5 MB limit. IDB quotas vary by browser (typically 50-80% of free disk). When the quota is exceeded, \`put()\` throws \`QuotaExceededError\` and the app crashes.

**Proposal:** The router detects quota pressure and overflows to a secondary store:

\`\`\`ts
const store = routeStore({
  default: browserIdbStore({ prefix: 'myapp' }),
  overflow: memory(), // or a remote store
  quotaThreshold: 0.8, // overflow when 80% of quota is used
})
\`\`\`

**Design:** Before each \`put()\`, check \`navigator.storage.estimate()\`. If usage exceeds the threshold, route to the overflow store. A \`'route:quota-overflow'\` event notifies the developer.

---

### E9. Progressive hydration

**Problem:** \`loadAll()\` on app start loads everything — hot and cold data. For a vault with 5 years of accounting data, this is slow and wasteful.

**Proposal:** Load only recent data on start; fetch cold data lazily on first access:

\`\`\`ts
const db = await createNoydb({
  store: routeStore({ ... }),
  hydration: {
    eager: { maxAgeDays: 90 },  // load last 90 days on open
    lazy: true,                  // older data fetched on get()
  },
})
\`\`\`

**Composes with:** age-tiered routing (hot store has recent data, cold store has old data — \`loadAll()\` only queries the hot store on start), the query engine's \`scan()\` method (can page through cold data without loading all into memory).

---

### E10. Read-through cache store

**Problem:** Blob chunks from S3 are fetched on every \`get()\`. For a PDF viewer that re-renders pages, this means repeated S3 round-trips.

**Proposal:** A caching store wrapper:

\`\`\`ts
import { withCache } from '@noy-db/hub'

const cachedS3 = withCache(s3Store({ bucket: 'blobs' }), {
  maxEntries: 100,
  ttlMs: 5 * 60 * 1000,  // 5 minutes
  storage: 'memory',       // or 'idb' for persistent cache
})
\`\`\`

**Design:** Intercepts \`get()\` — checks cache first, falls back to the underlying store on miss, populates cache on hit. \`put()\` and \`delete()\` invalidate the cache entry. This is the \`withCache\` middleware from E4, specialized for blob access patterns.

---

## Priority recommendation

| # | Feature | Impact | Effort | Depends on |
|---|---------|--------|--------|------------|
| E4 | Store middleware | Very high | Medium | Nothing — foundational |
| E2 | Hydrate-on-override | High | Low | #163 |
| E1 | Write-behind queue | High | Medium | #163 |
| E3 | Auto health suspend | High | Medium | #163, E4 |
| E5 | Presigned URLs | High (for S3 users) | High | Store interface extension |
| E7 | Blob lifecycle | Medium | Medium | #105, age tiering |
| E6 | Content-aware routing | Medium | Low | #162, storeHint |
| E9 | Progressive hydration | Medium | Medium | Age tiering |
| E10 | Read-through cache | Medium | Low | E4 middleware |
| E8 | Quota overflow | Low-medium | Medium | Browser-only |

**E4 (middleware) is the force multiplier** — retry, caching, circuit breaker, and health monitoring all become composable once the middleware pattern exists. Ship E4 first, then E3 and E10 become trivial middleware implementations.
