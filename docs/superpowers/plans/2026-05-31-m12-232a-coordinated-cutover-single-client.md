# M12 #232 sub-slice 3a — coordinatedCutover (single-client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the single-client, deterministically-testable core of the coordinated drain-barrier: a hub-managed schema-generation fence, the `coordinatedCutover` strategy, write-path enforcement (`SchemaFenceError` / `MigrationRequiredError`), and a local admin trigger that bulk-transforms records and bumps the generation counter.

**Architecture:** A vault-level `SchemaFenceController` owns the fence document (`_meta/schema-fence`, stored like `_meta/policy`), the open-time generation snapshot, and a map of pending per-collection transforms. `Collection.put`/`delete` call `controller.assertWritable(name)` (throws when fenced, when a cutover is pending for the collection, or when the snapshot is behind the live counter). `vault.runSchemaCutover()` drains (via `hub.writeQueue.onFlush()`), runs each pending transform over all records, updates persisted baselines, bumps the counter, and appends a ledger `op:'migration'` entry. No presence/election here — one client is trivially the migrator (sub-slice 3b adds distribution).

**Tech Stack:** TypeScript, Vitest, `@noy-db/to-memory`, Zod. Hub package at `packages/hub`. Builds on #245 (schema-update framework) and #227 (`hub.writeQueue.onFlush`).

**Spec:** `docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md` §4 + §5 Slice 3a. Issue #232.

---

## Spec correction (apply as Task 0)

The spec §4 / decision-table call the fence storage "encrypted `_meta/policy` machinery." That's inaccurate: `_meta/policy` uses the **plaintext-in-envelope** pattern (`policy/storage.ts` writes `_iv: ''` with plain-JSON `_data`). The fence reuses that same pattern — it carries no PII (a generation counter + a state enum), so plaintext is intentional and lets a locked client read fence state. This is **not a new** plaintext-bypass subsystem (it reuses the existing `_meta` envelope convention). Task 0 corrects the wording.

---

## Scope

**In scope (single-client mechanics, all deterministic):**
- Fence doc `{ currentSchemaVersion, fenceState }` at `_meta/schema-fence` (plaintext envelope like `_meta/policy`).
- `SchemaFenceController`: open-snapshot, pending-cutover registry, `assertWritable`, `runCutover`.
- `coordinatedCutover({ transform })` strategy → `{ action: 'cutover', transform }` on a non-additive delta.
- Write-path enforcement in `Collection.put`/`delete`.
- `Collection._applyCutoverTransform(transform)` — raw read→transform→write.
- `vault.runSchemaCutover()` admin trigger (local, no election/presence).
- Errors `SchemaFenceError`, `MigrationRequiredError`; ledger `op:'migration'`.

**Out of scope (sub-slice 3b):** presence-driven multi-client quiesce + per-client acks, real `by-peer` Web Locks election, heartbeat staleness, cross-client fence-state propagation. 3a's `runCutover` still calls `await hub.writeQueue.onFlush()` (the local quiesce primitive) so 3b only adds *other* clients' quiesce.

---

## File structure

- **Create** `packages/hub/src/schema-update/fence.ts` — `FenceDoc` type, `DEFAULT_FENCE`, `loadFence`/`saveFence` (modeled on `policy/storage.ts`).
- **Create** `packages/hub/src/schema-update/cutover.ts` — `coordinatedCutover()` strategy factory.
- **Create** `packages/hub/src/schema-update/fence-controller.ts` — `SchemaFenceController`.
- **Modify** `packages/hub/src/schema-update/index.ts` — export `coordinatedCutover`; (controller/fence stay internal).
- **Modify** `packages/hub/src/index.ts` — export `coordinatedCutover` + the two new errors.
- **Modify** `packages/hub/src/errors.ts` — `SchemaFenceError`, `MigrationRequiredError`.
- **Modify** `packages/hub/src/history/ledger/entry.ts` — add `'migration'` to the `op` union.
- **Modify** `packages/hub/src/collection.ts` — `_applyCutoverTransform`; `assertWritable` call in `put`/`delete`; accept a `fenceController` opt.
- **Modify** `packages/hub/src/vault.ts` — build the controller, feed cutover decisions, thread into `collOpts`, `runSchemaCutover()`.
- **Modify** `packages/hub/src/noydb.ts` — snapshot the fence on `openVault`.
- **Create** tests under `packages/hub/__tests__/schema-update/` + a cutover E2E test.

