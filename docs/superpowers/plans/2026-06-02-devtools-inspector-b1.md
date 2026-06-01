# Devtools Inspector — B1 Inspector Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@noy-db/in-devtools` — a framework-agnostic `createInspector(noydb)` that turns a live `Noydb` + open `Vault` handles into plain, serializable read-only structures (vault list, schema/stats snapshot, paged records) plus a live write stream — using only public hub APIs.

**Architecture:** A new `in-*` package, pure consumer of public `@noy-db/hub` APIs (`listAccessibleVaults`, `dumpSchema`, `query`/`list`, `onAfterWrite`, `writeQueue`). Zero hub changes. Returns plain objects (no live handles), read-only, operates within an already-unlocked session.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), tsup (dual ESM/CJS), Vitest (node env — no DOM in the core). Package `packages/in-devtools`. Spec: `docs/superpowers/specs/2026-06-02-devtools-inspector-b1-design.md`.

**Known B1 simplifications (documented, follow-ons):** `records()` targets EAGER collections — `list()`/`query()` throw on lazy (`prefetch:false`) collections; that error propagates to the caller (lazy support via `scan`/`listPage` is a follow-on). `records()` computes `total` via `list()` (decrypts all internally) then slices to `limit`; output is bounded to `limit` rows, internal-fetch optimization (cursor `listPage`) is a follow-on.

---

## File Structure

```
packages/in-devtools/
  package.json        # in-* template (type module, tsup, vitest, hub peer-dep)
  tsconfig.json       # extends ../../tsconfig.base.json
  tsup.config.ts      # dual ESM/CJS, dts (copy of in-pinia's)
  vitest.config.ts    # node env
  src/
    types.ts          # public inspector types (VaultInfo, InspectorSnapshot, InspectorCollection, RecordPage)
    snapshot.ts       # listVaults() + snapshot() projections
    records.ts        # records() paging
    events.ts         # subscribe() + pendingWrites()
    index.ts          # createInspector() facade + re-exports
  __tests__/
    inspector.test.ts # all behaviors against an in-memory Noydb
```

---

### Task 1: Scaffold the package

**Files:** Create `packages/in-devtools/{package.json,tsconfig.json,tsup.config.ts,vitest.config.ts,src/index.ts}`

- [ ] **Step 1: Create `packages/in-devtools/package.json`**

```json
{
  "name": "@noy-db/in-devtools",
  "version": "0.2.0-pre.3",
  "description": "Framework-agnostic read-only inspector for a live noy-db — vaults, collections, schema, stats, records, and live writes.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": { "@noy-db/hub": "workspace:*" },
  "devDependencies": { "@noy-db/hub": "workspace:*" }
}
```

- [ ] **Step 2: Create `packages/in-devtools/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/in-devtools/tsup.config.ts`**

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

- [ ] **Step 4: Create `packages/in-devtools/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'in-devtools',
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
  },
})
```

- [ ] **Step 5: Create a stub `packages/in-devtools/src/index.ts`** (so install/typecheck resolve)

```ts
export {}
```

- [ ] **Step 6: Install + verify the package is wired into the workspace**

Run: `pnpm install`
Then: `pnpm --filter @noy-db/in-devtools typecheck`
Expected: install succeeds (package auto-discovered via `packages/*`), typecheck passes (empty module).

- [ ] **Step 7: Commit**

```bash
git add packages/in-devtools/package.json packages/in-devtools/tsconfig.json packages/in-devtools/tsup.config.ts packages/in-devtools/vitest.config.ts packages/in-devtools/src/index.ts pnpm-lock.yaml
git commit -m "feat(in-devtools): scaffold the inspector-core package (Track B / B1)"
```

---

### Task 2: Public types

**Files:** Create `packages/in-devtools/src/types.ts`

- [ ] **Step 1: Create `packages/in-devtools/src/types.ts`**

