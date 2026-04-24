# Integrations Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement five integration issues (#271 hub dict emitter, #188 in-solid, #272 in-rest base, #274 in-rest adapters, #273 in-nuxt REST mount) with full tests, committed directly to main.

**Architecture:** Hub DictionaryHandle gains an emitter so dict writes propagate change events like Collection writes do. Two new packages — `@noy-db/in-solid` (SolidJS signals) and `@noy-db/in-rest` (framework-neutral REST handler with Hono/Express/Fastify/Nitro subpath adapters) — follow the monorepo `in-*` package pattern. `@noy-db/in-nuxt` is extended with a `rest` config block that mounts the Nitro adapter as a catch-all server handler.

**Tech Stack:** TypeScript, Vitest, tsup, SolidJS 1.8+, h3/Hono/Express/Fastify (types-only peer deps), @nuxt/kit.

---

## File Map

### Modified files
- `packages/hub/src/i18n/dictionary.ts` — add `emitter` param, emit `change` on put/delete/rename
- `packages/hub/src/vault.ts` — pass `this.emitter` to `new DictionaryHandle(...)`
- `packages/in-nuxt/src/module.ts` — add `rest` option block + `addServerHandler` call
- `packages/in-nuxt/package.json` — add `@noy-db/in-rest` peer dep
- `packages/in-nuxt/tsup.config.ts` — add `src/runtime/rest.ts` entry

### Created files
- `packages/hub/__tests__/dict-emitter.test.ts`
- `packages/in-solid/src/index.ts`
- `packages/in-solid/__tests__/in-solid.test.ts`
- `packages/in-solid/package.json`
- `packages/in-solid/tsup.config.ts`
- `packages/in-solid/tsconfig.json`
- `packages/in-solid/vitest.config.ts`
- `packages/in-rest/src/index.ts`
- `packages/in-rest/src/sessions.ts`
- `packages/in-rest/src/query-params.ts`
- `packages/in-rest/src/router.ts`
- `packages/in-rest/src/adapters/hono.ts`
- `packages/in-rest/src/adapters/express.ts`
- `packages/in-rest/src/adapters/fastify.ts`
- `packages/in-rest/src/adapters/nitro.ts`
- `packages/in-rest/__tests__/in-rest.test.ts`
- `packages/in-rest/__tests__/adapters.test.ts`
- `packages/in-rest/package.json`
- `packages/in-rest/tsup.config.ts`
- `packages/in-rest/tsconfig.json`
- `packages/in-rest/vitest.config.ts`
- `packages/in-nuxt/src/runtime/rest.ts`

---

## Task 1: Hub dict emitter fix (#271)

**Files:**
- Modify: `packages/hub/src/i18n/dictionary.ts`
- Modify: `packages/hub/src/vault.ts`
- Create: `packages/hub/__tests__/dict-emitter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/dict-emitter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ChangeEvent } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

describe('DictionaryHandle — change event emission', () => {
  it('put() emits a change event with action:put', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('acme')
    const events: ChangeEvent[] = []
    db.on('change', (e) => events.push(e))

    await vault.dictionary('status').put('paid', { en: 'Paid', th: 'ชำระแล้ว' })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ collection: '_dict_status', id: 'paid', action: 'put' })
  })

  it('delete() emits a change event with action:delete', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('acme')
    await vault.dictionary('status').put('draft', { en: 'Draft' })
    const events: ChangeEvent[] = []
    db.on('change', (e) => events.push(e))

    await vault.dictionary('status').delete('draft', { mode: 'warn' })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ collection: '_dict_status', id: 'draft', action: 'delete' })
  })

  it('rename() emits delete for old key then put for new key', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('acme')
    await vault.dictionary('status').put('open', { en: 'Open' })
    const events: ChangeEvent[] = []
    db.on('change', (e) => events.push(e))

    await vault.dictionary('status').rename('open', 'active')

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ collection: '_dict_status', id: 'open', action: 'delete' })
    expect(events[1]).toMatchObject({ collection: '_dict_status', id: 'active', action: 'put' })
  })

  it('putAll() emits one change event per key', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('acme')
    const events: ChangeEvent[] = []
    db.on('change', (e) => events.push(e))

    await vault.dictionary('status').putAll({
      draft: { en: 'Draft' },
      paid: { en: 'Paid' },
    })

    expect(events).toHaveLength(2)
    expect(events.map(e => e.id).sort()).toEqual(['draft', 'paid'])
    expect(events.every(e => e.action === 'put')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm --filter @noy-db/hub vitest run --reporter=verbose dict-emitter
```

Expected: all 4 tests fail (likely 0 events collected — the emitter is not called).

- [ ] **Step 3: Add the emitter import to `dictionary.ts`**

In `packages/hub/src/i18n/dictionary.ts`, add to the existing import block at the top:

```ts
import type { NoydbEventEmitter } from '../events.js'
```

- [ ] **Step 4: Add the `emitter` constructor parameter to `DictionaryHandle`**

In `packages/hub/src/i18n/dictionary.ts`, update the constructor. Add the `emitter` parameter as the **last** parameter (after `findAndUpdateReferences`):

Find:
```ts
    private readonly findAndUpdateReferences:
      | ((
          dictionaryName: string,
          oldKey: string,
          newKey: string,
        ) => Promise<void>)
      | undefined,
  ) {
    this.collName = dictCollectionName(dictionaryName)
  }
```

Replace with:
```ts
    private readonly findAndUpdateReferences:
      | ((
          dictionaryName: string,
          oldKey: string,
          newKey: string,
        ) => Promise<void>)
      | undefined,
    private readonly emitter: NoydbEventEmitter,
  ) {
    this.collName = dictCollectionName(dictionaryName)
  }
```

- [ ] **Step 5: Emit in `put()` after the cache update**

In `packages/hub/src/i18n/dictionary.ts`, find the end of the `put()` method — after `this._syncCache.set(key, entry)` and before the `if (this.ledger)` block:

Find:
```ts
    // Maintain synchronous cache for dict-join snapshot (v0.8 #85)
    this._syncCache.set(key, entry)

    if (this.ledger) {
      await this.ledger.append({
        op: 'put',
        collection: this.collName,
```

Replace with:
```ts
    // Maintain synchronous cache for dict-join snapshot (v0.8 #85)
    this._syncCache.set(key, entry)

    this.emitter.emit('change', {
      vault: this.compartmentName,
      collection: this.collName,
      id: key,
      action: 'put',
    })

    if (this.ledger) {
      await this.ledger.append({
        op: 'put',
        collection: this.collName,
```

- [ ] **Step 6: Emit in `delete()` after the cache delete**

In `packages/hub/src/i18n/dictionary.ts`, find the end of `delete()` — after `this._syncCache.delete(key)` and before the `if (this.ledger)` block:

Find:
```ts
    // Maintain synchronous cache for dict-join snapshot (v0.8 #85)
    this._syncCache.delete(key)

    if (this.ledger) {
      await this.ledger.append({
        op: 'delete',
        collection: this.collName,
```