---

## Task 0: Spec wording correction

**Files:** Modify `docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md`

- [ ] **Step 1:** In §4, change the fence-doc code comment `(encrypted, reuses _meta/policy load/save/cache)` to `(plaintext envelope like _meta/policy — no PII; reuses the _meta convention)`. In the §3 decision table, change `Fence-state storage … Reuse encrypted _meta/policy machinery` to `Reuse the _meta/policy storage pattern (plaintext envelope; fence carries no PII)`.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md
git commit -m "docs(m12): correct fence storage — plaintext _meta envelope, not encrypted (#232)"
```

---

## Task 1: Ledger `op:'migration'`

**Files:** Modify `packages/hub/src/history/ledger/entry.ts`

- [ ] **Step 1: Find the op union**

Run: `grep -n "op: 'put' | 'delete' | 'amendment' | 'lifecycle'" packages/hub/src/history/ledger/entry.ts`

- [ ] **Step 2: Add `'migration'`**

Change the union (at the matched line) to:
```ts
  readonly op: 'put' | 'delete' | 'amendment' | 'lifecycle' | 'migration'
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/hub && npx tsc --noEmit`
Expected: PASS (adding a union member doesn't break existing exhaustive switches that have a `default`; if tsc flags a non-exhaustive switch over `op`, add a `case 'migration':` mirroring the `'lifecycle'` branch at the flagged location).

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/history/ledger/entry.ts
git commit -m "feat(hub): add 'migration' to ledger op union (#232)"
```

---

## Task 2: Error classes

**Files:** Modify `packages/hub/src/errors.ts`, `packages/hub/src/index.ts`