```ts
import type {
  Noydb,
  Vault,
  WriteEvent,
  AccessibleVault,
  FieldDescriptor,
} from '@noy-db/hub'

/** Top-level accessible-vault entry (plain projection of the hub's AccessibleVault). */
export type VaultInfo = AccessibleVault // { id: string; role: Role }

/** One collection in a snapshot — a flattened projection of the hub's CollectionDescriptor. */
export interface InspectorCollection {
  readonly name: string
  readonly fields: Record<string, FieldDescriptor>
  readonly indexes: ReadonlyArray<{ readonly fields: ReadonlyArray<string>; readonly unique?: boolean }>
  readonly refs: Record<string, { readonly target: string; readonly mode: 'strict' | 'warn' | 'cascade' }>
  readonly stats?: {
    readonly records: number
    readonly bytes: number
    readonly bytesAvg: number
    readonly oldest: string
    readonly newest: string
  }
}

/** Structure + stats for one open vault. */
export interface InspectorSnapshot {
  readonly vault: string
  readonly collections: ReadonlyArray<InspectorCollection>
}

/** A page of decrypted records from one collection. */
export interface RecordPage {
  readonly rows: ReadonlyArray<unknown>
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** Live write event surfaced to subscribers (the hub's public WriteEvent, unchanged — already plain). */
export type InspectorWriteEvent = WriteEvent

/** Pending-write state. */
export interface PendingWrites {
  readonly pending: boolean
  readonly depth: number
}

/** The read-only inspector facade returned by createInspector(). */
export interface Inspector {
  listVaults(): Promise<ReadonlyArray<VaultInfo>>
  snapshot(vault: Vault): Promise<InspectorSnapshot>
  records(vault: Vault, collection: string, opts?: { limit?: number; offset?: number }): Promise<RecordPage>
  subscribe(handler: (event: InspectorWriteEvent) => void): () => void
  pendingWrites(): PendingWrites
}

/** @internal — the hub handle the inspector reads from. */
export type InspectorNoydb = Noydb
```

- [ ] **Step 2: Verify it typechecks** (no test yet — pure types)

Run: `pnpm --filter @noy-db/in-devtools typecheck`
Expected: PASS. If a named type (e.g. `AccessibleVault`, `FieldDescriptor`, `WriteEvent`) is not exported from `@noy-db/hub`, confirm the exact exported name in `packages/hub/src/index.ts` and adjust the import. (Verified present: `WriteEvent`, `AccessibleVault`, `FieldDescriptor`, `Noydb`, `Vault` are all exported.)

- [ ] **Step 3: Commit**

```bash
git add packages/in-devtools/src/types.ts
git commit -m "feat(in-devtools): public inspector types (Track B / B1)"
```

---

### Task 3: `listVaults()` + `snapshot()`

**Files:** Create `packages/in-devtools/src/snapshot.ts`; Test: `packages/in-devtools/__tests__/inspector.test.ts`

- [ ] **Step 1: Write the failing test** — create `packages/in-devtools/__tests__/inspector.test.ts` with a shared in-memory harness + the snapshot tests:

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '@noy-db/hub'
import type { Noydb, NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { createInspector } from '../src/index.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const coll = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const m = coll(v, c); const ex = m.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      m.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll() {},
  }
}

interface Note { id: string; title: string; body: string }

async function seeded(): Promise<{ db: Noydb }> {
  const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
  const v = await db.openVault('v1')
  const notes = v.collection<Note>('notes')
  await notes.put('a', { id: 'a', title: 'A', body: 'first' })
  await notes.put('b', { id: 'b', title: 'B', body: 'second' })
  return { db }
}

describe('inspector — listVaults + snapshot', () => {
  it('listVaults returns accessible vaults', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const vaults = await insp.listVaults()
    expect(vaults.some((x) => x.id === 'v1')).toBe(true)
  })

  it('snapshot returns the collection with stats', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const v = await db.openVault('v1')
    const snap = await insp.snapshot(v)
    expect(snap.vault).toBe('v1')
    const notes = snap.collections.find((c) => c.name === 'notes')
    expect(notes).toBeTruthy()
    expect(notes!.stats?.records).toBe(2)
  })
})
```

> Before running: confirm `createNoydb`'s required args (`user`/`secret`) and `db.openVault`/`vault.collection` match an existing hub or in-pinia test; adjust the harness call if the version differs (the `subsystem-bus-integration.test.ts` harness uses exactly this shape).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools test`
Expected: FAIL — `createInspector` is not exported (still the stub).

- [ ] **Step 3: Implement `snapshot.ts`**

```ts
import type { Vault } from '@noy-db/hub'
import type { InspectorSnapshot, InspectorCollection, VaultInfo, InspectorNoydb } from './types.js'

export async function listVaults(noydb: InspectorNoydb): Promise<ReadonlyArray<VaultInfo>> {
  return noydb.listAccessibleVaults()
}

export async function snapshot(vault: Vault): Promise<InspectorSnapshot> {
  // withStats populates per-collection record/byte stats; opaque to the store.
  const dump = await vault.dumpSchema({ withStats: true })
  const collections: InspectorCollection[] = Object.entries(dump.collections).map(([name, desc]) => ({
    name,
    fields: desc.fields,
    indexes: desc.indexes,
    refs: desc.refs,
    stats: desc.stats,
  }))
  return { vault: dump.vault, collections }
}
```

