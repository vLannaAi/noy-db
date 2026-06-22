# AI Retrieval L1.5 — Persisted Lexical Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make L1's lexical index persistable — opt-in `textIndexPersist` serializes the `InvertedIndex` to one opaque encrypted blob (collection DEK), skips the cold-rebuild scan on later sessions via a fingerprint, refreshes via debounced flush + awaitable `flushIndex()`, and tears down on `forget()`. Plus `RetrieveHit.rank` for future cross-vault fusion.

**Architecture:** New `PersistedIndexStore` behind the existing `IndexStore` seam (which becomes async: `getOrBuild`→`ensureBuilt`+`flush`). The store is crypto-free — the collection injects `{load, save, remove, currentFingerprint}` callbacks built from `encryptJsonString`/`decryptJsonString` + `adapter` against a reserved `_ftindex` collection namespace. Correctness backstop: a `{count,maxVersion}` fingerprint means a stale/missing blob is never used, only rebuilt.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), vitest (`vitest run` from `packages/hub`), reusing the encrypted side-car pattern + the `SnapshotScheduler` debounce precedent.

**Spec:** `docs/superpowers/specs/2026-06-22-ai-retrieval-l1.5-persisted-index-design.md`

## Global Constraints

- Hub-portable: no Node-only imports in `packages/hub/src/**`. (`setTimeout`/`clearTimeout` are universal — allowed.)
- Tree-shakeable: all new logic in `src/search/`; `MemoryIndexStore` stays the default (zero cost when `textIndexPersist` unset).
- Zero added store leakage: the only new store artifact is ONE opaque ciphertext blob at collection `_ftindex`, id `<collectionName>`; never plaintext/terms, no per-term addressability.
- The index blob lives in the reserved **`_ftindex` collection** (NOT a record-id in the parent collection) so eager `loadAll`/hydrate (which excludes `_`-prefixed collection names) never treats it as a record.
- `exactOptionalPropertyTypes` is on — assign optional props via spread-conditional.
- eager-only (retrieve/warmIndex already throw in lazy mode).
- No Claude/AI attribution in commits.

---

## Task 1: InvertedIndex snapshot (serialize/deserialize)

**Files:**
- Modify: `packages/hub/src/search/inverted-index.ts` (add `toSnapshot()` + static `fromSnapshot()`)
- Create: `packages/hub/src/search/serialize.ts`
- Test: `packages/hub/__tests__/search-serialize.test.ts`

**Interfaces:**
- Consumes: `InvertedIndex` internals — `private fieldStats: Map<string,{df:Map<string,number>;n:number;totalLen:number}>`, `private docs: Doc[]` where `Doc={id,field,locale?,text,len,tf:Map<string,number>,firstOffset:Map<string,number>}`.
- Produces: `interface IndexSnapshot` (JSON-safe); `InvertedIndex.toSnapshot(): IndexSnapshot`; `InvertedIndex.fromSnapshot(s: IndexSnapshot): InvertedIndex`; `serializeIndex(idx): string`; `deserializeIndex(json): InvertedIndex`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-serialize.test.ts
import { describe, it, expect } from 'vitest'
import { InvertedIndex, type IndexDoc } from '../src/search/inverted-index.js'
import { serializeIndex, deserializeIndex } from '../src/search/serialize.js'

const docs: IndexDoc[] = [
  { id: 'a', fields: [{ field: 'desc', text: 'overdue invoice TCM' }] },
  { id: 'b', fields: [{ field: 'desc', text: 'paid invoice' }, { field: 'notes', locale: 'th', text: 'ค่าเช่า TCM' }] },
]