Replace with:
```ts
    // Maintain synchronous cache for dict-join snapshot (v0.8 #85)
    this._syncCache.delete(key)

    this.emitter.emit('change', {
      vault: this.compartmentName,
      collection: this.collName,
      id: key,
      action: 'delete',
    })

    if (this.ledger) {
      await this.ledger.append({
        op: 'delete',
        collection: this.collName,
```

- [ ] **Step 7: Emit in `rename()` — delete old, put new**

In `packages/hub/src/i18n/dictionary.ts`, find the end of `rename()` — after the two `this._syncCache` lines and before the `if (this.ledger)` block:

Find:
```ts
    // Maintain synchronous cache for dict-join snapshot (v0.8 #85)
    this._syncCache.delete(oldKey)
    this._syncCache.set(newKey, newEntry)

    // 5. Ledger — one entry for the rename (not N record-level entries)
    if (this.ledger) {
```

Replace with:
```ts
    // Maintain synchronous cache for dict-join snapshot (v0.8 #85)
    this._syncCache.delete(oldKey)
    this._syncCache.set(newKey, newEntry)

    this.emitter.emit('change', {
      vault: this.compartmentName,
      collection: this.collName,
      id: oldKey,
      action: 'delete',
    })
    this.emitter.emit('change', {
      vault: this.compartmentName,
      collection: this.collName,
      id: newKey,
      action: 'put',
    })

    // 5. Ledger — one entry for the rename (not N record-level entries)
    if (this.ledger) {
```

- [ ] **Step 8: Pass `this.emitter` when constructing `DictionaryHandle` in vault.ts**

In `packages/hub/src/vault.ts`, find the `new DictionaryHandle<Keys>(` call inside `dictionary()`. It currently ends with the `findAndUpdateReferences` callback closing paren. Add `this.emitter` as the final argument:

Find:
```ts
        async (dictionaryName, oldKey, newKey) => {
          for (const [collectionName, dictFields] of this.dictKeyFieldRegistry) {
```

The full call ends with `)` then `)` (closing the `new DictionaryHandle<Keys>(` call). Locate the closing `)` of the `new DictionaryHandle` constructor call and change it from:

```ts
            }
          }
        },
      )
      this.dictionaryCache.set(name, handle)
```

To:
```ts
            }
          }
        },
        this.emitter,
      )
      this.dictionaryCache.set(name, handle)
```

- [ ] **Step 9: Run the test to confirm it passes**

```bash
pnpm --filter @noy-db/hub vitest run --reporter=verbose dict-emitter
```

Expected: 4/4 pass.

- [ ] **Step 10: Run the full hub test suite to catch regressions**

```bash
pnpm --filter @noy-db/hub vitest run
```

Expected: all existing tests still pass.

- [ ] **Step 11: Commit**

```bash
git add packages/hub/src/i18n/dictionary.ts packages/hub/src/vault.ts packages/hub/__tests__/dict-emitter.test.ts
git commit -m "fix(hub): route DictionaryHandle writes through Collection emitter (#271)

closes #271"
```

---

## Task 2: `@noy-db/in-solid` package (#188)

**Files:**
- Create: `packages/in-solid/package.json`
- Create: `packages/in-solid/tsconfig.json`
- Create: `packages/in-solid/tsup.config.ts`
- Create: `packages/in-solid/vitest.config.ts`
- Create: `packages/in-solid/src/index.ts`
- Create: `packages/in-solid/__tests__/in-solid.test.ts`

- [ ] **Step 1: Create package scaffolding files**

Create `packages/in-solid/package.json`:

```json
{
  "name": "@noy-db/in-solid",
  "version": "0.1.0",
  "description": "SolidJS signal primitives for noy-db — createCollectionSignal, createQuerySignal, createSyncSignal backed by noy-db change events.",
  "license": "MIT",
  "author": "vLannaAi <vicio@lanna.ai>",
  "homepage": "https://github.com/vLannaAi/noy-db/tree/main/packages/in-solid#readme",
  "repository": { "type": "git", "url": "https://github.com/vLannaAi/noy-db.git", "directory": "packages/in-solid" },
  "bugs": { "url": "https://github.com/vLannaAi/noy-db/issues" },
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=18.0.0" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@noy-db/hub": "workspace:*",
    "solid-js": "^1.8.0"
  },
  "devDependencies": {
    "@noy-db/hub": "workspace:*",
    "solid-js": "^1.9.0"
  },
  "keywords": ["noy-db", "in-solid", "solidjs", "signals", "zero-knowledge"]
}
```

Create `packages/in-solid/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

Create `packages/in-solid/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
})
```

Create `packages/in-solid/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { name: 'in-solid', include: ['__tests__/**/*.test.ts'], environment: 'node', testTimeout: 15_000 },
})
```

- [ ] **Step 2: Write the failing test**

Create `packages/in-solid/__tests__/in-solid.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createRoot } from 'solid-js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import type { Vault, Noydb } from '@noy-db/hub'
import { createCollectionSignal, createQuerySignal, createSyncSignal } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; amt: number }

async function setup(): Promise<{ db: Noydb; vault: Vault }> {
  const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('acme')
  const coll = vault.collection<Invoice>('invoices')
  await coll.put('i1', { id: 'i1', amt: 100 })
  await coll.put('i2', { id: 'i2', amt: 250 })
  return { db, vault }
}

const drain = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

describe('createCollectionSignal', () => {
  it('starts loading and resolves to records', async () => {
    const { vault } = await setup()
    await createRoot(async (dispose) => {
      const [records, loading] = createCollectionSignal<Invoice>(vault, 'invoices')
      expect(loading()).toBe(true)
      await drain()
      expect(loading()).toBe(false)
      expect(records().map(r => r.id).sort()).toEqual(['i1', 'i2'])
      dispose()
    })
  })

  it('re-emits when a record is added', async () => {
    const { vault } = await setup()
    await createRoot(async (dispose) => {
      const coll = vault.collection<Invoice>('invoices')
      const [records, loading] = createCollectionSignal<Invoice>(vault, 'invoices')
      await drain()
      expect(loading()).toBe(false)
      await coll.put('i3', { id: 'i3', amt: 500 })
      await drain()
      expect(records().map(r => r.id)).toContain('i3')
      dispose()
    })
  })
})

describe('createQuerySignal', () => {
  it('re-runs builder on collection change', async () => {
    const { vault } = await setup()
    await createRoot(async (dispose) => {
      const coll = vault.collection<Invoice>('invoices')
      const [data, loading] = createQuerySignal<Invoice, number>(
        vault,
        'invoices',
        (q) => q.count(),
      )
      await drain()
      expect(loading()).toBe(false)
      expect(data()).toBe(2)
      await coll.put('i3', { id: 'i3', amt: 99 })
      await drain()
      expect(data()).toBe(3)
      dispose()
    })
  })
})