- [ ] **Step 1: Add the classes after `SchemaLockedError`** (added in #245)

In `errors.ts`, after `SchemaLockedError`'s closing `}`:
```ts
/** Write attempted while a schema cutover fence is up (draining/migrating, or this collection has a pending cutover). */
export class SchemaFenceError extends SchemaUpdateError {
  constructor(message: string) {
    super('SCHEMA_FENCE', message)
    this.name = 'SchemaFenceError'
  }
}

/** Write attempted by a client whose generation snapshot is behind the live fence — reload required. */
export class MigrationRequiredError extends SchemaUpdateError {
  constructor(message: string) {
    super('MIGRATION_REQUIRED', message)
    this.name = 'MigrationRequiredError'
  }
}
```

- [ ] **Step 2: Export them** — in `index.ts`, add to the `} from './errors.js'` list that already includes `SchemaUpdateError`:
```ts
  SchemaFenceError,
  MigrationRequiredError,
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd packages/hub && npx tsc --noEmit`  (Expected: PASS)
```bash
git add packages/hub/src/errors.ts packages/hub/src/index.ts
git commit -m "feat(hub): SchemaFenceError + MigrationRequiredError (#232)"
```

---

## Task 3: Fence document storage

**Files:** Create `packages/hub/src/schema-update/fence.ts`; Test `packages/hub/__tests__/schema-update/fence.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { memory } from '../../../to-memory/src/index.js'
import { loadFence, saveFence, DEFAULT_FENCE } from '../../src/schema-update/fence.js'

describe('fence storage', () => {
  it('returns DEFAULT_FENCE when none persisted', async () => {
    const store = memory()
    expect(await loadFence(store, 'v')).toEqual(DEFAULT_FENCE)
  })
  it('round-trips a saved fence', async () => {
    const store = memory()
    await saveFence(store, 'v', { currentSchemaVersion: 3, fenceState: 'migrating' })
    expect(await loadFence(store, 'v')).toEqual({ currentSchemaVersion: 3, fenceState: 'migrating' })
  })
  it('tolerates a corrupt envelope → DEFAULT_FENCE', async () => {
    const store = memory()
    await store.put('v', '_meta', 'schema-fence', {
      _noydb: 1, _v: 1, _ts: new Date(0).toISOString(), _iv: '', _data: 'not json',
    })
    expect(await loadFence(store, 'v')).toEqual(DEFAULT_FENCE)
  })
})
```

- [ ] **Step 2: Run → fail** (`cd packages/hub && npx vitest run __tests__/schema-update/fence.test.ts` → module not found)

- [ ] **Step 3: Implement** `fence.ts`

```ts
/**
 * Schema-fence document (#232). Vault-level generation counter + drain
 * state, stored at `_meta/schema-fence` using the plaintext-envelope
 * pattern of `_meta/policy` (no PII — a counter + a state enum).
 */
import type { NoydbStore, EncryptedEnvelope } from '../types.js'
import { NOYDB_FORMAT_VERSION } from '../types.js'

export type FenceState = 'normal' | 'draining' | 'migrating' | 'complete'

export interface FenceDoc {
  readonly currentSchemaVersion: number
  readonly fenceState: FenceState
}

export const FENCE_RECORD_ID = 'schema-fence'
const META_COLLECTION = '_meta'

export const DEFAULT_FENCE: FenceDoc = { currentSchemaVersion: 0, fenceState: 'normal' }

export async function loadFence(store: NoydbStore, vault: string): Promise<FenceDoc> {
  const envelope = await store.get(vault, META_COLLECTION, FENCE_RECORD_ID)
  if (!envelope) return DEFAULT_FENCE
  try {
    const parsed = JSON.parse(envelope._data) as unknown
    if (!isFenceDoc(parsed)) return DEFAULT_FENCE
    return parsed
  } catch {
    return DEFAULT_FENCE
  }
}

export async function saveFence(store: NoydbStore, vault: string, fence: FenceDoc): Promise<void> {
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(fence),
  }
  await store.put(vault, META_COLLECTION, FENCE_RECORD_ID, envelope)
}

function isFenceDoc(x: unknown): x is FenceDoc {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o['currentSchemaVersion'] === 'number'
    && (o['fenceState'] === 'normal' || o['fenceState'] === 'draining'
      || o['fenceState'] === 'migrating' || o['fenceState'] === 'complete')
}
```

(`new Date()` matches the existing `policy/storage.ts` pattern — acceptable in library code; only workflow *scripts* forbid it.)

- [ ] **Step 4: Run → pass; commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/schema-update/fence.ts packages/hub/__tests__/schema-update/fence.test.ts
git commit -m "feat(hub): schema-fence document storage (#232)"
```

---

## Task 4: `coordinatedCutover` strategy

**Files:** Create `packages/hub/src/schema-update/cutover.ts`; Test `packages/hub/__tests__/schema-update/cutover.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { coordinatedCutover } from '../../src/schema-update/cutover.js'
import type { SchemaDelta } from '../../src/schema-update/types.js'

const delta = (kind: SchemaDelta['kind']): SchemaDelta =>
  ({ collection: 'invoices', kind, added: [], removed: [], changed: [] })
const ctx = { collection: 'invoices' }
const transform = (d: Record<string, unknown>) => ({ ...d, migrated: true })

describe('coordinatedCutover', () => {
  it('returns cutover (with the transform) on a non-additive delta', async () => {
    const d = await coordinatedCutover({ transform }).onSchemaDelta(delta('non-additive'), ctx)
    expect(d.action).toBe('cutover')
    if (d.action === 'cutover') expect(d.transform).toBe(transform)
  })
  it('allows additive and none', async () => {
    const s = coordinatedCutover({ transform })
    expect(await s.onSchemaDelta(delta('additive'), ctx)).toEqual({ action: 'allow' })
    expect(await s.onSchemaDelta(delta('none'), ctx)).toEqual({ action: 'allow' })
  })
})
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement** `cutover.ts`

```ts
/** The coordinatedCutover update strategy (#232, single-step — no from/to). */
import type { SchemaUpdateStrategy, SchemaDelta, TransformFn } from './types.js'

export function coordinatedCutover(opts: { readonly transform: TransformFn }): SchemaUpdateStrategy {
  return {
    name: 'coordinatedCutover',
    onSchemaDelta(delta: SchemaDelta) {
      if (delta.kind === 'non-additive') {
        return { action: 'cutover' as const, transform: opts.transform }
      }
      return { action: 'allow' as const }
    },
  }
}
```

- [ ] **Step 4: Export** — in `schema-update/index.ts` add `export { coordinatedCutover } from './cutover.js'`; in `src/index.ts` add `coordinatedCutover` to the `export { blindUpdate, additiveOnly, lockSchema ... }` line.

- [ ] **Step 5: Run → pass; typecheck; commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/schema-update/cutover.ts packages/hub/src/schema-update/index.ts packages/hub/src/index.ts packages/hub/__tests__/schema-update/cutover.test.ts
git commit -m "feat(hub): coordinatedCutover strategy (#232)"
```

---

## Task 5: `Collection._applyCutoverTransform`

**Files:** Modify `packages/hub/src/collection.ts`; Test `packages/hub/__tests__/schema-update/apply-cutover.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/noydb.js'
import { memory } from '../../../to-memory/src/index.js'

interface Inv extends Record<string, unknown> { id: string; total?: number; amount?: { gross: number } }

describe('Collection._applyCutoverTransform', () => {
  it('rewrites every record through the transform, bumping _v', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'a', secret: 'apply-cutover-pass-1234' })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Inv>('invoices', { schema: z.object({ id: z.string(), total: z.number().optional(), amount: z.object({ gross: z.number() }).optional() }) })
    await invoices.put('i1', { id: 'i1', total: 100 })
    await invoices.put('i2', { id: 'i2', total: 200 })

    // @ts-expect-error internal method
    const count = await invoices._applyCutoverTransform((d) => ({ id: d['id'], amount: { gross: d['total'] } }))
    expect(count).toBe(2)
    expect((await invoices.get('i1'))?.amount?.gross).toBe(100)
    expect((await invoices.get('i2'))?.amount?.gross).toBe(200)
  })
})
```

- [ ] **Step 2: Run → fail** (method missing)

- [ ] **Step 3: Implement** — add this method to the `Collection` class (near the other internal write helpers, e.g. after `putInternal`):

```ts
  /**
   * @internal #232 — bulk-rewrite every record through a cutover transform.
   * Raw adapter path (bypasses the write gate + guards — the transform is
   * trusted and runs only during the `migrating` phase). Bumps each
   * record's `_v` and appends a ledger `op:'migration'` entry.
   */
  async _applyCutoverTransform(
    transform: (doc: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<number> {
    const ids = await this.adapter.list(this.vault, this.name)
    let count = 0
    for (const id of ids) {
      const env = await this.adapter.get(this.vault, this.name, id)
      if (!env) continue
      const record = (await this.decryptRecord(env, { skipValidation: true })) as unknown as Record<string, unknown>
      const next = transform(record)
      const nextVersion = (env._v ?? 0) + 1
      const newEnv = await this.encryptRecord(next as unknown as T, nextVersion)
      await this.adapter.put(this.vault, this.name, id, newEnv)
      this.ledger?.append({
        op: 'migration', collection: this.name, id, version: nextVersion,
        actor: actorId(this.keyring), payloadHash: '', reason: 'schema:coordinated-cutover',
      }).catch(() => {})
      count++
    }
    return count
  }
```

Note: confirm the actor accessor — run `grep -n "actorId\|this.keyring.userId\|keyring.user" packages/hub/src/collection.ts` and use whatever the existing ledger-append sites use for `actor` (replace `actorId(this.keyring)` accordingly; the existing `put` ledger append at ~collection.ts:1272 shows the exact expression). If `adapter.list` is not on `NoydbStore`, use the method the codebase uses to enumerate ids (confirm via `grep -n "list(" packages/hub/src/types.ts`).

- [ ] **Step 4: Run → pass; commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/collection.ts packages/hub/__tests__/schema-update/apply-cutover.test.ts
git commit -m "feat(hub): Collection._applyCutoverTransform bulk rewrite (#232)"
```

---

## Task 6: `SchemaFenceController`

**Files:** Create `packages/hub/src/schema-update/fence-controller.ts`; Test `packages/hub/__tests__/schema-update/fence-controller.test.ts`

- [ ] **Step 1: Write the failing unit test** (controller logic, with fakes — no real collections)

```ts
import { describe, expect, it, vi } from 'vitest'
import { memory } from '../../../to-memory/src/index.js'
import { SchemaFenceController } from '../../src/schema-update/fence-controller.js'
import { saveFence, loadFence } from '../../src/schema-update/fence.js'
import { SchemaFenceError, MigrationRequiredError } from '../../src/errors.js'

function ctrl(store = memory()) {
  return { store, c: new SchemaFenceController({ store, vault: 'v', onFlush: async () => {} }) }
}

describe('SchemaFenceController', () => {
  it('init snapshots the live counter; assertWritable passes when normal', async () => {
    const { store, c } = ctrl()
    await saveFence(store, 'v', { currentSchemaVersion: 2, fenceState: 'normal' })
    await c.init()
    await expect(c.assertWritable('invoices')).resolves.toBeUndefined()
  })

  it('throws MigrationRequiredError when live counter advanced past the snapshot', async () => {
    const { store, c } = ctrl()
    await saveFence(store, 'v', { currentSchemaVersion: 2, fenceState: 'normal' })
    await c.init()
    await saveFence(store, 'v', { currentSchemaVersion: 3, fenceState: 'normal' }) // bumped under us
    await expect(c.assertWritable('invoices')).rejects.toBeInstanceOf(MigrationRequiredError)
  })

  it('throws SchemaFenceError for a collection with a pending cutover', async () => {
    const { c } = ctrl()
    await c.init()
    c.registerPendingCutover('invoices', (d) => d)
    await expect(c.assertWritable('invoices')).rejects.toBeInstanceOf(SchemaFenceError)
    await expect(c.assertWritable('other')).resolves.toBeUndefined()
  })

  it('runCutover: flushes, runs each pending transform, bumps counter, clears pending, ends normal', async () => {
    const { store, c } = ctrl()
    await c.init()
    const applied: string[] = []
    c.registerPendingCutover('invoices', (d) => d)
    c.registerPendingCutover('payments', (d) => d)
    await c.runCutover(async (collection, transform) => { applied.push(collection); await transform({}) })
    expect(applied.sort()).toEqual(['invoices', 'payments'])
    expect((await loadFence(store, 'v')).currentSchemaVersion).toBe(1)
    expect((await loadFence(store, 'v')).fenceState).toBe('normal')
    await expect(c.assertWritable('invoices')).rejects.toBeInstanceOf(MigrationRequiredError) // snapshot now behind
  })

  it('runCutover with nothing pending is a no-op (no counter bump)', async () => {
    const { store, c } = ctrl()
    await c.init()
    await c.runCutover(async () => {})
    expect((await loadFence(store, 'v')).currentSchemaVersion).toBe(0)
  })
})
```

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement** `fence-controller.ts`

```ts
/**
 * Vault-level schema-fence controller (#232, sub-slice 3a).
 *
 * Owns the open-time generation snapshot, the pending-cutover registry,
 * and the local cutover orchestration. Single-client: the caller IS the
 * migrator (sub-slice 3b adds presence + election). `assertWritable` is
 * the write-path gate; `runCutover` is the admin trigger.
 */
import type { NoydbStore } from '../types.js'
import { loadFence, saveFence, type FenceState } from './fence.js'
import { SchemaFenceError, MigrationRequiredError } from '../errors.js'
import type { TransformFn } from './types.js'

/** Runs one collection's transform; supplied by the Vault (binds to a Collection). */
export type RunTransform = (collection: string, transform: TransformFn) => Promise<void>

export class SchemaFenceController {
  readonly #store: NoydbStore
  readonly #vault: string
  readonly #onFlush: () => Promise<void>
  #snapshot = 0
  readonly #pending = new Map<string, TransformFn>()

  constructor(opts: { store: NoydbStore; vault: string; onFlush: () => Promise<void> }) {
    this.#store = opts.store
    this.#vault = opts.vault
    this.#onFlush = opts.onFlush
  }

  /** Capture the generation snapshot at vault-open. */
  async init(): Promise<void> {
    this.#snapshot = (await loadFence(this.#store, this.#vault)).currentSchemaVersion
  }

  /** Record a per-collection pending cutover (from a registration `cutover` decision). */
  registerPendingCutover(collection: string, transform: TransformFn): void {
    this.#pending.set(collection, transform)
  }

  /** Write-path gate. Throws when behind, fenced, or this collection is cutover-pending. */
  async assertWritable(collection: string): Promise<void> {
    const fence = await loadFence(this.#store, this.#vault)
    if (fence.currentSchemaVersion > this.#snapshot) {
      throw new MigrationRequiredError(
        `Vault "${this.#vault}" advanced to schema generation ${fence.currentSchemaVersion} ` +
          `(this client opened at ${this.#snapshot}). Reload to continue.`,
      )
    }
    if (fence.fenceState === 'draining' || fence.fenceState === 'migrating') {
      throw new SchemaFenceError(`Vault "${this.#vault}" is mid-cutover (${fence.fenceState}); writes are paused.`)
    }
    if (this.#pending.has(collection)) {
      throw new SchemaFenceError(
        `Collection "${collection}" has a pending schema cutover; run vault.runSchemaCutover() before writing.`,
      )
    }
  }

  /** Admin trigger (single-client). Drain → migrate each pending transform → bump → complete → normal. */
  async runCutover(run: RunTransform): Promise<{ migrated: number }> {
    if (this.#pending.size === 0) return { migrated: 0 }
    const base = await loadFence(this.#store, this.#vault)

    await this.#setState(base.currentSchemaVersion, 'draining')
    await this.#onFlush() // local quiesce; 3b adds other clients' acks

    await this.#setState(base.currentSchemaVersion, 'migrating')
    let migrated = 0
    for (const [collection, transform] of this.#pending) {
      await run(collection, transform)
      migrated++
    }

    const nextVersion = base.currentSchemaVersion + 1
    await saveFence(this.#store, this.#vault, { currentSchemaVersion: nextVersion, fenceState: 'complete' })
    this.#pending.clear()
    await saveFence(this.#store, this.#vault, { currentSchemaVersion: nextVersion, fenceState: 'normal' })
    // The migrator advances its OWN snapshot — it just produced this generation.
    this.#snapshot = nextVersion
    return { migrated }
  }

  async #setState(currentSchemaVersion: number, fenceState: FenceState): Promise<void> {
    await saveFence(this.#store, this.#vault, { currentSchemaVersion, fenceState })
  }
}
```

- [ ] **Step 4: Run → pass; commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/schema-update/fence-controller.ts packages/hub/__tests__/schema-update/fence-controller.test.ts
git commit -m "feat(hub): SchemaFenceController — snapshot, gate, local cutover (#232)"
```

---

## Task 7: Wire the controller into `Vault` + `runSchemaCutover()`

**Files:** Modify `packages/hub/src/vault.ts`, `packages/hub/src/noydb.ts`

- [ ] **Step 1: Construct the controller per vault**

In `vault.ts`, import:
```ts
import { SchemaFenceController } from './schema-update/fence-controller.js'
```
Add a field on the `Vault` class:
```ts
  readonly schemaFence: SchemaFenceController
```
In the `Vault` constructor body, after `this.noydb = opts.noydb`, construct it:
```ts
    this.schemaFence = new SchemaFenceController({
      store: this.adapter,
      vault: this.name,
      onFlush: () => this.noydb._writeQueueTracker.onFlush(),
    })
```

- [ ] **Step 2: Snapshot the fence on open**

In `noydb.ts`, find `openVault` (`grep -n "async openVault" packages/hub/src/noydb.ts`). After the `Vault` is constructed/returned-from-cache but before returning, await the snapshot once per vault instance:
```ts
    await vault.schemaFence.init()
```
(Place it where the Vault instance is first created — guard with a "already initialised" check if `openVault` can return a cached instance, so `init()` runs once. If the cache path returns early, call `init()` only on the construction path.)

- [ ] **Step 3: Feed the cutover decision into the controller**

In `vault.ts`, in the #245 gate-building block (the `if (... schemaUpdate?.length ...)` that builds `work`), extend the `work` body so that when the decision is a cutover, it registers the pending transform:
```ts
        const work = (async (): Promise<UpdateDecision> => {
          const dek = await this.getDEK(collectionName)
          const result = await persistSchemaIfNeeded({
            store: this.adapter, vault: this.name, collectionName, validator, dek, strategies,
          })
          const decision = result.decision ?? { action: 'allow' as const }
          if (decision.action === 'cutover') {
            this.schemaFence.registerPendingCutover(collectionName, decision.transform)
          }
          return decision
        })()
```
(The `SchemaUpdateGate` from #245 still handles `reject`; the controller handles `cutover`. Both are consulted at the write path — Task 8.)

- [ ] **Step 4: Add the admin trigger**

Add a public method on `Vault`:
```ts
  /**
   * Run a coordinated schema cutover (#232, single-client). Drains pending
   * writes, applies every pending collection transform in bulk, bumps the
   * vault schema generation, and clears the fence. Returns the count of
   * collections migrated.
   */
  async runSchemaCutover(): Promise<{ migrated: number }> {
    return this.schemaFence.runCutover(async (collectionName, transform) => {
      const coll = this.collectionCache.get(collectionName)
      if (!coll) return
      await coll._applyCutoverTransform(transform)
    })
  }
```
(Confirm the collection-cache field name via `grep -n "collectionCache" packages/hub/src/vault.ts`; reuse it.)

- [ ] **Step 5: Thread the controller into `collOpts`**

In the `collOpts` object, beside `schemaUpdateGate,`:
```ts
        schemaFence: this.schemaFence,
```

- [ ] **Step 6: Typecheck** (`cd packages/hub && npx tsc --noEmit`) — expect an error that `schemaFence` isn't a Collection opt (resolved in Task 8). Do not commit yet.

---

## Task 8: Enforce the fence in `Collection.put`/`delete`

**Files:** Modify `packages/hub/src/collection.ts`

- [ ] **Step 1: Accept the controller**

Add the import:
```ts
import type { SchemaFenceController } from './schema-update/fence-controller.js'
```
Add to the constructor opts type (beside `schemaUpdateGate?`):
```ts
    /** #232 — vault-level fence controller; `put`/`delete` consult it. */
    schemaFence?: SchemaFenceController | undefined
```
Add the field + assignment (beside `schemaUpdateGate`):
```ts
  private readonly schemaFence: SchemaFenceController | undefined
```
```ts
    this.schemaFence = opts.schemaFence
```

- [ ] **Step 2: Consult it in the wrappers** — add after the existing `await this.schemaUpdateGate?.assertWritable()` line in BOTH `put` and `delete`:
```ts
    await this.schemaFence?.assertWritable(this.name)
```
(Order: the static `reject` gate first, then the dynamic fence. Both outside `track()`, so a blocked write never counts toward `writeQueue.depth`.)

- [ ] **Step 3: Typecheck (resolves Task 7) + run touched suites**

Run: `cd packages/hub && npx tsc --noEmit && npx vitest run __tests__/schema-update/ __tests__/persisted-schemas/ __tests__/write-queue.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit Tasks 7 + 8**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/vault.ts packages/hub/src/noydb.ts packages/hub/src/collection.ts
git commit -m "feat(hub): wire SchemaFenceController + vault.runSchemaCutover (#232)"
```

---

## Task 9: End-to-end cutover test

**Files:** Create `packages/hub/__tests__/coordinated-cutover-integration.test.ts`

- [ ] **Step 1: Write the test**

```ts
/** E2E single-client coordinatedCutover (#232 sub-slice 3a). */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import { coordinatedCutover, additiveOnly } from '../src/schema-update/index.js'
import { SchemaFenceError, MigrationRequiredError } from '../src/errors.js'
import type { NoydbStore } from '../src/types.js'

interface InvOld extends Record<string, unknown> { id: string; total: number }
interface InvNew extends Record<string, unknown> { id: string; amount: { gross: number } }

const oldSchema = z.object({ id: z.string(), total: z.number() })
const newSchema = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

async function open(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'a', secret: 'cutover-e2e-pass-1234' })
  return db.openVault('demo')
}

describe('coordinatedCutover E2E (#232 3a)', () => {
  it('pending cutover blocks writes; runSchemaCutover migrates + unblocks', async () => {
    const store = memory()
    // gen 0: seed old-shape data
    let v = await open(store)
    let invoices = v.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()
    await invoices.put('i1', { id: 'i1', total: 100 })

    // reopen with NEW schema + coordinatedCutover → non-additive → cutover-pending
    v = await open(store)
    const invNew = v.collection<InvNew>('invoices', {
      schema: newSchema, persistJsonSchema: true,
      schemaUpdate: [coordinatedCutover({ transform }), additiveOnly()],
    })
    await v._drainPendingSchemaWrites()

    await expect(invNew.put('i2', { id: 'i2', amount: { gross: 5 } })).rejects.toBeInstanceOf(SchemaFenceError)

    const result = await v.runSchemaCutover()
    expect(result.migrated).toBe(1)
    // existing record transformed in place
    expect((await invNew.get('i1'))?.amount.gross).toBe(100)
    // writes now allowed
    await expect(invNew.put('i2', { id: 'i2', amount: { gross: 5 } })).resolves.toBeUndefined()
  })

  it('a still-open stale client hits MigrationRequiredError after a cutover bumps the generation', async () => {
    const store = memory()
    let v = await open(store)
    v.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await v._drainPendingSchemaWrites()

    // stale client opens at gen 0
    const staleVault = await open(store)
    const staleInvoices = staleVault.collection<InvOld>('invoices', { schema: oldSchema, persistJsonSchema: true })
    await staleVault._drainPendingSchemaWrites()

    // a fresh client performs a cutover (bumps generation to 1)
    const migVault = await open(store)
    migVault.collection<InvNew>('invoices', { schema: newSchema, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })] })
    await migVault._drainPendingSchemaWrites()
    await migVault.runSchemaCutover()

    // stale client (snapshot 0) now sees live counter 1 → MigrationRequiredError
    await expect(staleInvoices.put('i9', { id: 'i9', total: 1 })).rejects.toBeInstanceOf(MigrationRequiredError)
  })

  it('additive change alongside coordinatedCutover still just passes', async () => {
    const store = memory()
    let v = await open(store)
    v.collection('logs', { schema: z.object({ id: z.string() }), persistJsonSchema: true })
    await v._drainPendingSchemaWrites()

    v = await open(store)
    const logs = v.collection('logs', {
      schema: z.object({ id: z.string(), level: z.string().optional() }), // additive
      persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform: (d) => d }), additiveOnly()],
    })
    await v._drainPendingSchemaWrites()
    await expect(logs.put('l1', { id: 'l1', level: 'info' })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run → pass**

Run: `cd packages/hub && npx vitest run __tests__/coordinated-cutover-integration.test.ts`
Expected: PASS — 3 tests. If "stale client" test sees the migrator's reopened vault share the cache: each `open()` builds a fresh `Noydb`/`Vault`, so snapshots are independent — confirm `createNoydb` returns a new instance per call (it does).

- [ ] **Step 3: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/__tests__/coordinated-cutover-integration.test.ts
git commit -m "test(hub): E2E single-client coordinatedCutover (#232)"
```

---

## Task 10: features.yaml + final verification

**Files:** Modify `features.yaml`

- [ ] **Step 1: Extend the `schema-update-strategies` entry's invariants** (don't add a second feature — the cutover is part of the same framework). Add to its `invariants:` list:
```yaml
      - 'coordinatedCutover blocks writes on a pending non-additive change until vault.runSchemaCutover() runs (SchemaFenceError)'
      - 'a client whose open-snapshot is behind the live fence generation is refused with MigrationRequiredError'
```

- [ ] **Step 2: Validate**

Run: `node scripts/validate-features.mjs`
Expected: PASS.

- [ ] **Step 3: Full verification**

Run: `cd packages/hub && npx vitest run && npx tsc --noEmit && npm run lint`
Expected: full suite PASS, no type errors, no lint errors.

- [ ] **Step 4: Commit + confirm clean tree**

```bash
cd /Users/vicio/_github/noy-db && git add features.yaml
git commit -m "chore(features): record coordinatedCutover invariants (#232)"
git status
```
Expected: clean tree.

---

## Self-review checklist (already applied)

- **Spec coverage (§4 single-step):** fence doc → Task 3; counter + open-snapshot → Task 6 (`init`) + Task 7 (snapshot on open); `SchemaFenceError` while fenced + cutover-pending → Tasks 2, 6, 8; `MigrationRequiredError` when snapshot < live → Tasks 2, 6, 8; `coordinatedCutover({ transform })` on non-additive → Task 4; bulk transform + baseline update + counter bump + ledger `op:'migration'` → Tasks 1, 5, 6, 7; admin trigger (local, no election) → Task 7; fence storage wording fix → Task 0.
- **Out-of-scope honesty:** presence/acks/`by-peer` election/heartbeat are sub-slice 3b; `runCutover` already calls `onFlush()` so 3b only adds other clients. The persisted-baseline update during cutover happens because `_applyCutoverTransform` writes new-shape records, but the **persisted-schema baseline** envelope is refreshed on the *next* registration (the new shape now matches) — if a test shows the baseline stale mid-session, add an explicit `persistSchemaIfNeeded` (no strategies) call inside `runSchemaCutover` after transforms; flagged for the implementer to verify.
- **Type consistency:** `FenceDoc`/`FenceState`/`loadFence`/`saveFence`/`DEFAULT_FENCE`, `SchemaFenceController.{init,registerPendingCutover,assertWritable,runCutover}`, `RunTransform`, `coordinatedCutover`, `_applyCutoverTransform`, `schemaFence` opt — names consistent across Tasks 3–9.
- **Verify-before-trust flags:** Task 5 notes to confirm the `actor` expression + `adapter.list` method name against existing code; Task 7 notes to confirm `collectionCache` + `openVault` cache path. These are real lookups the implementer must do, not guesses baked in.
- **No placeholders:** every code step has complete code; every run step states command + expected result.
