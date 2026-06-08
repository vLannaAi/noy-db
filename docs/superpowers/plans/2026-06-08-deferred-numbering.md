# Deferred Numbering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `withDeferredNumbering` — gap-free serial numbering for non-CAS-but-strong-read stores, assigning serials by a deterministic sort over each record's **store commit time** (a bounded-uncertainty interval) at an explicit numbering pass, exposed through the unified async `vault.sequence(series).next({ for })`.

**Architecture:** A new `StoreTime` interval + `getStoreTime?()` store method (the "store clock"), a `serverWriteTime` capability, and a `DeferredNumberingStore` engine that (1) stamps a pending entry with `getStoreTime()` on enqueue, (2) at a numbering pass selects entries provably settled (`storeLatest ≤ now.earliest` — commit-wait), sorts them by `(storeEarliest, recordId)`, assigns serials after the series head, stamps the user records, and advances the head with one CAS. `next({ for })` returns a Promise resolved by the pass (durable record field is the source of truth; the Promise is an in-process convenience). All provable on `to-memory`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest. Mirrors the existing `packages/hub/src/sequence/index.ts` (`SequenceStore`) construction + reserved-collection + optimistic-CAS pattern.

**Spec:** `docs/superpowers/specs/2026-06-08-sealed-numbering-and-store-clock-design.md`

**Explicitly deferred (separate slices, NOT in this plan):** auto-timer passes (this MVP triggers passes explicitly via `vault.runNumberingPass`); cross-instance Promise resolution by polling (MVP resolves in-process; the durable field already works cross-instance on reload); `to-file` mtime / `to-aws-s3` Last-Modified clock sources (MVP implements the clock on `to-memory` only); the `singleWriter` opt-in on CAS `next()`; per-series allocation; HLC.

---

## File Structure

- **Modify** `packages/hub/src/types.ts` — add `StoreTime`, `NoydbStore.getStoreTime?()`, `StoreCapabilities.serverWriteTime?`.
- **Modify** `packages/to-memory/src/index.ts` — implement `getStoreTime()` (monotonic clock + uncertainty option) + `serverWriteTime: true`.
- **Modify** `packages/hub/src/errors.ts` — add `NumberingUncertaintyError`.
- **Create** `packages/hub/src/numbering/descriptor.ts` — `withDeferredNumbering()` config descriptor + types.
- **Create** `packages/hub/src/numbering/index.ts` — `DeferredNumberingStore` engine (enqueue, runPass, promise registry).
- **Modify** `packages/hub/src/vault.ts` — wire configs, `sequence(series).next(opts)` routing, `runNumberingPass(series)`.
- **Modify** `packages/hub/src/noydb.ts` — thread `numbering` option from `createNoydb` to the vault.
- **Modify** `packages/hub/src/sequence/index.ts` — widen `SequenceHandle.next` signature to accept the optional `{ for, timeoutMs }` opts (CAS path ignores them).
- **Modify** `packages/hub/src/index.ts` — export `withDeferredNumbering`, `StoreTime`, `NumberingUncertaintyError`.
- **Create** `packages/hub/__tests__/numbering/deferred.test.ts` — all engine + wiring tests.
- **Create** `packages/to-memory/__tests__/store-time.test.ts` — store-clock tests.
- **Modify** `features.yaml` — register the capability.

---

## Task 1: `StoreTime` interval + store-clock surface

**Files:**
- Modify: `packages/hub/src/types.ts`

- [ ] **Step 1: Add the type, store method, and capability**

In `packages/hub/src/types.ts`, add the `StoreTime` interface near `StoreCapabilities` (search for `export interface StoreCapabilities`), add `serverWriteTime?` to `StoreCapabilities`, and add `getStoreTime?()` to the `NoydbStore` interface (search for `export interface NoydbStore`).

```ts
/**
 * The store's authoritative clock as a bounded-uncertainty interval
 * (Spanner TrueTime model). True time is provably within [earliest, latest];
 * `latest - earliest` is the clock-uncertainty bound ε. Used by deferred
 * numbering to order records by store-commit-time and to commit-wait. Never
 * the client wall clock.
 */
export interface StoreTime {
  readonly earliest: number
  readonly latest: number
}
```

Add to `StoreCapabilities` (after `casAtomic`):

```ts
  /**
   * true — the store exposes an authoritative {@link NoydbStore.getStoreTime}
   * clock and records are ordered by store-commit-time. Required for
   * `withDeferredNumbering`. Absent/false — the store cannot back deferred
   * numbering (use CAS `sequence().next()` or per-series).
   */
  serverWriteTime?: boolean
```

Add to `NoydbStore` (after `ping?`):

```ts
  /**
   * The store's authoritative time as a bounded-uncertainty interval.
   * Present iff `capabilities.serverWriteTime` is true. Monotonic
   * non-decreasing across calls on a single store.
   */
  getStoreTime?(): Promise<StoreTime>
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx tsc --noEmit`
Expected: PASS (additive optional members).

- [ ] **Step 3: Commit**