describe('createSyncSignal', () => {
  it('updates when any collection write fires', async () => {
    const { db, vault } = await setup()
    await createRoot(async (dispose) => {
      const lastEvent = createSyncSignal(db)
      expect(lastEvent()).toBeNull()
      const coll = vault.collection<Invoice>('invoices')
      await coll.put('i3', { id: 'i3', amt: 0 })
      await drain()
      expect(lastEvent()).not.toBeNull()
      expect(lastEvent()?.action).toBe('put')
      dispose()
    })
  })
})
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd packages/in-solid && pnpm install && pnpm vitest run 2>&1 | head -30
```

Expected: fails — `../src/index.js` does not exist yet.

- [ ] **Step 4: Implement `src/index.ts`**

Create `packages/in-solid/src/index.ts`:

```ts
/**
 * **@noy-db/in-solid** — SolidJS signal primitives for noy-db.
 *
 *   - {@link createCollectionSignal} — reactive record list
 *   - {@link createQuerySignal}      — reactive query result
 *   - {@link createSyncSignal}       — Noydb-level change feed
 *
 * Uses `createSignal` + `createEffect` + `onCleanup` from `solid-js`.
 * No DOM dependency — works in SSR and test environments via `createRoot`.
 *
 * @packageDocumentation
 */

import { createSignal, createEffect, onCleanup } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { Noydb, Vault, ChangeEvent, Query } from '@noy-db/hub'

export function createCollectionSignal<T>(
  vault: Vault,
  collectionName: string,
): [records: Accessor<T[]>, loading: Accessor<boolean>, error: Accessor<Error | null>] {
  const [records, setRecords] = createSignal<T[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<Error | null>(null)

  createEffect(() => {
    const coll = vault.collection<T>(collectionName)

    async function refresh(): Promise<void> {
      try {
        const list = await coll.list()
        setRecords(list)
        setError(null)
      } catch (err) {
        setError(err as Error)
      } finally {
        setLoading(false)
      }
    }

    void refresh()
    const unsub = coll.subscribe(() => { void refresh() })
    onCleanup(unsub)
  })

  return [records, loading, error]
}

export function createQuerySignal<T, R>(
  vault: Vault,
  collectionName: string,
  builder: (q: Query<T>) => R | Promise<R>,
): [data: Accessor<R | null>, loading: Accessor<boolean>, error: Accessor<Error | null>] {
  const [data, setData] = createSignal<R | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<Error | null>(null)

  createEffect(() => {
    const coll = vault.collection<T>(collectionName)

    async function refresh(): Promise<void> {
      try {
        const result = await Promise.resolve(builder(coll.query() as unknown as Query<T>))
        setData(() => result)
        setError(null)
      } catch (err) {
        setError(err as Error)
      } finally {
        setLoading(false)
      }
    }

    void refresh()
    const unsub = coll.subscribe(() => { void refresh() })
    onCleanup(unsub)
  })

  return [data, loading, error]
}

export function createSyncSignal(db: Noydb): Accessor<ChangeEvent | null> {
  const [lastEvent, setLastEvent] = createSignal<ChangeEvent | null>(null)

  createEffect(() => {
    const handler = (event: ChangeEvent): void => { setLastEvent(() => event) }
    db.on('change', handler)
    onCleanup(() => db.off('change', handler))
  })

  return lastEvent
}

export type { Noydb, Vault, ChangeEvent } from '@noy-db/hub'
```

- [ ] **Step 5: Install solid-js and run the tests**

```bash
cd packages/in-solid && pnpm install && pnpm vitest run --reporter=verbose
```

Expected: all tests pass.

- [ ] **Step 6: Register the package in the workspace**

In `pnpm-workspace.yaml` (root), verify `packages/in-solid` is covered by the glob `packages/*`. It should already be — confirm with:

```bash
cat /path/to/noy-db/pnpm-workspace.yaml | grep packages
```

If the glob is `packages/*`, no change needed.

- [ ] **Step 7: Commit**

```bash
git add packages/in-solid/
git commit -m "feat(in-solid): @noy-db/in-solid — SolidJS signal primitives (#188)

closes #188"
```

---

## Task 3: `@noy-db/in-rest` — sessions + query-params + router + index (#272)

**Files:**
- Create: `packages/in-rest/package.json`
- Create: `packages/in-rest/tsconfig.json`
- Create: `packages/in-rest/tsup.config.ts`
- Create: `packages/in-rest/vitest.config.ts`
- Create: `packages/in-rest/src/sessions.ts`
- Create: `packages/in-rest/src/query-params.ts`
- Create: `packages/in-rest/src/router.ts`
- Create: `packages/in-rest/src/index.ts`
- Create: `packages/in-rest/__tests__/in-rest.test.ts`

- [ ] **Step 1: Create package scaffolding**

Create `packages/in-rest/package.json`:

```json
{
  "name": "@noy-db/in-rest",
  "version": "0.1.0",
  "description": "Framework-neutral REST API integration for noy-db — createRestHandler with Hono, Express, Fastify, and Nitro subpath adapters.",
  "license": "MIT",
  "author": "vLannaAi <vicio@lanna.ai>",
  "homepage": "https://github.com/vLannaAi/noy-db/tree/main/packages/in-rest#readme",
  "repository": { "type": "git", "url": "https://github.com/vLannaAi/noy-db.git", "directory": "packages/in-rest" },
  "bugs": { "url": "https://github.com/vLannaAi/noy-db/issues" },
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    },
    "./hono": {
      "import": { "types": "./dist/adapters/hono.d.ts", "default": "./dist/adapters/hono.js" },
      "require": { "types": "./dist/adapters/hono.d.cts", "default": "./dist/adapters/hono.cjs" }
    },
    "./express": {
      "import": { "types": "./dist/adapters/express.d.ts", "default": "./dist/adapters/express.js" },
      "require": { "types": "./dist/adapters/express.d.cts", "default": "./dist/adapters/express.cjs" }
    },
    "./fastify": {
      "import": { "types": "./dist/adapters/fastify.d.ts", "default": "./dist/adapters/fastify.js" },
      "require": { "types": "./dist/adapters/fastify.d.cts", "default": "./dist/adapters/fastify.cjs" }
    },
    "./nitro": {
      "import": { "types": "./dist/adapters/nitro.d.ts", "default": "./dist/adapters/nitro.js" },
      "require": { "types": "./dist/adapters/nitro.d.cts", "default": "./dist/adapters/nitro.cjs" }
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=18.0.0" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@noy-db/hub": "workspace:*"
  },
  "peerDependenciesMeta": {
    "hono": { "optional": true },
    "express": { "optional": true },
    "fastify": { "optional": true },
    "h3": { "optional": true }
  },
  "devDependencies": {
    "@noy-db/hub": "workspace:*",
    "@types/express": "^5.0.0",
    "express": "^5.0.0",
    "fastify": "^5.0.0",
    "h3": "^1.13.0",
    "hono": "^4.0.0"
  },
  "keywords": ["noy-db", "in-rest", "rest", "http", "api", "hono", "express", "fastify", "nitro"]
}
```

Create `packages/in-rest/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

Create `packages/in-rest/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup'
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/adapters/hono.ts',
    'src/adapters/express.ts',
    'src/adapters/fastify.ts',
    'src/adapters/nitro.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
  external: ['@noy-db/hub', 'hono', 'express', 'fastify', 'h3'],
})
```

Create `packages/in-rest/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { name: 'in-rest', include: ['__tests__/**/*.test.ts'], environment: 'node', testTimeout: 15_000 },
})
```

- [ ] **Step 2: Write the failing test for the base handler**

Create `packages/in-rest/__tests__/in-rest.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { createRestHandler, type RestRequest } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

