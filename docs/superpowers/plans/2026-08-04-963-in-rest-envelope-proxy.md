# in-rest envelope-proxy re-architecture (#963 finding 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Re-architect `@noy-db/in-rest` so the HTTP server proxies ONLY `EncryptedEnvelope`s — it never receives the passphrase, never unlocks a vault, never sees plaintext. Closes #963 finding 2 (external security review: the server currently takes the passphrase server-side and returns/accepts plaintext).

**Architecture:** Replace the session/unlock/plaintext-CRUD server with a thin RPC dispatcher that forwards the 6 `NoydbStore` methods straight to the caller-supplied ciphertext store — the exact shape of `by-peer`'s `servePeerStore` (packages/by-peer/src/serve.ts), transported over HTTP instead of a PeerChannel. The client that consumes it (a `to-rest` `NoydbStore` over HTTP, the mirror of `peerStore()`) belongs in the **noy-db-to** companion repo, not here — filed as a companion issue. All unlock/query/crypto move to the client; the server is a dumb, untrusted ciphertext relay, consistent with the family's storage-backend law.

**Tech Stack:** TS ESM, vitest, pnpm. Package: `@noy-db/in-rest` (Node ≥22, ESM-only). Peer: `@noy-db/hub` (workspace:*).

## Global Constraints
- Branch `fix/963-in-rest-envelope-proxy` (off main, already checked out). Commit per task. **NEVER add Claude/AI attribution** to commits/changesets/docs. Grep the diff for any private-client name before each commit.
- This is a **BREAKING** change to a published package → a **major**-intent changeset (`'@noy-db/in-rest': major`; pre-1.0 so it's a minor version bump but the changeset body must call it breaking). The old `/sessions/*` + plaintext `/vaults/*` HTTP API is removed entirely.
- hub is NOT modified. `@noy-db` must never import `@klum-db`. The server must never call `createNoydb`, `openVault`, or any decrypt path.
- Gates: `pnpm --filter @noy-db/in-rest test` + `pnpm --filter @noy-db/in-rest typecheck` + `pnpm --filter @noy-db/in-rest build` + `pnpm lint`. For Task 2 also `pnpm --filter @noy-db/in-nuxt test && typecheck && build`. All green.

## Verified source facts (from recon — see .superpowers/sdd/scratch-in-rest-recon.md)
- `packages/in-rest/src/`:
  - `index.ts` — `RestRequest{method,pathname,searchParams,headers,json()}`, `RestResponse{status,headers,body}`, `NoydbRestHandler{handle(req)}`, `RestHandlerOptions{store,user,ttlSeconds?,basePath?}`, `createRestHandler` (builds `SessionStore` + `buildRouter`).
  - `router.ts` — `buildRouter(store,user,sessions,basePath)`; helpers `json()`, `extractToken()` (Bearer), `stripBase()`; error map `PermissionDeniedError→403, NotFoundError→404, ConflictError→409, else 500`. Contains ALL the plaintext/session routes to delete.
  - `sessions.ts` — `SessionStore` holding unlocked `Noydb` handles. **DELETE the file.**
  - `query-params.ts` — server-side query parser. **DELETE the file** (query is client-side now).
  - `adapters/{hono,express,fastify,nitro}.ts` — thin HTTP↔RestRequest marshallers, store-agnostic. **KEEP unchanged** (they only marshal; a catch-all route still works for a single `/rpc` POST).
- `@noy-db/hub/to` store contract (kernel/types.ts:581-619): `get(v,c,id)→EncryptedEnvelope|null`, `put(v,c,id,env,expectedVersion?)→void`, `delete(v,c,id)→void`, `list(v,c)→string[]`, `loadAll(v)→VaultSnapshot`, `saveAll(v,data)→void`. Optional: `ping`, `listSince(v,c,since)`, `listPage(v,c,cursor?,limit?)→ListPageResult`, `listVaults`, `getStoreTime`. `ConflictError` carries `.version`. Import these types from `@noy-db/hub` / `@noy-db/hub/to`.
- by-peer template — `serve.ts` `startServing`: `serveRpc(channel, async (method,args)=>{ if(!CORE_METHODS.has(method)) throw; if(allow && !allow.has(method)) throw; switch(method){ case 'get': const [v,c,id]=args; return store.get(v,c,id); case 'put': const [v,c,id,env,ev]=args; await store.put(...); return null; ... } })`. Client `peer-store.ts` re-hydrates: `if (e.name==='ConflictError' && typeof e.version==='number') throw new ConflictError(e.version, e.message)`.

---

### Task 1: replace the router with an envelope-proxy RPC dispatcher + fail-closed auth + rewrite tests

**Files:**
- Rewrite: `packages/in-rest/src/router.ts`, `packages/in-rest/src/index.ts`.
- Delete: `packages/in-rest/src/sessions.ts`, `packages/in-rest/src/query-params.ts`, `packages/in-rest/__tests__/session-sweep.test.ts`.
- Rewrite: `packages/in-rest/__tests__/in-rest.test.ts` (drop the plaintext/session assertions; assert envelope pass-through + no-plaintext-server-side).
- Keep untouched: `packages/in-rest/src/adapters/*`.

**New wire contract:** a single endpoint `POST {basePath}/rpc` with JSON body `{ method: string, args: unknown[] }`.
- Success → `200`, body = JSON of the store method's return (`EncryptedEnvelope | null | string[] | VaultSnapshot | ListPageResult | boolean`); void methods (`put`/`delete`/`saveAll`) return `null`.
- `ConflictError` → `409`, body `{ error: { name: 'ConflictError', message, version } }` (version MUST be included so a client re-hydrates CAS semantics).
- Unauthorized → `401`, body `{ error: { name: 'Unauthorized', message } }`.
- Unknown method → `400`; method not in `allow` set → `403`; malformed body (`method` missing / `args` not an array) → `400`.
- Any other thrown store error → `500`, body `{ error: { name: err.name, message } }` (never leak a stack).

**New `RestHandlerOptions`:**
```ts
export interface RestHandlerOptions {
  readonly store: NoydbStore
  /** Authorize each request. Return true to allow. If OMITTED, the handler is FAIL-CLOSED (every request → 401) — the caller MUST supply an authorizer. */
  readonly authorize?: (req: RestRequest) => boolean | Promise<boolean>
  /** Optional method allowlist (e.g. a read-only relay). When set, a method not in the set → 403. */
  readonly allow?: ReadonlySet<string>
  readonly basePath?: string
}
```
Drop `user` and `ttlSeconds` entirely. `createRestHandler` no longer builds a `SessionStore`; it builds the RPC router directly. Keep `RestRequest`/`RestResponse`/`NoydbRestHandler` shapes unchanged (adapters depend on them).

**Router behavior:** `buildRouter(opts)` returns `(req) => Promise<RestResponse>`:
1. Match `POST {basePath}/rpc` (reuse `stripBase`). Any other path/method → `404` (no more `/sessions`/`/vaults`).
2. **Auth first:** `const ok = opts.authorize ? await opts.authorize(req) : false;` — omitted authorizer ⇒ `false` ⇒ `401` (fail-closed). Non-`/rpc` paths still 404 before auth is irrelevant; do auth on the `/rpc` route.
3. Parse body via `req.json()`; validate `{method, args}`.
4. Dispatch with the SAME `switch(method)` as `serve.ts` (lift it, adapt `serveRpc`→direct call): CORE_METHODS gate → `allow` gate → `switch` calling `store.*` with the positional `args` tuple; optional methods guard on `store.<m>` presence and 400/501 if unsupported.
5. Map thrown `ConflictError` (import from `@noy-db/hub`) → 409 with `version`; everything else per the table above.

- [ ] **Step 1: rewrite the tests first (red).** In `in-rest.test.ts`, using a `toMemory()` store SEEDED with real `EncryptedEnvelope`s (put an envelope directly into the store, or via a hub collection then read the raw envelope). Cases:
  - **Envelope pass-through:** `POST /rpc {method:'get', args:[vault,coll,id]}` with a valid authorizer returns the exact stored `EncryptedEnvelope` (deep-equal), and its `_data` stays base64 ciphertext — the server never decrypts. `put`/`delete`/`list`/`loadAll`/`saveAll` similarly forward and return the raw store result.
  - **No plaintext / no passphrase server-side (the security invariant):** there is NO route that accepts a `secret`/passphrase or returns a decrypted record. Assert `POST /rpc {method:'unlock'|'secret',...}` → 400 unknown method; assert a `put` of an envelope then `get` returns the SAME ciphertext envelope (round-trips ciphertext, not plaintext). A negative assertion: the handler never calls `createNoydb` (structurally guaranteed — no import; you may assert the module doesn't import it).
  - **CAS conflict:** a `put` with a stale `expectedVersion` → 409 with `{error:{name:'ConflictError', version:<number>}}`.
  - **Fail-closed auth:** no `authorize` supplied → every `/rpc` → 401. `authorize` returning false → 401. Returning true → 200.
  - **allow allowlist:** `allow: new Set(['get','list'])` → `put` → 403, `get` → 200.
  - **Unknown/malformed:** unknown method → 400; body without `args` array → 400.
  - Delete `session-sweep.test.ts` (SessionStore is gone).
- [ ] **Step 2: run red.**
- [ ] **Step 3: implement** — rewrite `router.ts` + `index.ts`; delete `sessions.ts` + `query-params.ts`. Remove now-dead imports.
- [ ] **Step 4: green** + `pnpm --filter @noy-db/in-rest typecheck && build`. Confirm `adapters.test.ts` still passes (update any hard-coded example path from `/sessions/current` to `/rpc` if a test asserts a concrete path; keep marshalling assertions).
- [ ] **Step 5: commit** — `fix(in-rest)!: proxy only EncryptedEnvelopes — server never sees passphrase or plaintext (#963)`

---

### Task 2: update the in-nuxt consumer + adapter path examples

**Files:** `packages/in-nuxt/src/runtime/rest.ts`, `packages/in-nuxt/src/module.ts` (+ any in-nuxt test/doc that wires `createRestHandler`). Check first: `grep -rn "createRestHandler\|ttlSeconds\|/sessions\|unlock" packages/in-nuxt/src`.

**Interfaces consumed from Task 1:** `createRestHandler({ store, authorize?, allow?, basePath? })` — no more `user`/`ttlSeconds`.

- [ ] **Step 1** — read how `in-nuxt` currently builds the handler (it pipes H3 events through `nitroAdapter` into `createRestHandler({store,user,ttlSeconds,basePath})`). Update the call site to the new options: drop `user`/`ttlSeconds`; wire `authorize` from the module's config (e.g. a runtime-config bearer token check) with a fail-closed default and a clear doc note that the deployer owns auth. If `in-nuxt` exposed `user`/`ttlSeconds` in its own module options, remove or repoint them.
- [ ] **Step 2** — update/adjust in-nuxt tests that asserted the old session/unlock flow; add/keep a test that the wired handler forwards an envelope RPC. Run `pnpm --filter @noy-db/in-nuxt test && typecheck && build`.
- [ ] **Step 3: commit** — `fix(in-nuxt): wire the in-rest envelope-proxy handler (drop session/unlock) (#963)`

---

### Task 3: docs + changeset + companion to-rest issue

**Files:** `packages/in-rest/README.md`; `.changeset/in-rest-envelope-proxy.md`; (companion issue filed via gh, not a repo file).

- [ ] **Step 1: README** — rewrite the usage story: the server is a ciphertext relay exposing `POST /rpc` over the 6 `NoydbStore` methods; it NEVER sees the passphrase or plaintext; unlock/query happen client-side. Show wiring `createRestHandler({ store, authorize })` with a bearer-token authorizer, the `allow` read-only-relay option, and a note that the matching client is a `to-rest` store (see the noy-db-to companion). Remove every mention of `/sessions`, unlock, `user`, `ttlSeconds`, server-side query.
- [ ] **Step 2: changeset** `.changeset/in-rest-envelope-proxy.md` (`'@noy-db/in-rest': major` — breaking; pre-1.0 so it lands as a minor bump but the body MUST say BREAKING): the REST server no longer unlocks vaults or handles plaintext — it proxies only `EncryptedEnvelope`s via `POST /rpc` mirroring the store contract; `/sessions/*` + plaintext `/vaults/*` + server-side query are removed; `RestHandlerOptions` drops `user`/`ttlSeconds`, adds fail-closed `authorize` + optional `allow`. Migrate clients to a `to-rest` store (noy-db-to). (If in-nuxt version-bumps, add it to the changeset too.)
- [ ] **Step 3: companion issue** — `gh issue create` in the **noy-db-to** repo (`vLannaAi/noy-db-to`) titled "to-rest: NoydbStore over HTTP (client for @noy-db/in-rest envelope proxy)", body describing a `toRest({ baseUrl, authorize/headers })` `NoydbStore` that POSTs `{method,args}` to `{baseUrl}/rpc` and re-hydrates `ConflictError` from a 409 `{error:{version}}` — the HTTP mirror of by-peer's `peerStore()`. Reference this PR. (Do NOT build it here — the `to-*` client family lives in noy-db-to.)
- [ ] **Step 4: gates** — `pnpm --filter @noy-db/in-rest build && test && typecheck` + `pnpm lint`. Green.
- [ ] **Step 5: commit** — `docs(in-rest): envelope-proxy README + breaking changeset (#963)`

## Out of scope
- The `to-rest` HTTP client itself (noy-db-to companion issue).
- WebAuthn finding 1 (#967, merged) and the presence/on-pin small items (#969).
- Any change to hub, by-peer, or the store contract.