```bash
cd /Users/vicio/_github/noy-db
git add packages/hub/src/types.ts
git commit -m "feat(numbering): StoreTime interval + getStoreTime + serverWriteTime capability"
```

---

## Task 2: `to-memory` store clock

**Files:**
- Modify: `packages/to-memory/src/index.ts`
- Test: `packages/to-memory/__tests__/store-time.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

Create `packages/to-memory/__tests__/store-time.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { memory } from '../src/index.js'

describe('memory() store clock', () => {
  it('advertises serverWriteTime and returns a monotonic non-decreasing interval', async () => {
    const s = memory()
    expect(s.capabilities?.serverWriteTime).toBe(true)
    const a = await s.getStoreTime!()
    const b = await s.getStoreTime!()
    expect(a.earliest).toBeLessThanOrEqual(a.latest)
    expect(b.earliest).toBeGreaterThanOrEqual(a.earliest) // monotonic
  })

  it('widens the interval by the configured uncertainty', async () => {
    const s = memory({ clockUncertainty: 5 })
    const t = await s.getStoreTime!()
    expect(t.latest - t.earliest).toBe(10) // ±5
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vicio/_github/noy-db && npx vitest run packages/to-memory/__tests__/store-time.test.ts`
Expected: FAIL — `getStoreTime` undefined / `memory` takes no options.

- [ ] **Step 3: Implement the clock**

In `packages/to-memory/src/index.ts`, change the factory signature and add the clock. First the signature (search for `export function memory(): NoydbStore`):

```ts
export function memory(opts: { clockUncertainty?: number } = {}): NoydbStore {
```

Add a monotonic counter near the top of the function body (after the `store` Map):

```ts
  // Monotonic store clock — a single-process counter is perfectly ordered.
  // `clockUncertainty` (ε) widens the returned interval to exercise the
  // commit-wait path in deferred numbering; default 0 (exact).
  const epsilon = opts.clockUncertainty ?? 0
  let clock = 0
```

In the returned object, add `serverWriteTime: true` to `capabilities` and add the method (place `getStoreTime` after `ping`):

```ts
    capabilities: {
      casAtomic: true,
      serverWriteTime: true,
      auth: { kind: 'none', required: false, flow: 'static' },
    },
```

```ts
    async getStoreTime() {
      const now = ++clock
      return { earliest: now - epsilon, latest: now + epsilon }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vicio/_github/noy-db && npx vitest run packages/to-memory/__tests__/store-time.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db
git add packages/to-memory/src/index.ts packages/to-memory/__tests__/store-time.test.ts
git commit -m "feat(to-memory): monotonic store clock (getStoreTime) + serverWriteTime"
```

---

## Task 3: `NumberingUncertaintyError` + `withDeferredNumbering` descriptor

**Files:**
- Modify: `packages/hub/src/errors.ts`
- Create: `packages/hub/src/numbering/descriptor.ts`
- Test: `packages/hub/__tests__/numbering/deferred.test.ts` (NEW)

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/numbering/deferred.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { withDeferredNumbering } from '../../src/numbering/descriptor.js'
import { NumberingUncertaintyError } from '../../src/errors.js'

describe('withDeferredNumbering descriptor', () => {
  it('captures the series config with defaults', () => {
    const d = withDeferredNumbering({ series: 'invoices', collection: 'sales', field: 'fiscalNumber' })
    expect(d.series).toBe('invoices')
    expect(d.collection).toBe('sales')
    expect(d.field).toBe('fiscalNumber')
    expect(d.settleWindowMs).toBe(0) // default: interval commit-wait governs settling
  })
})

describe('NumberingUncertaintyError', () => {
  it('carries the series', () => {
    const e = new NumberingUncertaintyError('invoices')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('NumberingUncertaintyError')
    expect(e.message).toContain('invoices')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/numbering/deferred.test.ts -t descriptor`
Expected: FAIL — modules/exports missing.

- [ ] **Step 3: Add the error**

In `packages/hub/src/errors.ts`, after `SequenceOfflineError` (search for `class SequenceOfflineError`), add — matching that file's `NoydbError` subclass convention (check whether siblings use a two-arg `super('CODE', message)`; `SequenceOfflineError` is the closest sibling, mirror its exact shape):

```ts
/** Thrown by a deferred-numbering pass when the store clock is unavailable or its uncertainty cannot be resolved. */
export class NumberingUncertaintyError extends NoydbError {
  readonly series: string
  constructor(series: string) {
    super(
      'NUMBERING_UNCERTAINTY',
      `Deferred numbering for series "${series}" cannot run: the store does not expose getStoreTime() ` +
        `(capabilities.serverWriteTime). Use a CAS sequence or a store with serverWriteTime.`,
    )
    this.name = 'NumberingUncertaintyError'
    this.series = series
  }
}
```

(If `SequenceOfflineError` uses a one-arg `super(message)` instead, match that form and drop the code arg.)

- [ ] **Step 4: Create the descriptor**

Create `packages/hub/src/numbering/descriptor.ts`:

```ts
/**
 * @category capability
 * Deferred-numbering config descriptor. See
 * docs/superpowers/specs/2026-06-08-sealed-numbering-and-store-clock-design.md.
 */

/** A registered deferred-numbering series. */
export interface DeferredNumberingConfig {
  /** Series name — the key passed to `vault.sequence(series)`. */
  readonly series: string
  /** Collection holding the records to number. */
  readonly collection: string
  /** Field on each record where the assigned serial is written. */
  readonly field: string
  /**
   * Minimum wall-clock age (ms) before an entry is eligible at a pass, in
   * addition to the interval commit-wait. Default 0 — the store-clock
   * interval (`storeLatest ≤ now.earliest`) is the correctness mechanism.
   */
  readonly settleWindowMs: number
}

/** Declare a deferred-numbering series. Pass the result in `createNoydb({ numbering: [...] })`. */
export function withDeferredNumbering(config: {
  series: string
  collection: string
  field: string
  settleWindowMs?: number
}): DeferredNumberingConfig {
  return {
    series: config.series,
    collection: config.collection,
    field: config.field,
    settleWindowMs: config.settleWindowMs ?? 0,
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/numbering/deferred.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests), tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/vicio/_github/noy-db
git add packages/hub/src/errors.ts packages/hub/src/numbering/descriptor.ts packages/hub/__tests__/numbering/deferred.test.ts
git commit -m "feat(numbering): withDeferredNumbering descriptor + NumberingUncertaintyError"
```

---

## Task 4: `DeferredNumberingStore.enqueue` — stamp a pending entry

**Files:**
- Create: `packages/hub/src/numbering/index.ts`
- Test: `packages/hub/__tests__/numbering/deferred.test.ts` (APPEND)

- [ ] **Step 1: Write the failing test**

Append (reuse the `memory()` store from `@noy-db/to-memory` via the hub's existing test pattern — the engine is constructed directly with adapter-level deps, mirroring how `sequence.test.ts` builds a `SequenceStore`; copy the small `memory()` helper from `packages/hub/__tests__/sequence.test.ts` which already includes `capabilities`):

```ts
import { DeferredNumberingStore } from '../../src/numbering/index.js'
import { ConflictError } from '../../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/types.js'

// In-memory store with a monotonic clock — the engine's full backend under test.
// (Same shape as the helper in sequence.test.ts, plus getStoreTime + serverWriteTime.)
function clockStore(epsilon = 0): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  let clock = 0
  return {
    name: 'clock-memory',
    capabilities: { casAtomic: true, serverWriteTime: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env, ev) {
      const ex = data.get(k(v, c, i))
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      data.set(k(v, c, i), env)
    },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: VaultSnapshot = {}
      for (const [key, env] of data) {
        const [vn, cn, id] = key.split('/')
        if (vn === v && !cn.startsWith('_')) { out[cn] = out[cn] ?? {}; out[cn][id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) for (const i of Object.keys(payload[c])) data.set(k(v, c, i), payload[c][i])
    },
    async getStoreTime() { const n = ++clock; return { earliest: n - epsilon, latest: n + epsilon } },
  }
}

// Engine + a Map-backed `stamp` double that records assignments (and lets a
// test simulate a "record gone" by pre-marking an id as missing).
function engine(store: NoydbStore, missing = new Set<string>()) {
  const stamped = new Map<string, number>()
  const eng = new DeferredNumberingStore({
    adapter: store,
    vault: 'v',
    encrypted: false,
    getDEK: async () => { throw new Error('unencrypted') },
    actor: 'op',
    configs: new Map([['invoices', { series: 'invoices', collection: 'sales', field: 'fiscalNumber', settleWindowMs: 0 }]]),
    stamp: async (_collection, recordId, _field, serial) => {
      if (missing.has(recordId)) return false
      stamped.set(recordId, serial)
      return true
    },
  })
  return { eng, stamped }
}

describe('DeferredNumberingStore.enqueue', () => {
  it('writes a pending entry stamped with the store clock', async () => {
    const store = clockStore()
    const { eng } = engine(store)
    await eng.enqueue('invoices', 'r1')
    const env = await store.get('v', '_numbering_pending', 'invoices::r1')
    expect(env).not.toBeNull()
    const entry = JSON.parse(env!._data)
    expect(entry.recordId).toBe('r1')
    expect(entry.storeLatest).toBeGreaterThanOrEqual(entry.storeEarliest)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/numbering/deferred.test.ts -t enqueue`
Expected: FAIL — `DeferredNumberingStore` not found.

- [ ] **Step 3: Implement the engine skeleton + enqueue**

Create `packages/hub/src/numbering/index.ts` (mirror `sequence/index.ts` for the encrypted read/write helpers):

```ts
/**
 * @category capability
 * Deferred numbering engine — store-clock-ordered, gap-free serials assigned
 * at an explicit numbering pass. See the design spec.
 */
import type { NoydbStore, EncryptedEnvelope, StoreTime } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'
import { encrypt, decrypt } from '../crypto.js'
import { ConflictError, NumberingUncertaintyError } from '../errors.js'
import type { DeferredNumberingConfig } from './descriptor.js'

export const NUMBERING_HEAD_COLLECTION = '_numbering_head'
export const NUMBERING_PENDING_COLLECTION = '_numbering_pending'

interface PendingEntry {
  series: string
  recordId: string
  collection: string
  field: string
  storeEarliest: number
  storeLatest: number
  enqueuedAt: number
}
interface NumberingHead { series: string; lastSerial: number; watermark: number }
export interface Assignment { recordId: string; serial: number }

type PendingPromise = { resolve: (n: number) => void; reject: (e: Error) => void }

export class DeferredNumberingStore {
  private readonly adapter: NoydbStore
  private readonly vault: string
  private readonly encrypted: boolean
  private readonly getDEK: (collectionName: string) => Promise<CryptoKey>
  private readonly actor: string
  private readonly configs: Map<string, DeferredNumberingConfig>
  /**
   * Stamp a serial onto a USER record THROUGH the Collection layer (so the
   * cache, indexes, and MVs stay coherent — the engine must NOT write user
   * collections at the raw adapter level). Returns false if the record is
   * gone (the engine then skips it without burning a serial). Provided by the
   * vault; unit tests pass a Map-backed double.
   */
  private readonly stamp: (collection: string, recordId: string, field: string, serial: number) => Promise<boolean>
  /** In-process registry: `${series}::${recordId}` → resolver for the live next() Promise. */
  private readonly waiters = new Map<string, PendingPromise>()
  private readonly dekCache = new Map<string, Promise<CryptoKey>>()

  constructor(opts: {
    adapter: NoydbStore
    vault: string
    encrypted: boolean
    getDEK: (collectionName: string) => Promise<CryptoKey>
    actor: string
    configs: Map<string, DeferredNumberingConfig>
    stamp: (collection: string, recordId: string, field: string, serial: number) => Promise<boolean>
  }) {
    this.adapter = opts.adapter
    this.vault = opts.vault
    this.encrypted = opts.encrypted
    this.getDEK = opts.getDEK
    this.actor = opts.actor
    this.configs = opts.configs
    this.stamp = opts.stamp
  }

  has(series: string): boolean {
    return this.configs.has(series)
  }

  private dek(collection: string): Promise<CryptoKey> {
    let p = this.dekCache.get(collection)
    if (!p) { p = this.getDEK(collection); this.dekCache.set(collection, p) }
    return p
  }

  private async readJson<T>(collection: string, id: string): Promise<{ env: EncryptedEnvelope | null; value: T | null }> {
    const env = await this.adapter.get(this.vault, collection, id)
    if (!env) return { env: null, value: null }
    const json = this.encrypted ? await decrypt(env._iv, env._data, await this.dek(collection)) : env._data
    return { env, value: JSON.parse(json) as T }
  }

  private async writeJson(collection: string, id: string, value: unknown, expectedVersion: number): Promise<void> {
    const json = JSON.stringify(value)
    let env: EncryptedEnvelope
    if (!this.encrypted) {
      env = { _noydb: NOYDB_FORMAT_VERSION, _v: expectedVersion + 1, _ts: new Date().toISOString(), _iv: '', _data: json, _by: this.actor }
    } else {
      const { iv, data } = await encrypt(json, await this.dek(collection))
      env = { _noydb: NOYDB_FORMAT_VERSION, _v: expectedVersion + 1, _ts: new Date().toISOString(), _iv: iv, _data: data, _by: this.actor }
    }
    await this.adapter.put(this.vault, collection, id, env, expectedVersion)
  }

  private pendingId(series: string, recordId: string): string {
    return `${series}::${recordId}`
  }

  /**
   * Enqueue a record for numbering: stamp it with the current store clock and
   * write a pending entry. Returns a Promise that resolves with the assigned
   * serial at the next pass (the record's `field` is the durable source of
   * truth; this Promise is an in-process convenience).
   */
  async enqueue(series: string, recordId: string): Promise<number> {
    const cfg = this.configs.get(series)
    if (!cfg) throw new NumberingUncertaintyError(series)
    if (typeof this.adapter.getStoreTime !== 'function') throw new NumberingUncertaintyError(series)
    const st: StoreTime = await this.adapter.getStoreTime()
    const id = this.pendingId(series, recordId)
    const { env } = await this.readJson<PendingEntry>(NUMBERING_PENDING_COLLECTION, id)
    const entry: PendingEntry = {
      series, recordId, collection: cfg.collection, field: cfg.field,
      storeEarliest: st.earliest, storeLatest: st.latest, enqueuedAt: Date.now(),
    }
    await this.writeJson(NUMBERING_PENDING_COLLECTION, id, entry, env?._v ?? 0)
    return new Promise<number>((resolve, reject) => { this.waiters.set(id, { resolve, reject }) })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/numbering/deferred.test.ts -t enqueue`
Expected: PASS. NOTE: replace the `clockStore()` placeholder in the test with the real helper (copy `memory()` from `sequence.test.ts`, add `serverWriteTime` + `getStoreTime`). The `enqueue` Promise is not awaited here (it resolves only at a pass) — the test inspects the durable pending entry, not the Promise.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db
git add packages/hub/src/numbering/index.ts packages/hub/__tests__/numbering/deferred.test.ts
git commit -m "feat(numbering): DeferredNumberingStore.enqueue — store-clock-stamped pending entries"
```

---

## Task 5: `runPass` — commit-wait, deterministic sort, assign, CAS head

**Files:**
- Modify: `packages/hub/src/numbering/index.ts`
- Test: `packages/hub/__tests__/numbering/deferred.test.ts` (APPEND)

- [ ] **Step 1: Write the failing test**

Append (the engine needs to read pending entries; add a `listPending` via `adapter.list`. Seed user records first so the pass can stamp them):

```ts
describe('DeferredNumberingStore.runPass', () => {
  it('assigns gap-free serials in store-time order and stamps the records', async () => {
    const store = clockStore()
    const { eng, stamped } = engine(store)
    for (const id of ['r1', 'r2', 'r3']) await eng.enqueue('invoices', id)

    const assignments = await eng.runPass('invoices')
    expect(assignments.map(a => a.serial)).toEqual([1, 2, 3])
    expect(assignments.map(a => a.recordId)).toEqual(['r1', 'r2', 'r3']) // store-time order (monotonic clock)
    expect(stamped.get('r2')).toBe(2)                                    // record stamped via the Collection layer
    expect(await store.get('v', '_numbering_pending', 'invoices::r2')).toBeNull() // pending entry consumed
  })

  it('a second pass continues numbering after the head (gap-free across passes)', async () => {
    const store = clockStore()
    const { eng } = engine(store)
    await eng.enqueue('invoices', 'a')
    await eng.runPass('invoices') // a = 1
    await eng.enqueue('invoices', 'b')
    expect(await eng.runPass('invoices')).toEqual([{ recordId: 'b', serial: 2 }])
  })

  it('resolves the enqueue() Promise with the assigned serial', async () => {
    const store = clockStore()
    const { eng } = engine(store)
    const p = eng.enqueue('invoices', 'r1')
    await eng.runPass('invoices')
    await expect(p).resolves.toBe(1)
  })

  it('skips a record that is gone without burning a serial', async () => {
    const store = clockStore()
    const { eng, stamped } = engine(store, new Set(['gone']))
    await eng.enqueue('invoices', 'gone') // store-time 1 — sorts first
    await eng.enqueue('invoices', 'r1')   // store-time 2
    const assignments = await eng.runPass('invoices')
    expect(assignments).toEqual([{ recordId: 'r1', serial: 1 }]) // 'gone' skipped; r1 still gets 1
    expect(stamped.has('gone')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/numbering/deferred.test.ts -t runPass`
Expected: FAIL — `runPass` not found.

- [ ] **Step 3: Implement `runPass`**

Add to `DeferredNumberingStore`:

```ts
  private async listPending(series: string): Promise<Array<{ id: string; entry: PendingEntry }>> {
    const ids = await this.adapter.list(this.vault, NUMBERING_PENDING_COLLECTION)
    const prefix = `${series}::`
    const out: Array<{ id: string; entry: PendingEntry }> = []
    for (const id of ids) {
      if (!id.startsWith(prefix)) continue
      const { value } = await this.readJson<PendingEntry>(NUMBERING_PENDING_COLLECTION, id)
      if (value) out.push({ id, entry: value })
    }
    return out
  }

  /**
   * Run a numbering pass for `series`: select entries provably settled
   * (`storeLatest ≤ now.earliest` — commit-wait), order by
   * `(storeEarliest, recordId)`, assign serials after the head, stamp each
   * record's field, advance the head with one CAS, and consume the entries.
   * Idempotent/convergent: re-running with the same settled set is a no-op
   * (entries already consumed). Resolves any in-process enqueue() Promises.
   */
  async runPass(series: string): Promise<Assignment[]> {
    const cfg = this.configs.get(series)
    if (!cfg) throw new NumberingUncertaintyError(series)
    if (typeof this.adapter.getStoreTime !== 'function') throw new NumberingUncertaintyError(series)

    const now = await this.adapter.getStoreTime()
    const settled = (await this.listPending(series))
      .filter(p => p.entry.storeLatest <= now.earliest) // commit-wait
      .sort((a, b) =>
        a.entry.storeEarliest - b.entry.storeEarliest ||
        (a.entry.recordId < b.entry.recordId ? -1 : a.entry.recordId > b.entry.recordId ? 1 : 0),
      )
    if (settled.length === 0) return []

    const { env: headEnv, value: head } = await this.readJson<NumberingHead>(NUMBERING_HEAD_COLLECTION, series)
    let serial = head?.lastSerial ?? 0
    const assignments: Assignment[] = []

    // Stamp each user record THROUGH the Collection layer (cache-coherent).
    for (const { entry } of settled) {
      serial += 1
      const ok = await this.stamp(entry.collection, entry.recordId, entry.field, serial)
      if (!ok) { serial -= 1; continue } // record gone — skip, do not burn a number
      assignments.push({ recordId: entry.recordId, serial })
    }

    // Advance the head with one CAS. On conflict another pass ran; bail — the
    // next pass reconciles (idempotent: consumed entries won't reappear).
    try {
      await this.writeJson(NUMBERING_HEAD_COLLECTION, series, { series, lastSerial: serial, watermark: now.earliest }, headEnv?._v ?? 0)
    } catch (err) {
      if (err instanceof ConflictError) return []
      throw err
    }

    // Consume pending entries + resolve in-process waiters.
    for (const { id, entry } of settled) {
      await this.adapter.delete(this.vault, NUMBERING_PENDING_COLLECTION, id)
      const a = assignments.find(x => x.recordId === entry.recordId)
      if (a) { this.waiters.get(id)?.resolve(a.serial); this.waiters.delete(id) }
    }
    return assignments
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/numbering/deferred.test.ts -t runPass && npx tsc --noEmit`
Expected: PASS (3 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db
git add packages/hub/src/numbering/index.ts packages/hub/__tests__/numbering/deferred.test.ts
git commit -m "feat(numbering): runPass — commit-wait, deterministic order, CAS-advanced head"
```

---

## Task 6: Append-only stability + commit-wait (the correctness properties)

**Files:**
- Test: `packages/hub/__tests__/numbering/deferred.test.ts` (APPEND)

- [ ] **Step 1: Write the test**

Append (these assert the two properties the design hinges on — no test-driven code change expected; if they fail, the bug is in Task 5):

```ts
describe('deferred numbering — correctness properties', () => {
  it('a record enqueued after a pass cannot renumber already-issued records (append-only)', async () => {
    const store = clockStore()
    const { eng, stamped } = engine(store)
    await eng.enqueue('invoices', 'r1')
    await eng.runPass('invoices')            // r1 = 1, head watermark advanced
    // r2 is stamped with a LATER store time (monotonic clock) → it can only append
    await eng.enqueue('invoices', 'r2')
    expect(await eng.runPass('invoices')).toEqual([{ recordId: 'r2', serial: 2 }])
    expect(stamped.get('r1')).toBe(1) // r1 never re-stamped
  })

  it('an entry whose interval has not settled is held for a later pass (commit-wait)', async () => {
    const store = clockStore(100) // ε = 100 → storeLatest = clock + 100, far ahead of now.earliest
    const { eng } = engine(store)
    await eng.enqueue('invoices', 'r1')
    // now.earliest = clock - 100; r1.storeLatest = (its clock) + 100 — not yet ≤ now.earliest
    expect(await eng.runPass('invoices')).toEqual([]) // held, not numbered
  })

  it('throws NumberingUncertaintyError when the store has no clock', async () => {
    const noClock = clockStore()
    delete (noClock as { getStoreTime?: unknown }).getStoreTime
    const { eng } = engine(noClock)
    await expect(eng.runPass('invoices')).rejects.toBeInstanceOf(NumberingUncertaintyError)
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/numbering/deferred.test.ts -t "correctness properties"`
Expected: PASS (3 tests). If the commit-wait test fails, verify the `storeLatest ≤ now.earliest` filter and that `clockStore(100)` widens the interval.

- [ ] **Step 3: Commit**

```bash
cd /Users/vicio/_github/noy-db
git add packages/hub/__tests__/numbering/deferred.test.ts
git commit -m "test(numbering): append-only stability + commit-wait + clock-unavailable fail-closed"
```

---

## Task 7: Vault wiring — config registration, routed `next({ for })`, `runNumberingPass`

**Files:**
- Modify: `packages/hub/src/sequence/index.ts` (widen `SequenceHandle.next` signature)
- Modify: `packages/hub/src/vault.ts`
- Modify: `packages/hub/src/noydb.ts`
- Test: `packages/hub/__tests__/numbering/deferred.test.ts` (APPEND)

- [ ] **Step 1: Write the failing test**

Append (full integration through `createNoydb`):

```ts
import { createNoydb } from '../../src/index.js'
import { withDeferredNumbering } from '../../src/numbering/descriptor.js'
// `clockStore` reused; createNoydb accepts it as `store`.

describe('vault deferred-numbering integration', () => {
  it('next({ for }) on a deferred series resolves at runNumberingPass', async () => {
    const db = await createNoydb({
      store: clockStore(), user: 'op', encrypt: false,
      numbering: [withDeferredNumbering({ series: 'invoices', collection: 'sales', field: 'fiscalNumber' })],
    })
    const v = await db.openVault('v')
    const sales = v.collection<{ id: string; amount: number; fiscalNumber?: number }>('sales')
    await sales.put('r1', { id: 'r1', amount: 100 })

    const pending = v.sequence('invoices').next({ for: 'r1' }) // Promise<number>, not yet resolved
    await v.runNumberingPass('invoices')
    await expect(pending).resolves.toBe(1)
    expect((await sales.get('r1'))!.fiscalNumber).toBe(1)
  })

  it('next() without a deferred config still uses the CAS counter', async () => {
    const db = await createNoydb({ store: clockStore(), user: 'op', encrypt: false })
    const v = await db.openVault('v')
    expect(await v.sequence('plain').next()).toBe(1)
    expect(await v.sequence('plain').next()).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/numbering/deferred.test.ts -t "vault deferred"`
Expected: FAIL — `numbering` option / `runNumberingPass` / `next({for})` missing.

- [ ] **Step 3a: Widen `SequenceHandle.next`**

In `packages/hub/src/sequence/index.ts`, change the `SequenceHandle` interface and the `handle()` factory so `next` accepts optional opts (the CAS path ignores them):

```ts
export interface NextOptions {
  /** Deferred mode: the record id to number. Ignored by the CAS counter. */
  readonly for?: string
  /** Deferred mode: reject the Promise after this many ms if still unsealed. */
  readonly timeoutMs?: number
}

export interface SequenceHandle {
  next(opts?: NextOptions): Promise<number>
  peek(): Promise<number>
}
```

In `handle(name)`, change `next: () => this.next(name)` to `next: (_opts?: NextOptions) => this.next(name)` (CAS ignores opts).

- [ ] **Step 3b: Thread the `numbering` option through `noydb.ts`**

In `packages/hub/src/noydb.ts`: add `numbering?: DeferredNumberingConfig[]` to `NoydbOptions` consumption and pass it into the `Vault` constructor wherever vaults are built (search for `new Vault(` / the comp construction; there are ~3 sites — pass `numberingConfigs: this.options.numbering ?? []` alongside `guardStrategies`). Add the import:

```ts
import type { DeferredNumberingConfig } from './numbering/descriptor.js'
```

Add `numbering?: ReadonlyArray<DeferredNumberingConfig>` to the `NoydbOptions` interface in `packages/hub/src/types.ts` (next to `guardStrategies`).

- [ ] **Step 3c: Wire the engine + methods in `vault.ts`**

In `packages/hub/src/vault.ts`:

Add the import and a lazy field (near the `sequenceStore` field at line ~278):

```ts
import { DeferredNumberingStore } from './numbering/index.js'
import type { DeferredNumberingConfig } from './numbering/descriptor.js'
```

```ts
  private deferredNumbering: DeferredNumberingStore | null = null
  private readonly numberingConfigs: Map<string, DeferredNumberingConfig>
```

In the `Vault` constructor accept and store the configs (add `numberingConfigs?: ReadonlyArray<DeferredNumberingConfig>` to its opts and `this.numberingConfigs = new Map((opts.numberingConfigs ?? []).map(c => [c.series, c]))`).

Add a lazy getter and route `sequence().next`:

```ts
  private deferred(): DeferredNumberingStore {
    if (!this.deferredNumbering) {
      this.deferredNumbering = new DeferredNumberingStore({
        adapter: this.adapter, vault: this.name, encrypted: this.encrypted,
        getDEK: this.getDEK, actor: this.keyring.userId, configs: this.numberingConfigs,
        // Stamp THROUGH the Collection layer so cache/indexes/MVs stay coherent.
        // `this.collection(name)` returns the shared cached instance, so a
        // subsequent user `collection.get(id)` sees the assigned serial.
        stamp: async (collection, recordId, field, serial) => {
          const coll = this.collection<Record<string, unknown>>(collection)
          const rec = await coll.get(recordId)
          if (!rec) return false
          await coll.put(recordId, { ...rec, [field]: serial })
          return true
        },
      })
    }
    return this.deferredNumbering
  }

  /** Run a deferred-numbering pass for `series` (assigns serials to settled records). */
  async runNumberingPass(series: string): Promise<import('./numbering/index.js').Assignment[]> {
    return this.deferred().runPass(series)
  }
```

Modify `sequence(name)` so the returned handle's `next` routes to the deferred engine when `name` is a configured series:

```ts
  sequence(name: string): SequenceHandle {
    if (this.numberingConfigs.has(name)) {
      const eng = this.deferred()
      return {
        next: (opts) => {
          if (!opts?.for) {
            throw new ValidationError(`sequence("${name}") is a deferred-numbering series; call next({ for: recordId }).`)
          }
          return eng.enqueue(name, opts.for)
        },
        peek: () => eng.peek(name), // handles encryption in one place (Step 3d)
      }
    }
    if (!this.sequenceStore) {
      this.sequenceStore = new SequenceStore({
        adapter: this.adapter, vault: this.name, encrypted: this.encrypted,
        getDEK: this.getDEK, actor: this.keyring.userId,
      })
    }
    return this.sequenceStore.handle(name)
  }
```

The handle's `peek` delegates to `eng.peek(name)` (Step 3d), which reuses the engine's `readJson` so encryption is handled in one place.

- [ ] **Step 3d: Add `DeferredNumberingStore.peek`**

In `packages/hub/src/numbering/index.ts`:

```ts
  /** Current last-assigned serial for a series (0 if none). */
  async peek(series: string): Promise<number> {
    const { value } = await this.readJson<NumberingHead>(NUMBERING_HEAD_COLLECTION, series)
    return value?.lastSerial ?? 0
  }
```

- [ ] **Step 4: Run tests + full sequence/numbering suites**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/numbering/deferred.test.ts __tests__/sequence.test.ts && npx tsc --noEmit`
Expected: all PASS (deferred integration + existing CAS sequence untouched), tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/vicio/_github/noy-db
git add packages/hub/src/sequence/index.ts packages/hub/src/vault.ts packages/hub/src/noydb.ts packages/hub/src/types.ts packages/hub/src/numbering/index.ts packages/hub/__tests__/numbering/deferred.test.ts
git commit -m "feat(numbering): wire withDeferredNumbering into vault.sequence().next({for}) + runNumberingPass"
```

---

## Task 8: Public exports

**Files:**
- Modify: `packages/hub/src/index.ts`

- [ ] **Step 1: Add exports**

In `packages/hub/src/index.ts`, add (value exports — these are not federation-chunk symbols, so no bundle-isolation concern):

```ts
export { withDeferredNumbering } from './numbering/descriptor.js'
export type { DeferredNumberingConfig } from './numbering/descriptor.js'
export type { Assignment as NumberingAssignment } from './numbering/index.js'
export { NumberingUncertaintyError } from './errors.js'
export type { StoreTime } from './types.js'
```

(Confirm `NextOptions` should be public too — add `export type { NextOptions } from './sequence/index.js'` next to the existing `SequenceHandle` export if one exists.)

- [ ] **Step 2: Typecheck + full hub suite**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx tsc --noEmit && npx vitest run`
Expected: PASS (all hub tests green).

- [ ] **Step 3: Commit**

```bash
cd /Users/vicio/_github/noy-db
git add packages/hub/src/index.ts
git commit -m "feat(numbering): export withDeferredNumbering + StoreTime + NumberingUncertaintyError"
```

---

## Task 9: `features.yaml` registry entry

**Files:**
- Modify: `features.yaml`
- Create: `showcases/src/NNN-deferred-numbering.showcase.test.ts` (number = next free showcase id)

- [ ] **Step 1: Inspect a sibling feature entry**

Run: `rg -n "id: .*sequence|atomic sequence|numbering" features.yaml`
Expected: locate the existing sequence/numbering feature entry (from #303) to mirror its key shape.

- [ ] **Step 2: Write a showcase (doubles as an integration test)**

Create `showcases/src/NNN-deferred-numbering.showcase.test.ts` mirroring the header style of an existing showcase, demonstrating: declare `withDeferredNumbering`, write records, `await v.sequence('invoices').next({ for })` (Promise pending), `await v.runNumberingPass('invoices')`, assert gap-free serials in store-time order. Use `memory()` from `@noy-db/hub`'s adapter (it now has `getStoreTime`). Run it: `cd showcases && npx vitest run src/NNN-deferred-numbering.showcase.test.ts` — build the hub first if `@noy-db/hub` resolves to `dist` (`cd packages/hub && npm run build`).

- [ ] **Step 3: Add the features.yaml entry**

Add a feature entry (or extend the existing sequence entry) referencing the spec `docs/superpowers/specs/2026-06-08-sealed-numbering-and-store-clock-design.md` and the new showcase path, matching the neighboring entry's exact keys. Then run the validator: `npm run validate:features` (from repo root) — expect `features.yaml OK`. If a showcase id ≥ 100 trips the schema, the `[0-9]{2,}` pattern fix (from #322) is already in `scripts/feature-schema.json`.

- [ ] **Step 4: Commit**

```bash
cd /Users/vicio/_github/noy-db
git add features.yaml showcases/src/NNN-deferred-numbering.showcase.test.ts
git commit -m "chore(features): register deferred-numbering capability + showcase"
```

---

## Final verification

- [ ] **Run the full hub suite + typecheck + features validation**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx tsc --noEmit && npx vitest run && cd ../.. && npm run validate:features`
Expected: all green; `features.yaml OK`.

- [ ] **Confirm the CAS path is untouched**

Run: `cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/sequence.test.ts`
Expected: PASS — the existing CAS `next()` behavior is unchanged; deferred mode only activates for configured series.

---

## Notes for the implementer

- **The durable field is the source of truth; the Promise is convenience.** `enqueue` returns an in-process Promise resolved by `runPass`. A crash between the two loses the Promise, not the pending entry — a later pass still numbers the record and stamps its field. Do not build cross-process Promise delivery in this slice; reloading UIs read the field.
- **`runPass` is explicit in this MVP.** No auto-timer. A later slice adds a scheduler that calls `runPass` every `settleWindowMs`.
- **Encryption.** The engine mirrors `SequenceStore`'s `encrypt`/`decrypt` + `getDEK(collection)` usage. The MVP tests run `encrypt:false`; an encrypted round-trip test is worth adding but the crypto path is identical to the proven sequence path.
- **Concurrency.** `runPass` advances the head with one CAS; a losing concurrent pass returns `[]` and the next pass reconciles. Because numbering is a deterministic function of the settled set + head, concurrent passes converge without duplicates. (`to-memory` is `casAtomic`, so this is exercised.)
- **`storeLatest ≤ now.earliest`** is the commit-wait gate — the single line that makes the ordering stable (a future write's store time is ≥ `now.earliest`, so it can never sort before a settled entry).