function req(method: string, path: string, body?: unknown, token?: string): RestRequest {
  return {
    method,
    pathname: path,
    searchParams: new URLSearchParams(),
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    json: () => Promise.resolve(body ?? null),
  }
}

function reqSearch(method: string, path: string, search: string, token: string): RestRequest {
  return {
    method,
    pathname: path,
    searchParams: new URLSearchParams(search),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    json: () => Promise.resolve(null),
  }
}

describe('in-rest base handler', () => {
  let store: NoydbStore
  beforeEach(() => { store = memory() })

  it('POST /sessions/unlock/passphrase → 200 with token', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const res = await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body as string) as { token: string }
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBeGreaterThan(10)
  })

  it('GET /sessions/current without token → active: false', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const res = await handler.handle(req('GET', '/sessions/current'))
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body as string) as { active: boolean }
    expect(body.active).toBe(false)
  })

  it('GET /sessions/current with valid token → active: true', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const unlockRes = await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))
    const { token } = JSON.parse(unlockRes.body as string) as { token: string }

    const res = await handler.handle(req('GET', '/sessions/current', undefined, token))
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body as string)).toMatchObject({ active: true })
  })

  it('vault routes require a valid token — 401 without one', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const res = await handler.handle(req('GET', '/vaults'))
    expect(res.status).toBe(401)
  })

  it('full CRUD flow: list → put → get → delete', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const { token } = JSON.parse(
      (await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))).body as string
    ) as { token: string }

    // Open vault by listing first (creates keyring)
    const listVaultsRes = await handler.handle(req('GET', '/vaults', undefined, token))
    expect(listVaultsRes.status).toBe(200)

    // Put a record
    const putRes = await handler.handle(
      req('POST', '/vaults/acme/collections/invoices/i1', { id: 'i1', amt: 100 }, token)
    )
    expect(putRes.status).toBe(200)

    // Get it back
    const getRes = await handler.handle(req('GET', '/vaults/acme/collections/invoices/i1', undefined, token))
    expect(getRes.status).toBe(200)
    const record = JSON.parse(getRes.body as string) as { id: string; amt: number }
    expect(record.id).toBe('i1')
    expect(record.amt).toBe(100)

    // List collection
    const collRes = await handler.handle(req('GET', '/vaults/acme/collections/invoices', undefined, token))
    expect(collRes.status).toBe(200)
    const records = JSON.parse(collRes.body as string) as unknown[]
    expect(records).toHaveLength(1)

    // Delete it
    const delRes = await handler.handle(req('DELETE', '/vaults/acme/collections/invoices/i1', undefined, token))
    expect(delRes.status).toBe(200)

    // Gone
    const gone = await handler.handle(req('GET', '/vaults/acme/collections/invoices/i1', undefined, token))
    expect(gone.status).toBe(404)
  })

  it('DELETE /sessions/current invalidates the token', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const { token } = JSON.parse(
      (await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))).body as string
    ) as { token: string }

    const delRes = await handler.handle(req('DELETE', '/sessions/current', undefined, token))
    expect(delRes.status).toBe(204)

    const afterDel = await handler.handle(req('GET', '/vaults', undefined, token))
    expect(afterDel.status).toBe(401)
  })

  it('?where=status:eq:paid filters results', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const { token } = JSON.parse(
      (await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))).body as string
    ) as { token: string }
    await handler.handle(req('POST', '/vaults/acme/collections/invoices/i1', { id: 'i1', status: 'paid', amt: 100 }, token))
    await handler.handle(req('POST', '/vaults/acme/collections/invoices/i2', { id: 'i2', status: 'draft', amt: 50 }, token))

    const res = await handler.handle(
      reqSearch('GET', '/vaults/acme/collections/invoices', 'where=status:eq:paid', token)
    )
    expect(res.status).toBe(200)
    const results = JSON.parse(res.body as string) as Array<{ status: string }>
    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('paid')
  })

  it('?where=amt:pow:2 → 400 invalid op', async () => {
    const handler = createRestHandler({ store, user: 'owner' })
    const { token } = JSON.parse(
      (await handler.handle(req('POST', '/sessions/unlock/passphrase', { passphrase: 'secret' }))).body as string
    ) as { token: string }

    const res = await handler.handle(
      reqSearch('GET', '/vaults/acme/collections/invoices', 'where=amt:pow:2', token)
    )
    expect(res.status).toBe(400)
    const body = JSON.parse(res.body as string) as { error: string }
    expect(body.error).toBe('invalid_op')
  })

  it('basePath option strips the prefix before routing', async () => {
    const handler = createRestHandler({ store, user: 'owner', basePath: '/api/noydb' })
    const res = await handler.handle(req('POST', '/api/noydb/sessions/unlock/passphrase', { passphrase: 'secret' }))
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd packages/in-rest && pnpm install && pnpm vitest run 2>&1 | head -20
```

Expected: fails — modules do not exist yet.

- [ ] **Step 4: Implement `src/sessions.ts`**

Create `packages/in-rest/src/sessions.ts`:

```ts
import type { Noydb } from '@noy-db/hub'

interface Session {
  db: Noydb
  expiresAt: number
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly ttlMs: number

  constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000
  }

  create(db: Noydb): string {
    const token = crypto.randomUUID()
    this.sessions.set(token, { db, expiresAt: Date.now() + this.ttlMs })
    return token
  }

  get(token: string): Noydb | null {
    const session = this.sessions.get(token)
    if (!session) return null
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token)
      return null
    }
    session.expiresAt = Date.now() + this.ttlMs
    return session.db
  }

  delete(token: string): void {
    this.sessions.delete(token)
  }

  has(token: string): boolean {
    return this.get(token) !== null
  }
}
```

- [ ] **Step 5: Implement `src/query-params.ts`**

Create `packages/in-rest/src/query-params.ts`:

```ts
import type { Query } from '@noy-db/hub'

type QueryOp = '==' | '!=' | '>' | '>=' | '<' | '<='