describe('index snapshot round-trip (#308 L1.5)', () => {
  it('serialize → deserialize yields identical query results', () => {
    const orig = InvertedIndex.build(docs)
    const restored = deserializeIndex(serializeIndex(orig))
    for (const q of ['invoice', 'TCM', 'ค่าเช่า', 'paid']) {
      expect(restored.query(q)).toEqual(orig.query(q))
    }
  })
  it('preserves locale + offsets (snippet fidelity)', () => {
    const restored = deserializeIndex(serializeIndex(InvertedIndex.build(docs)))
    const hit = restored.query('ค่าเช่า').find((h) => h.id === 'b')!
    expect(hit.locale).toBe('th')
    expect(hit.text.slice(hit.offset, hit.offset + 'ค่าเช่า'.length)).toBe('ค่าเช่า')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-serialize.test.ts`
Expected: FAIL — `../src/search/serialize.js` missing.

- [ ] **Step 3: Add `toSnapshot`/`fromSnapshot` to `InvertedIndex`**

In `packages/hub/src/search/inverted-index.ts`, add the snapshot type near the top exports and the two methods on the class (Maps → arrays for JSON):

```ts
export interface IndexSnapshot {
  readonly v: 1
  readonly fieldStats: ReadonlyArray<[string, { df: [string, number][]; n: number; totalLen: number }]>
  readonly docs: ReadonlyArray<{
    id: string; field: string; locale?: string; text: string; len: number
    tf: [string, number][]; firstOffset: [string, number][]
  }>
}
```

Add as public methods on `InvertedIndex` (after `query`):

```ts
  toSnapshot(): IndexSnapshot {
    return {
      v: 1,
      fieldStats: [...this.fieldStats].map(([f, s]) => [f, { df: [...s.df], n: s.n, totalLen: s.totalLen }]),
      docs: this.docs.map((d) => ({
        id: d.id, field: d.field, text: d.text, len: d.len,
        tf: [...d.tf], firstOffset: [...d.firstOffset],
        ...(d.locale !== undefined ? { locale: d.locale } : {}),
      })),
    }
  }

  static fromSnapshot(s: IndexSnapshot): InvertedIndex {
    const idx = new InvertedIndex()
    for (const [f, st] of s.fieldStats) idx.fieldStats.set(f, { df: new Map(st.df), n: st.n, totalLen: st.totalLen })
    for (const d of s.docs) {
      idx.docs.push({
        id: d.id, field: d.field, text: d.text, len: d.len,
        tf: new Map(d.tf), firstOffset: new Map(d.firstOffset),
        ...(d.locale !== undefined ? { locale: d.locale } : {}),
      })
    }
    return idx
  }
```

(`fieldStats`/`docs` are `private` but accessed within the class's own static method — TypeScript allows access to private members from the same class, including static methods.)

- [ ] **Step 4: Create `serialize.ts`**

```ts
// packages/hub/src/search/serialize.ts
/** (De)serialize an InvertedIndex to/from a JSON string for persistence (#308 L1.5). */
import { InvertedIndex } from './inverted-index.js'

export function serializeIndex(idx: InvertedIndex): string {
  return JSON.stringify(idx.toSnapshot())
}

export function deserializeIndex(json: string): InvertedIndex {
  return InvertedIndex.fromSnapshot(JSON.parse(json))
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/search-serialize.test.ts` → PASS (2). Then `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/search/inverted-index.ts packages/hub/src/search/serialize.ts packages/hub/__tests__/search-serialize.test.ts
git commit -m "feat(search): InvertedIndex snapshot serialize/deserialize (#308 L1.5)"
```

---

## Task 2: IndexStore async evolution (`ensureBuilt` + `flush`)

**Files:**
- Modify: `packages/hub/src/search/index-store.ts`
- Modify: `packages/hub/src/collection.ts` (the 2 `getOrBuild` call sites + `built` reads — lines ~2847-2867)
- Test: `packages/hub/__tests__/search-index-store.test.ts` (update for async)

**Interfaces:**
- Produces: `interface IndexStore { ensureBuilt(build: () => ReadonlyArray<IndexDoc>): Promise<InvertedIndex>; markDirty(): void; flush(): Promise<void>; readonly built: boolean }`; `MemoryIndexStore` implementing it.

- [ ] **Step 1: Update the test (async)**

Rewrite `packages/hub/__tests__/search-index-store.test.ts` to `await store.ensureBuilt(...)` and assert `await store.flush()` is a no-op for memory:

```ts
import { describe, it, expect } from 'vitest'
import { MemoryIndexStore } from '../src/search/index-store.js'
import type { IndexDoc } from '../src/search/inverted-index.js'

const docs: IndexDoc[] = [{ id: 'a', fields: [{ field: 'desc', text: 'invoice' }] }]

describe('MemoryIndexStore (#308 L1.5 async)', () => {
  it('builds once and caches', async () => {
    const store = new MemoryIndexStore()
    let calls = 0
    const build = () => { calls++; return docs }
    const i1 = await store.ensureBuilt(build)
    const i2 = await store.ensureBuilt(build)
    expect(calls).toBe(1); expect(i1).toBe(i2); expect(store.built).toBe(true)
    await store.flush() // no-op, resolves
  })
  it('markDirty forces a rebuild', async () => {
    const store = new MemoryIndexStore()
    let calls = 0
    const build = () => { calls++; return docs }
    await store.ensureBuilt(build); store.markDirty()
    expect(store.built).toBe(false)
    await store.ensureBuilt(build); expect(calls).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-index-store.test.ts` → FAIL (`ensureBuilt`/`flush` don't exist).

- [ ] **Step 3: Update `index-store.ts`**

```ts
export interface IndexStore {
  ensureBuilt(build: () => ReadonlyArray<IndexDoc>): Promise<InvertedIndex>
  markDirty(): void
  flush(): Promise<void>
  readonly built: boolean
}

export class MemoryIndexStore implements IndexStore {
  private index: InvertedIndex | undefined
  get built(): boolean { return this.index !== undefined }
  async ensureBuilt(build: () => ReadonlyArray<IndexDoc>): Promise<InvertedIndex> {
    if (this.index === undefined) this.index = InvertedIndex.build(build())
    return this.index
  }
  markDirty(): void { this.index = undefined }
  async flush(): Promise<void> { /* in-memory: nothing to persist */ }
}
```

- [ ] **Step 4: Update the L1 call sites in `collection.ts`**

In `retrieve()` (~line 2867) and `warmIndex()` (~line 2850), change `const index = this.searchIndexStore.getOrBuild(...)` to `const index = await this.searchIndexStore.ensureBuilt(...)`. Both methods are already `async`. The `built` reads at ~2847/2864 are unchanged. Search for any other `getOrBuild` usage and convert (there should be exactly these two).

- [ ] **Step 5: Run tests**

Run: `cd packages/hub && npx vitest run __tests__/search-index-store.test.ts __tests__/search-retrieve.test.ts && npx tsc --noEmit`
Expected: PASS; tsc clean. Then `npx vitest run` (full suite — confirms the L1 retrieve path still works under async store).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/search/index-store.ts packages/hub/src/collection.ts packages/hub/__tests__/search-index-store.test.ts
git commit -m "feat(search): IndexStore async ensureBuilt + flush seam (#308 L1.5)"
```

---

## Task 3: PersistedIndexStore (crypto-free, injected callbacks)

**Files:**
- Create: `packages/hub/src/search/persisted-index-store.ts`
- Test: `packages/hub/__tests__/search-persisted-index-store.test.ts`

**Interfaces:**
- Consumes: `IndexStore`, `InvertedIndex`, `IndexDoc` (`./inverted-index.js`), `serializeIndex`/`deserializeIndex` (`./serialize.js`).
- Produces:
  - `interface Fingerprint { readonly count: number; readonly maxVersion: number }`
  - `interface PersistedIndexCallbacks { load(): Promise<{ json: string; fingerprint: Fingerprint } | null>; save(json: string, fp: Fingerprint): Promise<void>; remove(): Promise<void>; currentFingerprint(): Fingerprint; debounceMs?: number }`
  - `class PersistedIndexStore implements IndexStore` (adds `removePersisted(): Promise<void>` for forget).

- [ ] **Step 1: Write the failing test** (fake callbacks — no real crypto)

```ts
// packages/hub/__tests__/search-persisted-index-store.test.ts
import { describe, it, expect } from 'vitest'
import { PersistedIndexStore, type Fingerprint } from '../src/search/persisted-index-store.js'
import type { IndexDoc } from '../src/search/inverted-index.js'

const docs: IndexDoc[] = [{ id: 'a', fields: [{ field: 'd', text: 'invoice' }] }]

function harness(fp: Fingerprint = { count: 1, maxVersion: 1 }) {
  const blob: { json: string; fingerprint: Fingerprint } | null = null as any
  const state = { blob, saves: 0, removes: 0, fp }
  const store = new PersistedIndexStore({
    load: async () => state.blob,
    save: async (json, f) => { state.saves++; state.blob = { json, fingerprint: f } },
    remove: async () => { state.removes++; state.blob = null },
    currentFingerprint: () => state.fp,
    debounceMs: 10,
  })
  return { store, state }
}

describe('PersistedIndexStore (#308 L1.5)', () => {
  it('cold build persists; warm load skips the build fn', async () => {
    const { store, state } = harness()
    let builds = 0
    const build = () => { builds++; return docs }
    await store.ensureBuilt(build)            // cold: build + save
    expect(builds).toBe(1); expect(state.saves).toBe(1)
    // simulate a NEW session: fresh store, same blob + matching fingerprint
    const store2 = new PersistedIndexStore({
      load: async () => state.blob, save: async () => {}, remove: async () => {},
      currentFingerprint: () => state.fp, debounceMs: 10,
    })
    let builds2 = 0
    await store2.ensureBuilt(() => { builds2++; return docs })
    expect(builds2).toBe(0)                    // warm: deserialized, no rebuild
    expect((await store2.ensureBuilt(() => docs)).query('invoice').map((h) => h.id)).toEqual(['a'])
  })

  it('stale fingerprint forces a rebuild', async () => {
    const { store, state } = harness()
    await store.ensureBuilt(() => docs)
    state.fp = { count: 2, maxVersion: 5 } // someone wrote elsewhere
    const store2 = new PersistedIndexStore({
      load: async () => state.blob, save: async () => {}, remove: async () => {},
      currentFingerprint: () => state.fp, debounceMs: 10,
    })
    let builds = 0
    await store2.ensureBuilt(() => { builds++; return docs })
    expect(builds).toBe(1) // blob fingerprint {1,1} != current {2,5} → rebuild
  })

  it('markDirty debounces a single flush; flush() is immediate', async () => {
    const { store, state } = harness()
    await store.ensureBuilt(() => docs)        // saves=1
    store.markDirty(); store.markDirty(); store.markDirty()
    await new Promise((r) => setTimeout(r, 30)) // debounce window (10ms) elapses
    expect(state.saves).toBe(2)                 // one coalesced flush
    store.markDirty(); await store.flush()
    expect(state.saves).toBe(3)                 // explicit immediate
  })

  it('removePersisted deletes the blob + marks dirty', async () => {
    const { store, state } = harness()
    await store.ensureBuilt(() => docs)
    await store.removePersisted()
    expect(state.removes).toBe(1); expect(store.built).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-persisted-index-store.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/search/persisted-index-store.ts
/**
 * Persisted backend for the L1 lexical index (#308 L1.5). Crypto-free: the
 * collection injects load/save/remove + a fingerprint provider. In-memory while
 * live (L1 behavior); persists an opaque snapshot via a debounced flush, and
 * validates a loaded blob against a {count,maxVersion} fingerprint so a stale
 * blob is never used — only rebuilt.
 */
import { InvertedIndex, type IndexDoc } from './inverted-index.js'
import { serializeIndex, deserializeIndex } from './serialize.js'
import type { IndexStore } from './index-store.js'

export interface Fingerprint { readonly count: number; readonly maxVersion: number }

export interface PersistedIndexCallbacks {
  load(): Promise<{ json: string; fingerprint: Fingerprint } | null>
  save(json: string, fp: Fingerprint): Promise<void>
  remove(): Promise<void>
  currentFingerprint(): Fingerprint
  debounceMs?: number
}

function fpEqual(a: Fingerprint, b: Fingerprint): boolean {
  return a.count === b.count && a.maxVersion === b.maxVersion
}

export class PersistedIndexStore implements IndexStore {
  private index: InvertedIndex | undefined
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly debounceMs: number
  constructor(private readonly cb: PersistedIndexCallbacks) {
    this.debounceMs = cb.debounceMs ?? 1000
  }

  get built(): boolean { return this.index !== undefined }

  async ensureBuilt(build: () => ReadonlyArray<IndexDoc>): Promise<InvertedIndex> {
    if (this.index !== undefined) return this.index
    const loaded = await this.cb.load()
    if (loaded !== null && fpEqual(loaded.fingerprint, this.cb.currentFingerprint())) {
      this.index = deserializeIndex(loaded.json)
      return this.index
    }
    this.index = InvertedIndex.build(build())
    await this.persist() // immediate persist on a fresh build
    return this.index
  }

  markDirty(): void {
    this.index = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.flushBuilt() }, this.debounceMs)
  }

  /** Force an immediate persist (cancels any pending debounce). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.flushBuilt()
  }

  /** Delete the persisted blob and drop the in-memory index (forget/erasure). */
  async removePersisted(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.index = undefined
    await this.cb.remove()
  }

  // Persist the CURRENT in-memory index, if any. Used by debounce + flush.
  private async flushBuilt(): Promise<void> {
    if (this.index === undefined) return // dirty-with-no-rebuild-yet: next ensureBuilt persists
    await this.persist()
  }

  private async persist(): Promise<void> {
    if (this.index === undefined) return
    await this.cb.save(serializeIndex(this.index), this.cb.currentFingerprint())
  }
}
```

Note the debounce semantics matching the test: `markDirty` drops the in-memory index and schedules a flush; if a query rebuilds it before the timer fires, the flush persists the rebuilt index; if not, `flushBuilt` no-ops (the next `ensureBuilt` persists on rebuild). The test triggers a rebuild implicitly? — adjust: in the `markDirty debounces` test, after `markDirty` the index is dropped, so `flushBuilt` would no-op. To make the coalesced-flush assertion hold, `markDirty`'s debounced callback must rebuild then persist. Change the debounced callback to rebuild via a stored `build` thunk: capture the last `build` in `ensureBuilt` and reuse it in the debounce. Implement that:

Add a `private lastBuild?: () => ReadonlyArray<IndexDoc>`; set it in `ensureBuilt`; in `markDirty`'s timer call `void this.ensureBuilt(this.lastBuild!).then(() => this.persist())` (rebuild then persist). This yields the single coalesced save the test asserts. Update `flush()` similarly (rebuild-if-needed then persist).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/search-persisted-index-store.test.ts && npx tsc --noEmit` → PASS (4); clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/search/persisted-index-store.ts packages/hub/__tests__/search-persisted-index-store.test.ts
git commit -m "feat(search): PersistedIndexStore — debounced flush + fingerprint validation (#308 L1.5)"
```

---

## Task 4: Collection wiring — `textIndexPersist`, callbacks, `flushIndex()`

**Files:**
- Modify: `packages/hub/src/collection.ts` (options interface near `textIndexes`; construction ~926; new `flushIndex()` + private callback builder)
- Test: `packages/hub/__tests__/search-persist-integration.test.ts`

**Interfaces:**
- Consumes: `PersistedIndexStore`, `Fingerprint`, `PersistedIndexCallbacks` (`./search/persisted-index-store.js`); `MemoryIndexStore`; `encryptJsonString`/`decryptJsonString`/`adapter`/`cache`/`getDEK`.
- Produces (on `Collection`): option `textIndexPersist?: boolean`; public `flushIndex(): Promise<void>`; the index blob at adapter `(vault, '_ftindex', this.name)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-persist-integration.test.ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withI18n } from '../src/i18n/index.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

// paste the memory() helper verbatim from i18n-script-put.test.ts lines 12-48

interface Inv { id: string; description: string }

describe('persisted lexical index (#308 L1.5)', () => {
  it('cold-loads a persisted index without re-tokenizing, and keeps the store zero-knowledge', async () => {
    const store = memory()
    const puts: string[] = []
    const wrapped: NoydbStore = { ...store, async put(c, col, id, e, ev) { puts.push(`${col}/${id}`); return store.put(c, col, id, e, ev) } }

    // session 1 — build + persist
    const db1 = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-l15', i18nStrategy: withI18n() })
    const v1 = await db1.openVault('v')
    const c1 = v1.collection<Inv>('inv', { textIndexes: ['description'], textIndexPersist: true })
    await c1.put('a', { id: 'a', description: 'overdue invoice TCM' })
    await c1.flushIndex()
    expect(puts.some((p) => p.startsWith('_ftindex/'))).toBe(true) // an opaque index blob was written
    // the index blob is ciphertext (no plaintext term leaks)
    const blob = await wrapped.get('v', '_ftindex', 'inv')
    expect(JSON.stringify(blob)).not.toContain('invoice')

    // session 2 — fresh db over the SAME store: retrieve must work WITHOUT a rebuild
    const db2 = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-l15', i18nStrategy: withI18n() })
    const v2 = await db2.openVault('v')
    const c2 = v2.collection<Inv>('inv', { textIndexes: ['description'], textIndexPersist: true })
    const hits = await c2.retrieve('invoice')
    expect(hits.map((h) => h.id)).toEqual(['a'])
  })

  it('the index blob is NOT hydrated as a record', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw', i18nStrategy: withI18n() })
    const v = await db.openVault('v')
    const c = v.collection<Inv>('inv', { textIndexes: ['description'], textIndexPersist: true })
    await c.put('a', { id: 'a', description: 'invoice' })
    await c.flushIndex()
    expect((await c.toArray()).map((r) => r.id)).toEqual(['a']) // only the real record
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-persist-integration.test.ts` → FAIL (`textIndexPersist`/`flushIndex` missing).

- [ ] **Step 3: Add the option + construction + callbacks**

(a) Options interface (beside `textIndexes`/`warmIndexOnOpen`): add `textIndexPersist?: boolean | undefined`.

(b) Replace the construction at ~926:

```ts
    this.textIndexes = opts.textIndexes
    this.searchIndexStore =
      opts.textIndexes && opts.textIndexes.length > 0
        ? opts.textIndexPersist
          ? new PersistedIndexStore(this.buildPersistedIndexCallbacks())
          : new MemoryIndexStore()
        : undefined
```

(c) Add the callback builder + `flushIndex()` near the other search methods. The blob lives in the reserved `_ftindex` collection (id = this.name) so eager `loadAll` (which skips `_`-prefixed collection names) never hydrates it:

```ts
  private buildPersistedIndexCallbacks(): import('./search/persisted-index-store.js').PersistedIndexCallbacks {
    const FT = '_ftindex'
    return {
      load: async () => {
        const env = await this.adapter.get(this.vault, FT, this.name)
        if (!env) return null
        const json = await this.decryptJsonString(env)
        if (json === null) return null
        const fingerprint = { count: env._v, maxVersion: (env as { _ftMax?: number })._ftMax ?? env._v }
        return { json, fingerprint }
      },
      save: async (json, fp) => {
        const env = await this.encryptJsonString(json, fp.count)
        ;(env as { _ftMax?: number })._ftMax = fp.maxVersion
        await this.adapter.put(this.vault, FT, this.name, env)
      },
      remove: async () => { await this.adapter.delete(this.vault, FT, this.name) },
      currentFingerprint: () => {
        let maxVersion = 0
        for (const e of this.cache.values()) if (e.version > maxVersion) maxVersion = e.version
        return { count: this.cache.size, maxVersion }
      },
    }
  }

  /** #308 L1.5 — force-persist the lexical index now (e.g. on save/idle). No-op without textIndexPersist. */
  async flushIndex(): Promise<void> {
    await this.searchIndexStore?.flush()
  }
```

NOTE on the fingerprint encoding: the envelope's `_v` carries `count`; a sidecar `_ftMax` carries `maxVersion`. (Both are plaintext envelope metadata, not record content — no leakage.) If adding a non-standard `_ftMax` field to `EncryptedEnvelope` trips types, instead JSON-encode the fingerprint INTO the persisted body — wrap as `JSON.stringify({ fp, snapshot })` in `save` and parse in `load`. Prefer the body-wrap approach if `EncryptedEnvelope` is a closed type: it keeps the envelope standard. Implementer: check `EncryptedEnvelope` in `types.ts`; if it's a closed interface, use the body-wrap (`save(json,fp)` stores `JSON.stringify({fp, idx: json})`; `load` parses it back). Pick one and keep `load`/`save` consistent.

(d) Confirm `this.cache` entries expose `.version` (used in `currentFingerprint`); if the cache value shape differs (e.g. `{record, version}`), match it. Read the cache type before writing.

- [ ] **Step 4: Run tests + full suite**

Run: `cd packages/hub && npx vitest run __tests__/search-persist-integration.test.ts && npx vitest run && npx eslint src/search src/collection.ts && npx tsc --noEmit`
Expected: PASS; full suite green; lint/tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/collection.ts packages/hub/__tests__/search-persist-integration.test.ts
git commit -m "feat(search): textIndexPersist — persisted index blob + flushIndex() (#308 L1.5)"
```

---

## Task 5: `forget()` teardown + close-flush

**Files:**
- Modify: `packages/hub/src/collection.ts` (add `_purgeSearchIndex()`)
- Modify: `packages/hub/src/vault.ts` (`forget()` — call it per affected collection)
- Modify: `packages/hub/src/noydb.ts` (`close()` — fire-and-forget index flush)
- Test: `packages/hub/__tests__/search-persist-forget.test.ts`

**Interfaces:**
- Consumes: `PersistedIndexStore.removePersisted()`; the `forget()` loop's `collections: Set<string>`.
- Produces: `Collection._purgeSearchIndex(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/hub/__tests__/search-persist-forget.test.ts
// memory() helper + a forgetStrategy-configured vault (mirror an existing forget test —
// grep __tests__ for 'forget' / 'withForgetCascade' to copy the exact setup).
// Assert: after vault.forget(subject), the _ftindex blob for the affected collection
// is gone (adapter.get(vault,'_ftindex',coll) === null) AND a subsequent retrieve()
// rebuilds without the forgotten record's terms.
```
Implementer: locate an existing `forget()` test to copy the `forgetStrategy`/subject wiring, then write the concrete runnable assertions above (blob removed + rebuilt-without-forgotten-terms). Do not leave as prose.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/search-persist-forget.test.ts` → FAIL.

- [ ] **Step 3: Add `_purgeSearchIndex` to collection**

```ts
  /** #308 L1.5 — drop the persisted lexical-index blob (forget/erasure): an opaque
   *  all-records index must not survive crypto-shred. Idempotent; no-op without persist. */
  async _purgeSearchIndex(): Promise<void> {
    const store = this.searchIndexStore
    if (store && 'removePersisted' in store) await (store as { removePersisted(): Promise<void> }).removePersisted()
    else store?.markDirty()
  }
```

- [ ] **Step 4: Call it from `vault.forget()`**

In `vault.ts` `forget()`, after the per-ref loop (the `collections: Set<string>` is already accumulated), add:

```ts
    for (const collName of collections) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.collection(collName) as any)._purgeSearchIndex()
    }
```
(Place beside the existing `_purgePersistedIndexes` handling. Mirrors that pattern.)

- [ ] **Step 5: Fire-and-forget flush on `noydb.close()`**

`close()` is sync. In `packages/hub/src/noydb.ts` `close()`, before clearing `vaultCache`, add a best-effort flush of any persisted search indexes:

```ts
    for (const v of this.vaultCache.values()) void v._flushSearchIndexes()
```
Add `_flushSearchIndexes(): Promise<void>` to `vault.ts` iterating the vault's open collections and calling `flushIndex()` on each (fire-and-forget is fine — correctness is backstopped by the fingerprint). If the vault doesn't track open collections, skip this step and rely on debounce + `flushIndex()` (note it); the fingerprint guarantees no stale index is ever served.

- [ ] **Step 6: Run tests + full suite + commit**

Run: `cd packages/hub && npx vitest run __tests__/search-persist-forget.test.ts && npx vitest run && npx tsc --noEmit` → all green.

```bash
git add packages/hub/src/collection.ts packages/hub/src/vault.ts packages/hub/src/noydb.ts packages/hub/__tests__/search-persist-forget.test.ts
git commit -m "feat(search): forget() purges persisted index + close-flush (#308 L1.5)"
```

---

## Task 6: `RetrieveHit.rank` (federation-ready)

**Files:**
- Modify: `packages/hub/src/search/retrieve-types.ts` (`RetrieveHit`)
- Modify: `packages/hub/src/collection.ts` (`retrieve()` maps `rank`)
- Test: append to `packages/hub/__tests__/search-retrieve.test.ts`

**Interfaces:**
- Produces: `RetrieveHit<T>` gains `readonly rank: number` (1-based position in the returned, score-sorted list).

- [ ] **Step 1: Write the failing test** (append)

```ts
it('hits carry a 1-based rank monotonic with score order (#308 L1.5)', async () => {
  // build a collection where two records match with different scores;
  // assert hits[0].rank === 1, hits[1].rank === 2, and rank order matches score order.
  // (reuse the search-retrieve harness in this file.)
})
```
Implementer: write the concrete assertion using this file's existing harness (two records, one matching the query term more strongly), asserting `rank` is 1,2,… in the returned order.

- [ ] **Step 2-4: Fail → implement → pass**

Add `readonly rank: number` to `RetrieveHit<T>` in `retrieve-types.ts`. In `collection.ts` `retrieve()`, where hits are mapped to `RetrieveHit`, add `rank: i + 1` using the array index (the list is already score-sorted by `index.query`). Run `npx vitest run __tests__/search-retrieve.test.ts && npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/search/retrieve-types.ts packages/hub/src/collection.ts packages/hub/__tests__/search-retrieve.test.ts
git commit -m "feat(search): RetrieveHit.rank for cross-vault/hybrid fusion (#308 L1.5)"
```

---

## Task 7: Docs, features.yaml, showcase, ceiling, final gate

**Files:** `docs/subsystems/search.md`, `features.yaml`, `showcases/src/<next>-…`, `scripts/check-architecture.mjs`

- [ ] **Step 1: Subsystem doc** — add to `docs/subsystems/search.md`: `textIndexPersist` (opaque `_ftindex` blob, collection DEK, fingerprint `{count,maxVersion}`, debounced flush + `flushIndex()` + close-flush, `forget()` teardown); note `RetrieveHit.rank` and the L1.5 line of the epic map. Commit `docs(search): document persisted index + rank (#308 L1.5)`.
- [ ] **Step 2: features.yaml** — extend the `search-index` node (still `preview`/`experimental`) with the persistence capability + spec ref `docs/superpowers/specs/2026-06-22-ai-retrieval-l1.5-persisted-index-design.md`; run `node scripts/validate-features.mjs`. Commit `chore(features): register persisted index (#308 L1.5)`.
- [ ] **Step 3: Showcase** — add/extend a showcase: persist (session 1) → fresh db over the same store (session 2) → `retrieve()` warm-loads (no rebuild). Build hub first (`cd packages/hub && npx tsup`), run it. Commit `docs(showcase): persisted-index warm load (#308 L1.5)`.
- [ ] **Step 4: Ceiling + final gate** —
```bash
cd packages/hub && npx tsup && npx vitest run && npx eslint src && npx tsc --noEmit
cd /Users/vicio/_github/noy-db && node scripts/check-architecture.mjs && node scripts/validate-features.mjs
```
If `collection.ts`/`vault.ts` exceed their ceilings in `scripts/check-architecture.mjs`, raise each to `wc -l` + ~10 with a one-line `// Bumped …→… (#308 L1.5): …` comment. Re-run until green. Commit any bump `chore(arch): raise ceilings for persisted index (#308 L1.5)`.

---

## Self-Review

**1. Spec coverage:** serialize/deserialize → T1 ✓; async `ensureBuilt`+`flush` → T2 ✓; `PersistedIndexStore` (debounce, fingerprint, removePersisted) → T3 ✓; `textIndexPersist` + opaque `_ftindex` blob under collection DEK + `flushIndex()` + zero-leakage + not-hydrated-as-record → T4 ✓; fingerprint `{count,maxVersion}` cross-session staleness → T3/T4 ✓; `forget()` teardown + close-flush → T5 ✓; `RetrieveHit.rank` federation-ready → T6 ✓; docs/features/showcase/ceiling → T7 ✓. Deferred per spec (incremental flush, sharding, `fuseRetrieval`→L3, `lobby.retrieve`→klum) — correctly absent.

**2. Placeholder scan:** T5 Step 1 and T6 Step 1 instruct the implementer to copy an existing harness then write concrete asserts (the forget/retrieve harnesses must be read from the repo) — "locate then write runnable test", not a code placeholder. T4 Step 3 flags a real type decision (`_ftMax` envelope field vs body-wrap the fingerprint) with a concrete rule (body-wrap if `EncryptedEnvelope` is closed). T3 Step 3 notes the debounce-rebuild refinement explicitly. No "TBD"/"handle errors"/bare "similar to".

**3. Type consistency:** `IndexStore.ensureBuilt`/`flush` (T2) used in T3's `implements` and T4's call sites. `Fingerprint {count,maxVersion}` and `PersistedIndexCallbacks` (T3) consumed verbatim in T4's `buildPersistedIndexCallbacks`. `_ftindex` collection + id=`this.name` consistent across T4 (save/load/remove) and T5 (purge via `removePersisted`). `RetrieveHit.rank` (T6) is additive. `removePersisted` defined in T3, called in T5.
