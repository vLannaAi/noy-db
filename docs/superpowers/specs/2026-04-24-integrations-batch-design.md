# Integrations Batch Design

**Date:** 2026-04-24
**Issues:** #271, #188, #272, #274, #273
**Approach:** Monolithic — all five in one implementation pass, one commit.

---

## Scope

Five deliverables, each with tests:

| # | Package | What |
|---|---------|------|
| #271 | `@noy-db/hub` | Route `DictionaryHandle` writes through the Collection emitter |
| #188 | `@noy-db/in-solid` | New package — SolidJS signal primitives |
| #272 | `@noy-db/in-rest` | New package — framework-neutral REST handler |
| #274 | `@noy-db/in-rest` | Subpath mounting adapters (Hono, Express, Fastify, Nitro) |
| #273 | `@noy-db/in-nuxt` | Extend module with `rest` config to mount `in-rest` via Nitro |

---

## #271 — Hub dict emitter fix

### Problem

`DictionaryHandle.put()` / `putAll()` / `delete()` / `rename()` write directly to the adapter and bypass the Collection emitter. Subscribers (including `useDictLabel`'s cache in `in-pinia`) don't receive change notifications.

### Fix

Pass `emitter: NoydbEventEmitter` as a new constructor parameter of `DictionaryHandle`. `vault.dictionary()` already holds `this.emitter` — pass it in.

After each mutating method, emit:

```ts
this.emitter.emit('change', {
  vault: this.compartmentName,
  collection: this.collName,   // e.g. '_dict_status'
  id: key,
  action: 'put' | 'delete',
} satisfies ChangeEvent)
```

- `put()` — emits after the adapter write and cache update.
- `putAll()` — no extra emit needed; it calls `put()` in a loop.
- `delete()` — emits `action: 'delete'` after the adapter delete.
- `rename()` — emits `action: 'delete'` for old key, `action: 'put'` for new key, after the adapter operations complete.

No composable-side change needed — `useDictLabel` already subscribes to the vault change stream.

### Test

`packages/hub/__tests__/dict-emitter.test.ts`

- Create vault with memory store.
- Subscribe to vault change events.
- Call `vault.dictionary('status').put('paid', { en: 'Paid', th: 'ชำระแล้ว' })`.
- Assert change event fires with `collection: '_dict_status'`, `action: 'put'`, `id: 'paid'`.
- Call `delete('paid')` — assert `action: 'delete'`.
- Call `rename('open', 'active')` — assert two events: delete + put.

---

## #188 — `@noy-db/in-solid`

### Package

```
packages/in-solid/
  src/index.ts
  __tests__/in-solid.test.ts
  package.json
  tsup.config.ts
  tsconfig.json
  vitest.config.ts
```

### API

Three signal factories. All follow SolidJS reactive primitives: `createSignal` + `createEffect` + `onCleanup`.

```ts
// Reactive record list
function createCollectionSignal<T>(
  vault: Vault,
  collectionName: string,
): [
  records: Accessor<T[]>,
  loading: Accessor<boolean>,
  error: Accessor<Error | null>,
]

// Reactive query result — builder re-runs on every change
function createQuerySignal<T, R>(
  vault: Vault,
  collectionName: string,
  builder: (q: Query<T>) => R | Promise<R>,
): [
  data: Accessor<R | null>,
  loading: Accessor<boolean>,
  error: Accessor<Error | null>,
]

// Noydb-level change feed
function createSyncSignal(db: Noydb): Accessor<ChangeEvent | null>
```

### Implementation notes

- `createEffect` runs the initial fetch and calls `coll.subscribe(() => refresh())`.
- `onCleanup` calls the returned unsubscribe function.
- No SolidJS DOM peer dep — only `solid-js` (the reactive core).
- `peerDependencies: { "@noy-db/hub": "workspace:*", "solid-js": "^1.8.0" }`.
- Build config and tsconfig copied from `in-svelte`.

### Test

`__tests__/in-solid.test.ts` — uses `createRoot` from `solid-js/reactive` (no DOM):

- `createCollectionSignal`: assert initial loading true → hydrated records after async tick.
- `createQuerySignal`: assert builder re-runs after `coll.put()`.
- `createSyncSignal`: assert signal updates after any collection write.

---

## #272 — `@noy-db/in-rest` (base handler)

### Package

```
packages/in-rest/
  src/
    index.ts          — createRestHandler, types
    router.ts         — route table + dispatch
    sessions.ts       — in-memory token store
    query-params.ts   — where/orderBy/limit parsing
    adapters/
      hono.ts
      express.ts
      fastify.ts
      nitro.ts
  __tests__/
    in-rest.test.ts
    adapters.test.ts
  package.json
  tsup.config.ts
  tsconfig.json
  vitest.config.ts
```

### Framework-neutral types

```ts
interface RestRequest {
  method: string
  pathname: string
  searchParams: URLSearchParams
  headers: Record<string, string>
  json(): Promise<unknown>
}

interface RestResponse {
  status: number
  headers: Record<string, string>
  body: string | Uint8Array | null
}

interface NoydbRestHandler {
  handle(req: RestRequest): Promise<RestResponse>
}
```

### Options

```ts
interface RestHandlerOptions {
  store: NoydbStore
  user: string
  ttlSeconds?: number   // default 900
  basePath?: string     // strip this prefix before routing, default ''
}
```

### Routes

All paths relative to `basePath`.

| Method | Path | Auth required | Description |
|--------|------|:---:|-------------|
| `POST` | `/sessions/unlock/passphrase` | No | Body `{ passphrase: string }` — creates Noydb, issues token |
| `GET` | `/sessions/current` | No | Returns `{ active: boolean }` |
| `DELETE` | `/sessions/current` | Bearer | Removes token from store |
| `GET` | `/vaults` | Bearer | Returns `string[]` of vault names |
| `GET` | `/vaults/:vault/collections/:collection` | Bearer | `coll.list()` + query-param filtering |
| `GET` | `/vaults/:vault/collections/:collection/:id` | Bearer | `coll.get(id)` |
| `POST` | `/vaults/:vault/collections/:collection/:id` | Bearer | `coll.put(id, body)` |
| `DELETE` | `/vaults/:vault/collections/:collection/:id` | Bearer | `coll.delete(id)` |

### Session store (`sessions.ts`)

```ts
interface Session {
  db: Noydb
  expiresAt: number
}

// Map<token: string, Session>
// token = crypto.randomUUID()
// cleanup: prune expired entries on every get()
```

Auth middleware: extract `Authorization: Bearer <token>` header. Return `401` JSON `{ error: 'unauthorized' }` if missing, invalid, or expired.

### Query-string parsing (`query-params.ts`)

`?where=field:op:value` → `.where(field, op, value)`.

Supported ops: `eq` → `==`, `neq` → `!=`, `gt` → `>`, `gte` → `>=`, `lt` → `<`, `lte` → `<=`.

Multiple `where` params ANDed via chained `.where()` calls. `?orderBy=field:asc|desc`. `?limit=N` truncates the result array.

Unknown ops → `400 { error: 'invalid_op', op }`.

### Error responses

All errors return JSON `{ error: string, message?: string }` with appropriate status codes:
- `400` — bad request body / invalid query param
- `401` — missing or expired token
- `403` — permission denied (hub throws `PermissionDeniedError`)
- `404` — record not found
- `500` — unexpected hub error (message sanitized)

### Test (`__tests__/in-rest.test.ts`)

Uses `createRestHandler` with memory store, calls `handler.handle()` directly:

1. `POST /sessions/unlock/passphrase` → 200 + token in body.
2. `GET /vaults` with token → 200 + `['acme']`.
3. `GET /vaults/acme/collections/invoices` with token → 200 + records array.
4. `POST /vaults/acme/collections/invoices/i1` with body → 200.
5. `GET /vaults/acme/collections/invoices/i1` → record returned.
6. `DELETE /vaults/acme/collections/invoices/i1` → 200.
7. `DELETE /sessions/current` → 204.
8. Subsequent request with same token → 401.
9. `?where=status:eq:paid` filters correctly.
10. Unknown op `?where=amt:pow:2` → 400.

---

## #274 — Mounting adapters (in-rest subpaths)

### Export shape

Added to `packages/in-rest/package.json`:

```json
{
  "exports": {
    ".": { "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./hono":    { "import": "./dist/adapters/hono.js",    "require": "./dist/adapters/hono.cjs" },
    "./express": { "import": "./dist/adapters/express.js", "require": "./dist/adapters/express.cjs" },
    "./fastify": { "import": "./dist/adapters/fastify.js", "require": "./dist/adapters/fastify.cjs" },
    "./nitro":   { "import": "./dist/adapters/nitro.js",   "require": "./dist/adapters/nitro.cjs" }
  }
}
```

`tsup.config.ts` gains additional entries: `src/adapters/hono.ts`, `src/adapters/express.ts`, `src/adapters/fastify.ts`, `src/adapters/nitro.ts`.

### Adapter APIs

```ts
// @noy-db/in-rest/hono
import type { Hono } from 'hono'
export function honoAdapter(handler: NoydbRestHandler): Hono

// @noy-db/in-rest/express
import type { Router } from 'express'
export function expressAdapter(handler: NoydbRestHandler): Router

// @noy-db/in-rest/fastify
import type { FastifyPluginAsync } from 'fastify'
export function fastifyPlugin(handler: NoydbRestHandler): FastifyPluginAsync

// @noy-db/in-rest/nitro
import type { EventHandler } from 'h3'
export function nitroAdapter(handler: NoydbRestHandler): EventHandler
```

### Adapter contract

Each adapter:
1. Receives the framework's native request object.
2. Builds a `RestRequest` from it (normalises `pathname`, `method`, `headers`, `searchParams`, `json()`).
3. Calls `handler.handle(restReq)`.
4. Writes `RestResponse.status`, `headers`, and `body` back to the framework's native response object.

Adapters import framework types only — no runtime framework import. Framework packages are `peerDependencies` (optional, `{ optional: true }`) so the base bundle remains zero-dep.

### Test (`__tests__/adapters.test.ts`)

Each adapter tested with a hand-crafted mock of the framework's request type:

- Build mock request → call adapter's internal normalisation → assert `RestRequest` shape is correct.
- Build a stub `NoydbRestHandler` that returns a fixed `RestResponse` → call adapter → assert framework response shape is correct.

No real HTTP server or framework runtime needed.

---

## #273 — `in-nuxt` REST mount

### Module option extension

New optional field on `ModuleOptions` in `packages/in-nuxt/src/module.ts`:

```ts
rest?: {
  enabled?: boolean      // default false
  basePath?: string      // default '/api/noydb'
  user?: string          // forwarded to createRestHandler
  ttlSeconds?: number    // session TTL seconds, default 900
}
```

### Module behaviour when `rest.enabled`

1. Adds `runtimeConfig.public.noydb.rest` containing the resolved rest config.
2. Calls `addServerHandler({ route: `${basePath}/**`, handler: resolve('./runtime/rest') })` via `@nuxt/kit`.

### New runtime file

`packages/in-nuxt/src/runtime/rest.ts`:

```ts
import { defineEventHandler } from 'h3'
import { createRestHandler } from '@noy-db/in-rest'
import { nitroAdapter } from '@noy-db/in-rest/nitro'
import { useRuntimeConfig } from '#imports'
// store resolved lazily from runtimeConfig on first request
```

The handler is constructed lazily: `createRestHandler` is called on first request using the store resolved from `runtimeConfig`. The `nitroAdapter` wraps it into an H3 `EventHandler`.

### Peer dep

`packages/in-nuxt/package.json` gains `"@noy-db/in-rest": "workspace:*"` in `peerDependencies`.

### Test (`__tests__/rest-module.test.ts`)

- Mock `@nuxt/kit` (same pattern as existing tests in the package).
- Assert that `addServerHandler` is called with `route: '/api/noydb/**'` when `rest: { enabled: true }`.
- Assert it is NOT called when `rest` is omitted or `enabled: false`.
- Assert `runtimeConfig.public.noydb.rest` is populated with resolved config values.

---

## Cross-cutting constraints

- Zero new npm crypto packages — all crypto stays in Web Crypto / `@noy-db/hub`.
- All tests use the `@noy-db/to-memory` pattern (duck-typed store, no network).
- No circular imports — `in-rest` imports from `@noy-db/hub`; `in-nuxt` peer-deps on `@noy-db/in-rest`; neither imports from each other.
- `peerDependencies` use `workspace:*` (not `workspace:^`) per monorepo convention.
- ESLint rules: no `any`, no `!` assertions, prefix unused params with `_`.