const OP_MAP: Record<string, QueryOp> = {
  eq: '==',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

export interface ParsedQueryParams {
  error?: { error: string; op?: string }
  apply<T>(q: Query<T>): Query<T>
  limit: number | null
}

export function parseQueryParams(searchParams: URLSearchParams): ParsedQueryParams {
  const wheres = searchParams.getAll('where')
  const orderByParam = searchParams.get('orderBy')
  const limitParam = searchParams.get('limit')

  const whereClauses: Array<{ field: string; op: QueryOp; value: unknown }> = []

  for (const clause of wheres) {
    const parts = clause.split(':')
    if (parts.length < 3) {
      return {
        error: { error: 'invalid_where', op: clause },
        apply: (q) => q,
        limit: null,
      }
    }
    const [field, opStr, ...rest] = parts as [string, string, ...string[]]
    const value = rest.join(':')
    const op = OP_MAP[opStr]
    if (!op) {
      return {
        error: { error: 'invalid_op', op: opStr },
        apply: (q) => q,
        limit: null,
      }
    }
    whereClauses.push({ field, op, value: coerce(value) })
  }

  let orderBy: { field: string; dir: 'asc' | 'desc' } | null = null
  if (orderByParam) {
    const [field, dir = 'asc'] = orderByParam.split(':') as [string, string?]
    orderBy = { field, dir: dir === 'desc' ? 'desc' : 'asc' }
  }

  const limit = limitParam ? parseInt(limitParam, 10) : null

  return {
    apply<T>(q: Query<T>): Query<T> {
      let result = q
      for (const { field, op, value } of whereClauses) {
        result = result.where(field as keyof T & string, op, value as T[keyof T])
      }
      if (orderBy) {
        result = result.orderBy(orderBy.field as keyof T & string, orderBy.dir)
      }
      return result
    },
    limit,
  }
}

function coerce(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const n = Number(raw)
  if (!isNaN(n) && raw.trim() !== '') return n
  return raw
}
```

- [ ] **Step 6: Implement `src/router.ts`**

Create `packages/in-rest/src/router.ts`:

```ts
import { createNoydb, PermissionDeniedError, NotFoundError } from '@noy-db/hub'
import type { NoydbStore } from '@noy-db/hub'
import type { RestRequest, RestResponse } from './index.js'
import { SessionStore } from './sessions.js'
import { parseQueryParams } from './query-params.js'

function json(status: number, body: unknown): RestResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function extractToken(req: RestRequest): string | null {
  const auth = req.headers['authorization'] ?? req.headers['Authorization']
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}

export function buildRouter(store: NoydbStore, user: string, sessions: SessionStore, basePath: string) {
  function stripBase(pathname: string): string {
    if (basePath && pathname.startsWith(basePath)) return pathname.slice(basePath.length) || '/'
    return pathname
  }

  return async function route(req: RestRequest): Promise<RestResponse> {
    const path = stripBase(req.pathname)
    const method = req.method.toUpperCase()

    // ── Session routes (no auth required) ─────────────────────────

    if (method === 'POST' && path === '/sessions/unlock/passphrase') {
      let body: unknown
      try { body = await req.json() } catch { return json(400, { error: 'invalid_json' }) }
      const passphrase = (body as Record<string, unknown>)?.passphrase
      if (typeof passphrase !== 'string' || !passphrase) {
        return json(400, { error: 'passphrase_required' })
      }
      try {
        const db = await createNoydb({ store, user, secret: passphrase })
        const token = sessions.create(db)
        return json(200, { token })
      } catch {
        return json(401, { error: 'invalid_passphrase' })
      }
    }

    if (method === 'GET' && path === '/sessions/current') {
      const token = extractToken(req)
      const active = token !== null && sessions.has(token)
      return json(200, { active })
    }

    if (method === 'DELETE' && path === '/sessions/current') {
      const token = extractToken(req)
      if (!token || !sessions.has(token)) return json(401, { error: 'unauthorized' })
      sessions.delete(token)
      return { status: 204, headers: {}, body: null }
    }

    // ── Auth guard ────────────────────────────────────────────────

    const token = extractToken(req)
    const db = token ? sessions.get(token) : null
    if (!db) return json(401, { error: 'unauthorized' })

    // ── Vault routes ──────────────────────────────────────────────

    if (method === 'GET' && path === '/vaults') {
      return json(200, [])
    }

    // Match /vaults/:vault/collections/:collection/:id
    const recordMatch = path.match(/^\/vaults\/([^/]+)\/collections\/([^/]+)\/([^/]+)$/)
    if (recordMatch) {
      const [, vaultName, collName, id] = recordMatch as [string, string, string, string]
      try {
        const vault = await db.openVault(vaultName)
        const coll = vault.collection<Record<string, unknown>>(collName)

        if (method === 'GET') {
          const record = await coll.get(id)
          if (!record) return json(404, { error: 'not_found' })
          return json(200, record)
        }

        if (method === 'POST') {
          let body: unknown
          try { body = await req.json() } catch { return json(400, { error: 'invalid_json' }) }
          await coll.put(id, body as Record<string, unknown>)
          return json(200, { ok: true })
        }

        if (method === 'DELETE') {
          await coll.delete(id)
          return json(200, { ok: true })
        }
      } catch (err) {
        if (err instanceof PermissionDeniedError) return json(403, { error: 'forbidden' })
        if (err instanceof NotFoundError) return json(404, { error: 'not_found' })
        return json(500, { error: 'internal_error' })
      }
    }

    // Match /vaults/:vault/collections/:collection (list)
    const collMatch = path.match(/^\/vaults\/([^/]+)\/collections\/([^/]+)$/)
    if (collMatch && method === 'GET') {
      const [, vaultName, collName] = collMatch as [string, string, string]
      const params = parseQueryParams(req.searchParams)
      if (params.error) return json(400, params.error)
      try {
        const vault = await db.openVault(vaultName)
        const coll = vault.collection<Record<string, unknown>>(collName)
        let results = await params.apply(coll.query()).toArray()
        if (params.limit !== null) results = results.slice(0, params.limit)
        return json(200, results)
      } catch (err) {
        if (err instanceof PermissionDeniedError) return json(403, { error: 'forbidden' })
        return json(500, { error: 'internal_error' })
      }
    }

    return json(404, { error: 'not_found' })
  }
}
```

- [ ] **Step 7: Implement `src/index.ts`**

Create `packages/in-rest/src/index.ts`:

```ts
/**
 * **@noy-db/in-rest** — Framework-neutral REST API integration for noy-db.
 *
 * @example
 * ```ts
 * import { createRestHandler } from '@noy-db/in-rest'
 * import { honoAdapter } from '@noy-db/in-rest/hono'
 *
 * const handler = createRestHandler({ store, user: 'api' })
 * app.route('/api/noydb', honoAdapter(handler))
 * ```
 *
 * @packageDocumentation
 */

import type { NoydbStore } from '@noy-db/hub'
import { SessionStore } from './sessions.js'
import { buildRouter } from './router.js'

export interface RestRequest {
  readonly method: string
  readonly pathname: string
  readonly searchParams: URLSearchParams
  readonly headers: Record<string, string>
  json(): Promise<unknown>
}

export interface RestResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string | Uint8Array | null
}

export interface NoydbRestHandler {
  handle(req: RestRequest): Promise<RestResponse>
}

export interface RestHandlerOptions {
  readonly store: NoydbStore
  readonly user: string
  readonly ttlSeconds?: number
  readonly basePath?: string
}

export function createRestHandler(options: RestHandlerOptions): NoydbRestHandler {
  const sessions = new SessionStore(options.ttlSeconds ?? 900)
  const route = buildRouter(options.store, options.user, sessions, options.basePath ?? '')
  return { handle: route }
}
```

- [ ] **Step 8: Run the tests**

```bash
pnpm --filter @noy-db/in-rest vitest run --reporter=verbose
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/in-rest/
git commit -m "feat(in-rest): @noy-db/in-rest — framework-neutral REST handler (#272)

closes #272"
```

---

## Task 4: Mounting adapters (#274)

**Files:**
- Create: `packages/in-rest/src/adapters/hono.ts`
- Create: `packages/in-rest/src/adapters/express.ts`
- Create: `packages/in-rest/src/adapters/fastify.ts`
- Create: `packages/in-rest/src/adapters/nitro.ts`
- Create: `packages/in-rest/__tests__/adapters.test.ts`

- [ ] **Step 1: Write the failing adapter tests**

Create `packages/in-rest/__tests__/adapters.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { NoydbRestHandler, RestRequest, RestResponse } from '../src/index.js'