> If `dumpSchema` is gated behind a strategy in this version (it is not — it's always-on core, but its STATS may require `withStats`), the call above is correct. If `listAccessibleVaults` requires an options argument, pass `{}`.

- [ ] **Step 4: Wire into `index.ts`** (replace the stub)

```ts
import type { Vault } from '@noy-db/hub'
import type { Inspector, InspectorNoydb, InspectorSnapshot, VaultInfo } from './types.js'
import { listVaults, snapshot } from './snapshot.js'

export function createInspector(noydb: InspectorNoydb): Inspector {
  return {
    listVaults: () => listVaults(noydb),
    snapshot: (vault: Vault) => snapshot(vault),
    // records / subscribe / pendingWrites added in later tasks.
  } as Inspector
}

export type {
  Inspector, VaultInfo, InspectorSnapshot, InspectorCollection,
  RecordPage, InspectorWriteEvent, PendingWrites,
} from './types.js'
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @noy-db/in-devtools test`
Expected: PASS (2 snapshot tests). (`records`/`subscribe`/`pendingWrites` are typed on `Inspector` but not yet implemented — the `as Inspector` cast bridges this until Task 4/5; no test calls them yet.)

- [ ] **Step 6: Commit**

```bash
git add packages/in-devtools/src/snapshot.ts packages/in-devtools/src/index.ts packages/in-devtools/__tests__/inspector.test.ts
git commit -m "feat(in-devtools): listVaults + snapshot (Track B / B1)"
```

---

### Task 4: `records()` paging

**Files:** Create `packages/in-devtools/src/records.ts`; Modify `index.ts`; extend the test.

- [ ] **Step 1: Add the failing test** — append to `inspector.test.ts` inside a new describe:

```ts
describe('inspector — records', () => {
  it('returns a bounded page with an accurate total', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const v = await db.openVault('v1')
    const page = await insp.records(v, 'notes', { limit: 1, offset: 0 })
    expect(page.total).toBe(2)
    expect(page.rows).toHaveLength(1)
    expect(page.limit).toBe(1)
    expect(page.offset).toBe(0)
  })

  it('clamps limit to the hard ceiling and floors a bad offset to 0', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const v = await db.openVault('v1')
    const page = await insp.records(v, 'notes', { limit: 99999, offset: -5 })
    expect(page.limit).toBe(500) // MAX_LIMIT
    expect(page.offset).toBe(0)
    expect(page.rows).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools test`
Expected: FAIL — `insp.records` is not a function (not implemented).

- [ ] **Step 3: Implement `records.ts`**

```ts
import type { Vault } from '@noy-db/hub'
import type { RecordPage } from './types.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

function clampLimit(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)))
}

function clampOffset(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n) || n < 0) return 0
  return Math.floor(n)
}

export async function records(
  vault: Vault,
  collection: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<RecordPage> {
  const limit = clampLimit(opts.limit)
  const offset = clampOffset(opts.offset)
  // Eager collections only — `list()` throws on lazy (prefetch:false). The
  // error propagates to the caller, which decides how to surface it.
  const all = await vault.collection(collection).list()
  return {
    rows: all.slice(offset, offset + limit),
    total: all.length,
    limit,
    offset,
  }
}
```

- [ ] **Step 4: Wire into `index.ts`** — add to the returned object:

```ts
import { records } from './records.js'
// inside createInspector return:
    records: (vault, collection, opts) => records(vault, collection, opts),
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @noy-db/in-devtools test`
Expected: PASS (records tests + prior).

- [ ] **Step 6: Commit**

```bash
git add packages/in-devtools/src/records.ts packages/in-devtools/src/index.ts packages/in-devtools/__tests__/inspector.test.ts
git commit -m "feat(in-devtools): paged records() (Track B / B1)"
```

---

### Task 5: `subscribe()` + `pendingWrites()`

**Files:** Create `packages/in-devtools/src/events.ts`; Modify `index.ts`; extend the test.

- [ ] **Step 1: Add the failing test** — append to `inspector.test.ts`:

```ts
describe('inspector — subscribe + pendingWrites', () => {
  it('subscribe fires on put (create) and unsubscribe stops it', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const seen: Array<{ op: string; collection: string; docId: string }> = []
    const off = insp.subscribe((e) => { seen.push({ op: e.op, collection: e.collection, docId: e.docId }) })

    const v = await db.openVault('v1')
    await v.collection('notes').put('c', { id: 'c', title: 'C', body: 'third' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ op: 'create', collection: 'notes', docId: 'c' })

    off()
    await v.collection('notes').put('d', { id: 'd', title: 'D', body: 'fourth' })
    expect(seen).toHaveLength(1) // no further events after unsubscribe
  })

  it('subscribe fires on delete with after:null', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const seen: Array<{ op: string; after: unknown }> = []
    insp.subscribe((e) => { seen.push({ op: e.op, after: e.after }) })
    const v = await db.openVault('v1')
    await v.collection('notes').delete('a')
    expect(seen).toEqual([{ op: 'delete', after: null }])
  })

  it('pendingWrites reflects the write queue', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const pw = insp.pendingWrites()
    expect(pw.pending).toBe(false)
    expect(typeof pw.depth).toBe('number')
  })

  it('read-only: inspecting does not mutate the store', async () => {
    const { db } = await seeded()
    const insp = createInspector(db)
    const v = await db.openVault('v1')
    await insp.listVaults()
    await insp.snapshot(v)
    await insp.records(v, 'notes')
    insp.pendingWrites()
    const after = await insp.records(v, 'notes')
    expect(after.total).toBe(2) // unchanged
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @noy-db/in-devtools test`
Expected: FAIL — `insp.subscribe`/`insp.pendingWrites` not functions.

- [ ] **Step 3: Implement `events.ts`**

```ts
import type { InspectorWriteEvent, PendingWrites, InspectorNoydb } from './types.js'

export function subscribe(
  noydb: InspectorNoydb,
  handler: (event: InspectorWriteEvent) => void,
): () => void {
  return noydb.onAfterWrite(handler)
}

export function pendingWrites(noydb: InspectorNoydb): PendingWrites {
  const q = noydb.writeQueue
  return { pending: q.pending, depth: q.depth }
}
```

- [ ] **Step 4: Wire into `index.ts`** — add to the returned object + import:

```ts
import { subscribe, pendingWrites } from './events.js'
// inside createInspector return:
    subscribe: (handler) => subscribe(noydb, handler),
    pendingWrites: () => pendingWrites(noydb),
```

Then remove the `as Inspector` cast — the object now fully implements `Inspector`. The final `createInspector` returns a plain object literal satisfying `Inspector`.

- [ ] **Step 5: Run to verify it passes + full package build + typecheck**

Run: `pnpm --filter @noy-db/in-devtools test`
Expected: PASS (all describes).
Run: `pnpm --filter @noy-db/in-devtools typecheck && pnpm --filter @noy-db/in-devtools build`
Expected: typecheck clean; tsup emits `dist/` (ESM+CJS+dts).

- [ ] **Step 6: Run the architecture check (peer-dep + portability invariants)**

Run: `pnpm check:architecture`
Expected: PASS — `in-devtools` peer-deps `@noy-db/hub` as `workspace:*` (check 1), declares no crypto deps (check 2). (The package imports only from `@noy-db/hub`, no Node built-ins, so it stays portable.)

- [ ] **Step 7: Commit**

```bash
git add packages/in-devtools/src/events.ts packages/in-devtools/src/index.ts packages/in-devtools/__tests__/inspector.test.ts
git commit -m "feat(in-devtools): subscribe + pendingWrites; complete inspector facade (Track B / B1)"
```

---

## Self-Review

**Spec coverage:**
- External package, public APIs only, zero hub changes → Task 1 (peer-dep only) + all impls call public methods. ✅
- `createInspector(noydb)` facade → Task 5 final. ✅
- `listVaults()` (listAccessibleVaults), `snapshot()` (dumpSchema), `records()` (list+slice), `subscribe()` (onAfterWrite), `pendingWrites()` (writeQueue) → Tasks 3/4/5. ✅
- Plain serializable output → all projections return plain objects; WriteEvent is already plain. ✅
- Read-only + bounded → records() clamps to MAX_LIMIT; read-only test in Task 5. ✅
- Zero-knowledge (open vaults passed in, permissions inherited) → records()/snapshot() take a `Vault` the caller opened; no passphrase handling. ✅
- Testing surface (snapshot/records/subscribe/pendingWrites/read-only/serializable) → Tasks 3–5. (Serializable: WriteEvent + plain projections are structuredClone-safe; an explicit `structuredClone` assertion may be added but the read-only + shape tests already exercise plainness.) ✅
- Documented simplifications (eager-only records, internal full-load) → header + records.ts comment. ✅

**Placeholder scan:** none. The "confirm exact exported name / createNoydb arg shape" notes are concrete verification instructions with the verified answer stated.

**Type consistency:** `Inspector`, `VaultInfo`, `InspectorSnapshot`, `InspectorCollection`, `RecordPage`, `InspectorWriteEvent`, `PendingWrites`, `createInspector` used identically across types.ts → snapshot.ts → records.ts → events.ts → index.ts. `records(vault, collection, opts)` signature matches the `Inspector` interface and the impl. ✅

---

## Follow-on (after B1)

- **B2 — CLI/TUI inspector** over `createInspector` (complements `noydb describe`).
- **B3 — Browser panel** over `createInspector` (uses the serializable output across a postMessage boundary).
- B1 extensions: lazy-collection records (cursor `listPage`/`scan`), history timeline, sync/presence state, register `in-devtools` in `features.yaml` + a showcase.