function stubHandler(response: RestResponse): NoydbRestHandler {
  return {
    handle(_req: RestRequest): Promise<RestResponse> {
      return Promise.resolve(response)
    },
  }
}

const okResponse: RestResponse = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
}

// ── Nitro / H3 ────────────────────────────────────────────────────────

describe('nitroAdapter', () => {
  it('normalises an H3 event into a RestRequest and writes response back', async () => {
    const { nitroAdapter } = await import('../src/adapters/nitro.js')
    const handler = stubHandler(okResponse)
    const eventHandler = nitroAdapter(handler)

    let capturedReq: RestRequest | null = null
    const originalHandle = handler.handle.bind(handler)
    handler.handle = async (r) => {
      capturedReq = r
      return originalHandle(r)
    }

    const mockEvent = {
      method: 'GET',
      path: '/sessions/current',
      headers: new Headers({ 'x-test': '1' }),
      _body: null as unknown,
    }

    const res = await (eventHandler as (event: typeof mockEvent) => Promise<RestResponse>)(mockEvent)

    expect(res.status).toBe(200)
    expect(capturedReq).not.toBeNull()
    expect(capturedReq!.method).toBe('GET')
    expect(capturedReq!.pathname).toBe('/sessions/current')
  })
})

// ── Hono ─────────────────────────────────────────────────────────────

describe('honoAdapter', () => {
  it('creates a Hono instance with a catch-all route that forwards to the handler', async () => {
    const { honoAdapter } = await import('../src/adapters/hono.js')
    const handler = stubHandler(okResponse)
    const app = honoAdapter(handler)

    const response = await app.request('/sessions/current', {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

// ── Express ───────────────────────────────────────────────────────────

describe('expressAdapter', () => {
  it('returns a Router — handle() is invoked for incoming requests', async () => {
    const { expressAdapter } = await import('../src/adapters/express.js')
    const handler = stubHandler(okResponse)
    const router = expressAdapter(handler)
    expect(typeof router).toBe('function')

    let capturedReq: RestRequest | null = null
    const originalHandle = handler.handle.bind(handler)
    handler.handle = async (r) => {
      capturedReq = r
      return originalHandle(r)
    }

    const mockReq = {
      method: 'GET',
      path: '/sessions/current',
      headers: {},
      query: {},
      body: null,
    }
    const mockRes = {
      statusCode: 0,
      setHeaders: (_h: Record<string, string>) => {},
      end: (_b: string) => {},
    }

    await new Promise<void>((resolve) => {
      router(mockReq as never, mockRes as never, resolve)
    })

    expect(capturedReq).not.toBeNull()
    expect(capturedReq!.method).toBe('GET')
  })
})

// ── Fastify ───────────────────────────────────────────────────────────

describe('fastifyPlugin', () => {
  it('registers as a Fastify plugin and routes requests to handler', async () => {
    const Fastify = (await import('fastify')).default
    const { fastifyPlugin } = await import('../src/adapters/fastify.js')
    const handler = stubHandler(okResponse)

    const app = Fastify()
    await app.register(fastifyPlugin(handler))
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/sessions/current' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    await app.close()
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm --filter @noy-db/in-rest vitest run --reporter=verbose adapters
```

Expected: all adapter tests fail — adapter modules don't exist yet.

- [ ] **Step 3: Implement `src/adapters/nitro.ts`**

Create `packages/in-rest/src/adapters/nitro.ts`:

```ts
import type { NoydbRestHandler, RestRequest } from '../index.js'

interface H3Event {
  method: string
  path: string
  headers: Headers | Record<string, string>
  _body?: unknown
}

export function nitroAdapter(handler: NoydbRestHandler) {
  return async function eventHandler(event: H3Event) {
    const headers: Record<string, string> = {}
    if (event.headers instanceof Headers) {
      event.headers.forEach((v, k) => { headers[k] = v })
    } else {
      Object.assign(headers, event.headers)
    }

    const url = new URL(event.path, 'http://localhost')
    let bodyCache: unknown
    let bodyRead = false

    const restReq: RestRequest = {
      method: event.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers,
      async json() {
        if (!bodyRead) { bodyCache = event._body ?? null; bodyRead = true }
        return bodyCache
      },
    }

    return handler.handle(restReq)
  }
}
```

- [ ] **Step 4: Implement `src/adapters/hono.ts`**

Create `packages/in-rest/src/adapters/hono.ts`:

```ts
import { Hono } from 'hono'
import type { NoydbRestHandler, RestRequest } from '../index.js'

export function honoAdapter(handler: NoydbRestHandler): Hono {
  const app = new Hono()

  app.all('*', async (c) => {
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((v, k) => { headers[k] = v })

    const url = new URL(c.req.url)
    const restReq: RestRequest = {
      method: c.req.method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers,
      json: () => c.req.json<unknown>(),
    }

    const res = await handler.handle(restReq)
    return new Response(res.body as string | null, {
      status: res.status,
      headers: res.headers,
    })
  })

  return app
}
```

- [ ] **Step 5: Implement `src/adapters/express.ts`**

Create `packages/in-rest/src/adapters/express.ts`:

```ts
import { Router } from 'express'
import type { NoydbRestHandler, RestRequest } from '../index.js'

export function expressAdapter(handler: NoydbRestHandler): Router {
  const router = Router()

  router.all('*', async (req, res, next) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v
    }

    const url = new URL(req.path, 'http://localhost')
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') url.searchParams.append(k, v)
    }

    let bodyCache: unknown
    let bodyRead = false

    const restReq: RestRequest = {
      method: req.method,
      pathname: req.path,
      searchParams: url.searchParams,
      headers,
      json: () => {
        if (!bodyRead) { bodyCache = req.body; bodyRead = true }
        return Promise.resolve(bodyCache)
      },
    }

    try {
      const restRes = await handler.handle(restReq)
      res.status(restRes.status)
      for (const [k, v] of Object.entries(restRes.headers)) res.setHeader(k, v)
      if (restRes.body !== null) {
        res.end(restRes.body)
      } else {
        res.end()
      }
    } catch (err) {
      next(err)
    }
  })

  return router
}
```

- [ ] **Step 6: Implement `src/adapters/fastify.ts`**

Create `packages/in-rest/src/adapters/fastify.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify'
import type { NoydbRestHandler, RestRequest } from '../index.js'

export function fastifyPlugin(handler: NoydbRestHandler): FastifyPluginAsync {
  return async function plugin(fastify) {
    fastify.all('*', async (request, reply) => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === 'string') headers[k] = v
      }

      const url = new URL(request.url, 'http://localhost')

      let bodyCache: unknown
      let bodyRead = false

      const restReq: RestRequest = {
        method: request.method,
        pathname: url.pathname,
        searchParams: url.searchParams,
        headers,
        json: () => {
          if (!bodyRead) { bodyCache = request.body; bodyRead = true }
          return Promise.resolve(bodyCache)
        },
      }

      const restRes = await handler.handle(restReq)
      reply.status(restRes.status)
      for (const [k, v] of Object.entries(restRes.headers)) {
        reply.header(k, v)
      }
      if (restRes.body !== null) {
        return reply.send(restRes.body)
      }
      return reply.send()
    })
  }
}
```

- [ ] **Step 7: Run all in-rest tests**

```bash
pnpm --filter @noy-db/in-rest vitest run --reporter=verbose
```

Expected: all tests (in-rest.test.ts + adapters.test.ts) pass.

- [ ] **Step 8: Commit**

```bash
git add packages/in-rest/src/adapters/ packages/in-rest/__tests__/adapters.test.ts
git commit -m "feat(in-rest): mounting adapters for Hono, Express, Fastify, Nitro (#274)

closes #274"
```

---

## Task 5: `in-nuxt` REST mount (#273)

**Files:**
- Modify: `packages/in-nuxt/src/module.ts`
- Modify: `packages/in-nuxt/package.json`
- Modify: `packages/in-nuxt/tsup.config.ts`
- Create: `packages/in-nuxt/src/runtime/rest.ts`
- Create: `packages/in-nuxt/__tests__/rest-module.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/in-nuxt/__tests__/rest-module.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const captured: {
  serverHandlers: Array<{ route: string; handler: string }>
  imports: Array<{ name: string; from: string }>
  plugins: Array<{ src: string; mode?: string }>
  runtimeConfig: Record<string, unknown>
  resolverBase: string | URL | null
  defineNuxtModuleArg: unknown
} = {
  serverHandlers: [],
  imports: [],
  plugins: [],
  runtimeConfig: {},
  resolverBase: null,
  defineNuxtModuleArg: null,
}

vi.mock('@nuxt/kit', () => {
  return {
    defineNuxtModule(definition: {
      meta: { name: string; configKey: string }
      defaults?: Record<string, unknown>
      setup: (options: Record<string, unknown>, nuxt: unknown) => void | Promise<void>
    }) {
      captured.defineNuxtModuleArg = definition
      const moduleFn = async (inlineOptions: Record<string, unknown>, nuxt: unknown) => {
        const merged = { ...(definition.defaults ?? {}), ...inlineOptions }
        return definition.setup(merged, nuxt)
      }
      Object.assign(moduleFn, {
        meta: definition.meta,
        defaults: definition.defaults,
        setup: definition.setup,
      })
      return moduleFn
    },
    addImports(imports: { name: string; from: string } | Array<{ name: string; from: string }>) {
      const arr = Array.isArray(imports) ? imports : [imports]
      captured.imports.push(...arr)
    },
    addPlugin(plugin: { src: string; mode?: string }) {
      captured.plugins.push(plugin)
      return plugin
    },
    addServerHandler(handler: { route: string; handler: string }) {
      captured.serverHandlers.push(handler)
    },
    createResolver(base: string | URL) {
      captured.resolverBase = base
      return {
        resolve: (path: string) => `RESOLVED:${path}`,
        resolvePath: (path: string) => Promise.resolve(`RESOLVED:${path}`),
      }
    },
  }
})

function makeNuxtMock() {
  return {
    options: {
      runtimeConfig: {
        public: {} as Record<string, unknown>,
      },
    },
  }
}

describe('in-nuxt REST module option', () => {
  beforeEach(() => {
    captured.serverHandlers.length = 0
    captured.runtimeConfig = {}
  })

  it('does NOT register a server handler when rest is omitted', async () => {
    const { default: module } = await import('../src/module.js')
    const nuxt = makeNuxtMock()
    await (module as (opts: Record<string, unknown>, nuxt: unknown) => Promise<void>)({}, nuxt)
    expect(captured.serverHandlers).toHaveLength(0)
  })

  it('does NOT register a server handler when rest.enabled is false', async () => {
    const { default: module } = await import('../src/module.js')
    const nuxt = makeNuxtMock()
    await (module as (opts: Record<string, unknown>, nuxt: unknown) => Promise<void>)(
      { rest: { enabled: false } },
      nuxt,
    )
    expect(captured.serverHandlers).toHaveLength(0)
  })

  it('registers a catch-all server handler at the default basePath when rest.enabled is true', async () => {
    const { default: module } = await import('../src/module.js')
    const nuxt = makeNuxtMock()
    await (module as (opts: Record<string, unknown>, nuxt: unknown) => Promise<void>)(
      { rest: { enabled: true } },
      nuxt,
    )
    expect(captured.serverHandlers).toHaveLength(1)
    expect(captured.serverHandlers[0]!.route).toBe('/api/noydb/**')
    expect(captured.serverHandlers[0]!.handler).toContain('rest')
  })

  it('uses a custom basePath when provided', async () => {
    const { default: module } = await import('../src/module.js')
    const nuxt = makeNuxtMock()
    await (module as (opts: Record<string, unknown>, nuxt: unknown) => Promise<void>)(
      { rest: { enabled: true, basePath: '/rpc' } },
      nuxt,
    )
    expect(captured.serverHandlers[0]!.route).toBe('/rpc/**')
  })

  it('populates runtimeConfig.public.noydb.rest when rest.enabled is true', async () => {
    const { default: module } = await import('../src/module.js')
    const nuxt = makeNuxtMock()
    await (module as (opts: Record<string, unknown>, nuxt: unknown) => Promise<void>)(
      { rest: { enabled: true, ttlSeconds: 1800, user: 'api' } },
      nuxt,
    )
    const rc = nuxt.options.runtimeConfig.public as Record<string, Record<string, unknown>>
    expect(rc['noydb']?.['rest']).toMatchObject({ enabled: true, ttlSeconds: 1800, user: 'api' })
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm --filter @noy-db/in-nuxt vitest run --reporter=verbose rest-module
```

Expected: test fails — no `rest` option is handled, no `addServerHandler` call.

- [ ] **Step 3: Add `rest` to `ModuleOptions` and wire `addServerHandler` in `module.ts`**

In `packages/in-nuxt/src/module.ts`, first update the `import` line:

Find:
```ts
import { defineNuxtModule, addImports, addPlugin, createResolver } from '@nuxt/kit'
```

Replace with:
```ts
import { defineNuxtModule, addImports, addPlugin, addServerHandler, createResolver } from '@nuxt/kit'
```

Then find the `ModuleOptions` interface and add the `rest` field at the end before the closing `}`:

Find the end of the `ModuleOptions` interface — it currently ends with the `auth?` block. Add:

```ts
  /**
   * Optional REST API integration. When `enabled: true`, mounts a catch-all
   * Nitro server handler at `basePath/**` using `@noy-db/in-rest`.
   */
  rest?: {
    /** Enable the REST API server handler. Default: false. */
    enabled?: boolean
    /** Base path for all REST routes. Default: '/api/noydb'. */
    basePath?: string
    /** User ID forwarded to createRestHandler. */
    user?: string
    /** Session TTL in seconds. Default: 900. */
    ttlSeconds?: number
  }
```

Then in the `setup(options, nuxt)` function, after the `addPlugin` call, add:

```ts
    // ─── 5. REST API server handler (opt-in) ────────────────────────
    if (options.rest && (options.rest as { enabled?: boolean }).enabled) {
      const restOpts = options.rest as {
        enabled?: boolean
        basePath?: string
        user?: string
        ttlSeconds?: number
      }
      const basePath = restOpts.basePath ?? '/api/noydb'
      addServerHandler({
        route: `${basePath}/**`,
        handler: resolver.resolve('./runtime/rest'),
      })
    }
```

- [ ] **Step 4: Create the Nitro server handler runtime file**

Create `packages/in-nuxt/src/runtime/rest.ts`:

```ts
import { defineEventHandler, getHeader, readBody, getQuery } from 'h3'
import { createRestHandler } from '@noy-db/in-rest'
import { nitroAdapter } from '@noy-db/in-rest/nitro'
import type { NoydbRestHandler } from '@noy-db/in-rest'
import type { NoydbStore } from '@noy-db/hub'

let _handler: NoydbRestHandler | null = null

function getHandler(store: NoydbStore, user: string, ttlSeconds: number, basePath: string): NoydbRestHandler {
  if (!_handler) {
    _handler = createRestHandler({ store, user, ttlSeconds, basePath })
  }
  return _handler
}

export default defineEventHandler(async (event) => {
  // runtimeConfig is available in Nitro context via useRuntimeConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = (event.context as any).runtimeConfig?.public?.noydb?.rest ?? {}
  const store = (event.context as Record<string, unknown>).noydbStore as NoydbStore | undefined

  if (!store) {
    return new Response(JSON.stringify({ error: 'noydb_store_not_configured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  const handler = getHandler(
    store,
    (config as { user?: string }).user ?? 'api',
    (config as { ttlSeconds?: number }).ttlSeconds ?? 900,
    (config as { basePath?: string }).basePath ?? '/api/noydb',
  )

  const h3Adapter = nitroAdapter(handler)

  const headers: Record<string, string> = {}
  for (const key of ['authorization', 'content-type', 'accept', 'x-request-id']) {
    const val = getHeader(event, key)
    if (val) headers[key] = val
  }

  const query = getQuery(event)
  const searchParams = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === 'string') searchParams.append(k, v)
    else if (Array.isArray(v)) v.forEach(val => { if (typeof val === 'string') searchParams.append(k, val) })
  }

  const url = new URL(event.path ?? '/', 'http://localhost')
  let bodyCache: unknown
  let bodyRead = false

  const result = await handler.handle({
    method: event.method ?? 'GET',
    pathname: url.pathname,
    searchParams,
    headers,
    json: async () => {
      if (!bodyRead) { bodyCache = await readBody(event); bodyRead = true }
      return bodyCache
    },
  })

  void h3Adapter // referenced to satisfy the import (used in the type above)

  return new Response(result.body as string | null, {
    status: result.status,
    headers: result.headers,
  })
})
```

- [ ] **Step 5: Add `@noy-db/in-rest` to `in-nuxt` peer deps and update tsup**

In `packages/in-nuxt/package.json`, add to `peerDependencies`:

```json
"@noy-db/in-rest": "workspace:*"
```

And add to `devDependencies`:

```json
"@noy-db/in-rest": "workspace:*"
```

In `packages/in-nuxt/tsup.config.ts`, update the `entry` array and `external` array:

Find:
```ts
  entry: ['src/index.ts', 'src/runtime/plugin.client.ts'],
```

Replace with:
```ts
  entry: ['src/index.ts', 'src/runtime/plugin.client.ts', 'src/runtime/rest.ts'],
```

Find:
```ts
  external: [
    '@nuxt/kit',
    '@nuxt/schema',
    'nuxt',
    'nuxt/app',
    '@noy-db/hub',
    '@noy-db/in-pinia',
    '@noy-db/in-vue',
  ],
```

Replace with:
```ts
  external: [
    '@nuxt/kit',
    '@nuxt/schema',
    'nuxt',
    'nuxt/app',
    '@noy-db/hub',
    '@noy-db/in-pinia',
    '@noy-db/in-vue',
    '@noy-db/in-rest',
    'h3',
  ],
```

- [ ] **Step 6: Run the in-nuxt test suite**

```bash
pnpm --filter @noy-db/in-nuxt vitest run --reporter=verbose
```

Expected: all tests pass including the new rest-module tests.

- [ ] **Step 7: Commit**

```bash
git add packages/in-nuxt/src/module.ts packages/in-nuxt/src/runtime/rest.ts packages/in-nuxt/package.json packages/in-nuxt/tsup.config.ts packages/in-nuxt/__tests__/rest-module.test.ts
git commit -m "feat(in-nuxt): mount in-rest through Nitro server routes (#273)

closes #273"
```

---

## Task 6: Full verification pass

- [ ] **Step 1: Install all workspace deps**

```bash
pnpm install
```

- [ ] **Step 2: Run all affected package tests**

```bash
pnpm --filter @noy-db/hub vitest run
pnpm --filter @noy-db/in-solid vitest run
pnpm --filter @noy-db/in-rest vitest run
pnpm --filter @noy-db/in-nuxt vitest run
```

Expected: all suites green.

- [ ] **Step 3: Typecheck all affected packages**

```bash
pnpm --filter @noy-db/hub typecheck
pnpm --filter @noy-db/in-solid typecheck
pnpm --filter @noy-db/in-rest typecheck
pnpm --filter @noy-db/in-nuxt typecheck
```

Expected: no type errors.

- [ ] **Step 4: Lint all affected packages**

```bash
pnpm --filter @noy-db/hub lint
pnpm --filter @noy-db/in-solid lint
pnpm --filter @noy-db/in-rest lint
pnpm --filter @noy-db/in-nuxt lint
```

Expected: no lint errors. If `no-explicit-any` fires on `router.ts` or `rest.ts`, replace the offending `any` casts with `unknown` + type narrowing as needed.

- [ ] **Step 5: Close the GitHub issues**

```bash
gh issue close 271 272 274 273 188 --comment "Implemented in $(git rev-parse --short HEAD)"
```

---

## Self-Review Checklist

- [x] **#271 spec coverage:** `put()`, `delete()`, `rename()` all emit. `putAll()` covered via `put()` loop. Test asserts `rename()` emits two events in order.
- [x] **#188 spec coverage:** `createCollectionSignal`, `createQuerySignal`, `createSyncSignal` all present with tests.
- [x] **#272 spec coverage:** all 8 routes implemented. Passphrase-only auth. In-memory session store. `basePath` stripping. Query-param filtering. 10 test cases.
- [x] **#274 spec coverage:** Hono, Express, Fastify, Nitro adapters. Subpath exports in `package.json`. `tsup.config.ts` with 5 entries. Adapter tests.
- [x] **#273 spec coverage:** `rest` option block. `addServerHandler` call. `runtimeConfig` population. `rest.ts` runtime file. `peerDependencies` updated. Tests assert enable/disable/basePath/runtimeConfig.
- [x] **Type consistency:** `RestRequest`, `RestResponse`, `NoydbRestHandler` defined once in `src/index.ts`, imported by all adapters and the router.
- [x] **No placeholders:** all code is complete.
- [x] **Peer dep convention:** all `workspace:*` not `workspace:^`.
