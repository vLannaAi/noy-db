# MVF VaultGroup Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the milestone-16 MVP — `withVaultTemplate` + `VaultGroup`/`ShardedCollection` transparent shard routing with cross-shard fan-out reads, backed by a minimal `vault-registry` as the source of truth for shard discovery.

**Architecture:** A new `packages/hub/src/federation/` module adds `VaultGroup<T>` (created via `db.openVaultGroup`) that routes writes to per-partition shard vaults by a `keyOf` partition key, reading shard locations from a caller-supplied `vault-registry` collection. Reads fan out via the existing `Noydb.queryAcross` engine, pre-filtered by a registry-recorded `schemaVersion` guard. Shards are ordinary noy-db vaults stamped from a registered template; the operator `Noydb` instance owns them.

**Tech Stack:** TypeScript, `@noy-db/hub` internals (`Noydb`, `Vault`, `Collection`, `queryAcross`), Vitest. Package manager: pnpm 9.

**Spec:** `docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md`

---

## File Structure

- **Create** `packages/hub/src/federation/types.ts` — `VaultTemplate`, `VaultRegistryRow`, `ShardingConfig`, `VaultGroupOptions`, `FanoutResult`, `SkippedVault`, `FanoutQueryOptions`.
- **Create** `packages/hub/src/federation/vault-group.ts` — `VaultGroup<T>`, `ShardedCollection<T>`, `ShardedQuery<T>`.
- **Create** `packages/hub/src/federation/index.ts` — re-export the public surface.
- **Modify** `packages/hub/src/errors.ts` — add `UnknownShardError`, `ShardProvisioningError`, `VaultTemplateNotFoundError`.
- **Modify** `packages/hub/src/noydb.ts` — add `vaultTemplates` map, `withVaultTemplate()`, `openVaultGroup()`, internal `_shardVaultProvisioned()`.
- **Modify** `packages/hub/src/index.ts` — export federation types + classes + new errors.
- **Create** `packages/hub/__tests__/federation-vault-group.test.ts` — full test suite.
- **Create** `docs/subsystems/vault-group.md` — subsystem doc.
- **Modify** `features.yaml` — register the feature.
- **Modify** `SUBSYSTEMS.md` — add catalog row (#24).

**Key facts the implementer must know (verified against the codebase):**
- `Collection.put(id, record)` takes an explicit `id` first. `ShardedCollection.put(id, record)` mirrors this; the partition key is derived from the `record` via `keyOf`, not from `id`.
- `Collection.query()` is **synchronous** and reads an in-memory cache. The cache is only populated after an async method runs. Call `await coll.list()` to force hydration before `coll.query().toArray()`.
- `vault.collection(name, opts)` caches the instance per name (`collectionCache`). The first call's `opts` win, so the template's `configure(vault)` must run before any read so indexes/schema apply.
- `db.openVault(name)` is open-or-create. A keyring envelope lands at `_keyring/<userId>`; `store.list(vaultId, '_keyring')` is non-empty iff the (encrypted) vault is provisioned.
- `db.queryAcross(ids, fn, { concurrency })` returns `Array<{ vault, result } | { vault, error }>`; per-shard errors never abort the fan-out.
- `Operator` type is exported from `packages/hub/src/query/predicate.ts`.
- Tests use an inline `memory()` adapter (copy from `packages/hub/__tests__/cross-vault.test.ts`).

**Run tests with:** `pnpm --filter @noy-db/hub exec vitest run __tests__/federation-vault-group.test.ts`

---

## Task 1: Types module

**Files:**
- Create: `packages/hub/src/federation/types.ts`

- [ ] **Step 1: Write the types file**

```ts
/**
 * @category capability
 * Multi-vault partition federation (MVF) — public types for VaultGroup
 * transparent shard routing. See
 * docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md.
 */
import type { Vault } from '../vault.js'
import type { Collection } from '../collection.js'
import type { Operator } from '../query/predicate.js'

/**
 * A schema blueprint for a class of shard vaults. `configure` is
 * re-applied to every shard handle so all shards are configured
 * identically (collections, indexes, schemas). `version` is recorded
 * into each shard's registry row and drives the fan-out
 * `minVersion` guard.
 */
export interface VaultTemplate {
  readonly version: number
  readonly configure: (vault: Vault) => void
}

/** One row in the StateManagement `vault-registry` collection. */
export interface VaultRegistryRow {
  readonly vaultId: string
  readonly partitionKey: string
  readonly templateName: string
  readonly schemaVersion: number
  readonly createdAt: number
}

/** How a VaultGroup maps records to shards. */
export interface ShardingConfig<T> {
  /** Extract the partition key from a record. */
  readonly keyOf: (record: T) => string
  /** Name of the template (registered via `withVaultTemplate`) shards are stamped from. */
  readonly vaultTemplate: string
  /** When a write targets an unknown partition key, stamp a shard inline. Default `true`. */
  readonly autoCreate?: boolean
}

/** Options for `Noydb.openVaultGroup`. */
export interface VaultGroupOptions<T> {
  /** The `vault-registry` collection (source of truth for shard discovery). */
  readonly registry: Collection<VaultRegistryRow>
  readonly sharding: ShardingConfig<T>
}

/** Options for a cross-shard fan-out read. */
export interface FanoutQueryOptions {
  /** Skip shards whose registry `schemaVersion` is below this. */
  readonly minVersion?: number
  /** Max shards queried in parallel (passed to queryAcross). Default 1. */
  readonly concurrency?: number
}

/** A shard excluded from a fan-out result, with the reason. */
export interface SkippedVault {
  readonly vaultId: string
  readonly reason: 'schema-drift' | 'error'
  readonly error?: Error
}

/** The result of a cross-shard fan-out read. */
export interface FanoutResult<R> {
  readonly results: R[]
  readonly skippedVaults: SkippedVault[]
}

/** A single captured where-clause, replayed inside each shard. */
export interface WhereClause {
  readonly field: string
  readonly op: Operator
  readonly value: unknown
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @noy-db/hub exec tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/federation/types.ts
git commit -m "feat(federation): vault-group public types"
```

---

## Task 2: Error classes

**Files:**
- Modify: `packages/hub/src/errors.ts` (append after the existing query/data error classes)

- [ ] **Step 1: Add the three error classes**

Append to `packages/hub/src/errors.ts`:

```ts
// ─── Federation (multi-vault partition) Errors ──────────────────────────

/**
 * Thrown when a write targets a partition key that has no shard and
 * `sharding.autoCreate` is disabled.
 */
export class UnknownShardError extends NoydbError {
  readonly partitionKey: string

  constructor(partitionKey: string, groupName: string) {
    super(
      'SHARD_UNKNOWN',
      `No shard for partition key "${partitionKey}" in vault group "${groupName}" ` +
        `and autoCreate is disabled. Call group.createShard(${JSON.stringify(partitionKey)}) ` +
        `first, or enable sharding.autoCreate.`,
    )
    this.name = 'UnknownShardError'
    this.partitionKey = partitionKey
  }
}

/**
 * Thrown by `createShard` when the registry has a row for a partition
 * but the corresponding vault is not provisioned in the store —
 * a registry/store divergence. Refusing to recreate avoids masking
 * data loss.
 */
export class ShardProvisioningError extends NoydbError {
  readonly vaultId: string

  constructor(vaultId: string, partitionKey: string) {
    super(
      'SHARD_PROVISIONING',
      `Registry has a row for partition "${partitionKey}" (vault "${vaultId}") but that ` +
        `vault is not provisioned in the store. Refusing to recreate it — the registry and ` +
        `store have diverged. Investigate before retrying.`,
    )
    this.name = 'ShardProvisioningError'
    this.vaultId = vaultId
  }
}

/** Thrown when a VaultGroup references a template name that was never registered. */
export class VaultTemplateNotFoundError extends NoydbError {
  readonly templateName: string

  constructor(templateName: string) {
    super(
      'VAULT_TEMPLATE_NOT_FOUND',
      `No vault template registered under "${templateName}". Register it with ` +
        `db.withVaultTemplate(${JSON.stringify(templateName)}, { version, configure }) ` +
        `before opening the vault group.`,
    )
    this.name = 'VaultTemplateNotFoundError'
    this.templateName = templateName
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @noy-db/hub exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/errors.ts
git commit -m "feat(federation): UnknownShardError / ShardProvisioningError / VaultTemplateNotFoundError"
```

---

## Task 3: VaultGroup + createShard (with test harness)

**Files:**
- Create: `packages/hub/src/federation/vault-group.ts`
- Create: `packages/hub/src/federation/index.ts`
- Modify: `packages/hub/src/noydb.ts`
- Test: `packages/hub/__tests__/federation-vault-group.test.ts`

This task builds the `VaultGroup` skeleton, `createShard`, and wires `withVaultTemplate` / `openVaultGroup` / `_shardVaultProvisioned` onto `Noydb`. It establishes the shared test harness used by all later tasks.

- [ ] **Step 1: Write the failing test (harness + createShard cases)**

Create `packages/hub/__tests__/federation-vault-group.test.ts`:

```ts
/**
 * MVF VaultGroup routing — milestone 16 MVP.
 * Spec: docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, ShardProvisioningError, VaultTemplateNotFoundError, UnknownShardError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { Vault } from '../src/vault.js'
import type { VaultRegistryRow } from '../src/federation/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { clientId: string; amount: number; status: string }

/** Build an operator db with the registry vault opened and a v1 client template registered. */
async function harness(opts: { autoCreate?: boolean; templateVersion?: number } = {}) {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  db.withVaultTemplate('client-template', {
    version: opts.templateVersion ?? 1,
    configure(vault: Vault) {
      vault.collection<Invoice>('invoices')
    },
  })
  const stateVault = await db.openVault('state')
  const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
  const firm = await db.openVaultGroup<Invoice>('firm-clients', {
    registry,
    sharding: {
      keyOf: (r) => r.clientId,
      vaultTemplate: 'client-template',
      ...(opts.autoCreate !== undefined ? { autoCreate: opts.autoCreate } : {}),
    },
  })
  return { adapter, db, registry, firm }
}

describe('VaultGroup — template + createShard', () => {
  let h: Awaited<ReturnType<typeof harness>>
  beforeEach(async () => { h = await harness() })

  it('openVaultGroup throws when the template is unregistered', async () => {
    const db = await createNoydb({ store: memory(), user: 'operator', secret: 'op-pass' })
    const sv = await db.openVault('state')
    await expect(
      db.openVaultGroup<Invoice>('firm', {
        registry: sv.collection<VaultRegistryRow>('vault-registry'),
        sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'missing' },
      }),
    ).rejects.toBeInstanceOf(VaultTemplateNotFoundError)
  })

  it('createShard writes a registry row with the template version', async () => {
    await h.firm.createShard('acme')
    const row = await h.registry.get('acme')
    expect(row).not.toBeNull()
    expect(row!.vaultId).toBe('firm-clients--acme')
    expect(row!.partitionKey).toBe('acme')
    expect(row!.templateName).toBe('client-template')
    expect(row!.schemaVersion).toBe(1)
  })

  it('createShard is idempotent — re-running returns a handle, no duplicate row', async () => {
    await h.firm.createShard('acme')
    await h.firm.createShard('acme') // no throw
    const rows = await (async () => { await h.registry.list(); return h.registry.query().toArray() })()
    expect(rows.filter((r) => r.partitionKey === 'acme')).toHaveLength(1)
  })

  it('createShard reconciles a provisioned-but-unregistered vault (row missing, vault exists)', async () => {
    // Provision the shard vault directly, leaving the registry empty.
    await h.db.openVault('firm-clients--acme')
    const before = await h.registry.get('acme')
    expect(before).toBeNull()
    await h.firm.createShard('acme') // reconcile
    const after = await h.registry.get('acme')
    expect(after).not.toBeNull()
  })

  it('createShard throws ShardProvisioningError when the row exists but the vault is gone', async () => {
    // Write a registry row pointing at a vault that was never provisioned.
    await h.registry.put('ghost', {
      vaultId: 'firm-clients--ghost', partitionKey: 'ghost',
      templateName: 'client-template', schemaVersion: 1, createdAt: 1,
    })
    await expect(h.firm.createShard('ghost')).rejects.toBeInstanceOf(ShardProvisioningError)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/federation-vault-group.test.ts`
Expected: FAIL — `db.withVaultTemplate is not a function` / `openVaultGroup` missing / cannot resolve `../src/federation/index.js`.

- [ ] **Step 3: Write `vault-group.ts`**

Create `packages/hub/src/federation/vault-group.ts`:

```ts
/**
 * @category capability
 * Multi-vault partition federation — VaultGroup transparent shard
 * routing. Spec:
 * docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md.
 */
import type { Noydb } from '../noydb.js'
import type { Vault } from '../vault.js'
import type { Collection } from '../collection.js'
import { ShardProvisioningError, UnknownShardError } from '../errors.js'
import type {
  ShardingConfig,
  VaultRegistryRow,
  VaultTemplate,
  FanoutQueryOptions,
  FanoutResult,
  SkippedVault,
  WhereClause,
} from './types.js'

/** Keyring collection name — a provisioned encrypted vault has a row here. */
const KEYRING_COLLECTION = '_keyring'

export class VaultGroup<T> {
  constructor(
    /** @internal */ readonly db: Noydb,
    /** @internal */ readonly name: string,
    /** @internal */ readonly registry: Collection<VaultRegistryRow>,
    /** @internal */ readonly sharding: ShardingConfig<T>,
    /** @internal */ readonly template: VaultTemplate,
  ) {}

  /** Deterministic vault name for a partition key, namespaced by the group. */
  shardVaultId(partitionKey: string): string {
    return `${this.name}--${partitionKey}`
  }

  /** All registry rows (hydrates the registry collection first). */
  async allRows(): Promise<VaultRegistryRow[]> {
    await this.registry.list()
    return this.registry.query().toArray()
  }

  /** Open an existing shard and apply the template. */
  async openShard(partitionKey: string): Promise<Vault> {
    const vault = await this.db.openVault(this.shardVaultId(partitionKey))
    this.template.configure(vault)
    return vault
  }

  /**
   * Idempotently provision a shard for `partitionKey`. Returns the
   * configured vault handle.
   *
   * - row + vault present → no-op, return handle
   * - row present, vault gone → ShardProvisioningError
   * - row absent (vault present or not) → open-or-create, configure, write row
   */
  async createShard(partitionKey: string): Promise<Vault> {
    const vaultId = this.shardVaultId(partitionKey)
    const row = await this.registry.get(partitionKey)
    const provisioned = await this.db._shardVaultProvisioned(vaultId)

    if (row && !provisioned) throw new ShardProvisioningError(vaultId, partitionKey)
    if (row && provisioned) return this.openShard(partitionKey)

    // Row absent → create (or reconcile a provisioned-but-unregistered vault).
    const vault = await this.db.openVault(vaultId)
    this.template.configure(vault)
    await this.registry.put(partitionKey, {
      vaultId,
      partitionKey,
      templateName: this.sharding.vaultTemplate,
      schemaVersion: this.template.version,
      createdAt: Date.now(),
    })
    return vault
  }

  /** Drill down to a single shard's full Collection API. Throws if the shard is unknown. */
  async shard(partitionKey: string): Promise<Vault> {
    const row = await this.registry.get(partitionKey)
    if (!row) throw new UnknownShardError(partitionKey, this.name)
    return this.openShard(partitionKey)
  }

  /** A sharded view over one logical collection across all shards. */
  collection<R = T>(collectionName: string): ShardedCollection<T, R> {
    return new ShardedCollection<T, R>(this, collectionName)
  }
}

export class ShardedCollection<T, R = T> {
  constructor(
    private readonly group: VaultGroup<T>,
    private readonly collectionName: string,
  ) {}

  /** Route a write to the shard owning `keyOf(record)`. */
  async put(id: string, record: T): Promise<void> {
    const key = this.group.sharding.keyOf(record)
    const row = await this.group.registry.get(key)
    let vault: Vault
    if (!row) {
      if (this.group.sharding.autoCreate === false) {
        throw new UnknownShardError(key, this.group.name)
      }
      vault = await this.group.createShard(key)
    } else {
      vault = await this.group.openShard(key)
    }
    await vault.collection<T>(this.collectionName).put(id, record as T)
  }

  /** Begin a cross-shard fan-out query. */
  query(): ShardedQuery<T, R> {
    return new ShardedQuery<T, R>(this.group, this.collectionName, [])
  }
}

export class ShardedQuery<T, R = T> {
  constructor(
    private readonly group: VaultGroup<T>,
    private readonly collectionName: string,
    private readonly clauses: readonly WhereClause[],
  ) {}

  where(field: string, op: WhereClause['op'], value: unknown): ShardedQuery<T, R> {
    return new ShardedQuery<T, R>(this.group, this.collectionName, [
      ...this.clauses,
      { field, op, value },
    ])
  }

  /** Fan out across eligible shards and merge results. */
  async toArray(options: FanoutQueryOptions = {}): Promise<FanoutResult<R>> {
    const rows = await this.group.allRows()
    const skipped: SkippedVault[] = []
    const eligible: VaultRegistryRow[] = []
    for (const row of rows) {
      if (options.minVersion !== undefined && row.schemaVersion < options.minVersion) {
        skipped.push({ vaultId: row.vaultId, reason: 'schema-drift' })
      } else {
        eligible.push(row)
      }
    }

    const across = await this.group.db.queryAcross<R[]>(
      eligible.map((r) => r.vaultId),
      async (vault) => {
        this.group.template.configure(vault)
        const coll = vault.collection<R>(this.collectionName)
        await coll.list() // hydrate the in-memory cache before the sync query
        let q = coll.query()
        for (const c of this.clauses) q = q.where(c.field, c.op, c.value)
        return q.toArray()
      },
      { concurrency: options.concurrency ?? 1 },
    )

    const results: R[] = []
    for (const r of across) {
      if (r.error) skipped.push({ vaultId: r.vault, reason: 'error', error: r.error })
      else results.push(...r.result)
    }
    return { results, skippedVaults: skipped }
  }
}
```

- [ ] **Step 4: Write `federation/index.ts`**

Create `packages/hub/src/federation/index.ts`:

```ts
export { VaultGroup, ShardedCollection, ShardedQuery } from './vault-group.js'
export type {
  VaultTemplate,
  VaultRegistryRow,
  ShardingConfig,
  VaultGroupOptions,
  FanoutQueryOptions,
  FanoutResult,
  SkippedVault,
} from './types.js'
```

- [ ] **Step 5: Wire `Noydb` (noydb.ts)**

Add the import near the other internal imports at the top of `packages/hub/src/noydb.ts`:

```ts
import { VaultGroup } from './federation/vault-group.js'
import type { VaultTemplate, VaultGroupOptions } from './federation/types.js'
import { VaultTemplateNotFoundError } from './errors.js'
```
(If `errors.js` is already imported, add `VaultTemplateNotFoundError` to that existing import list instead of adding a new line.)

Add the field alongside the other `private readonly … = new Map()` declarations (near line 168):

```ts
  private readonly vaultTemplates = new Map<string, VaultTemplate>()
```

Add these three methods to the `Noydb` class (place them just after `queryAcross`):

```ts
  /**
   * Register a shard schema blueprint. `createShard` / `openVaultGroup`
   * stamp shards from the named template. See the MVF design spec.
   */
  withVaultTemplate(name: string, template: VaultTemplate): void {
    this.vaultTemplates.set(name, template)
  }

  /**
   * Open a VaultGroup — transparent routing over per-partition shard
   * vaults, with shard discovery backed by the supplied `vault-registry`
   * collection.
   */
  async openVaultGroup<T>(name: string, opts: VaultGroupOptions<T>): Promise<VaultGroup<T>> {
    if (this.closed) throw new ValidationError('Instance is closed')
    const template = this.vaultTemplates.get(opts.sharding.vaultTemplate)
    if (!template) throw new VaultTemplateNotFoundError(opts.sharding.vaultTemplate)
    return new VaultGroup<T>(this, name, opts.registry, opts.sharding, template)
  }

  /**
   * @internal — true when an encrypted shard vault is provisioned
   * (its keyring exists in the store).
   */
  async _shardVaultProvisioned(vaultId: string): Promise<boolean> {
    return (await this.options.store.list(vaultId, '_keyring')).length > 0
  }
```
(If `ValidationError` is not already imported in `noydb.ts`, add it — it is used elsewhere in the file, so it should already be present.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/federation-vault-group.test.ts`
Expected: PASS — all five tests in the "template + createShard" describe block.

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/federation/ packages/hub/src/noydb.ts packages/hub/__tests__/federation-vault-group.test.ts
git commit -m "feat(federation): VaultGroup + withVaultTemplate + openVaultGroup + idempotent createShard"
```

---

## Task 4: Write routing (put)

**Files:**
- Test: `packages/hub/__tests__/federation-vault-group.test.ts` (append a describe block)
- (Implementation already written in Task 3 — this task adds coverage and confirms behavior.)

- [ ] **Step 1: Write the failing test**

Append to `packages/hub/__tests__/federation-vault-group.test.ts`:

```ts
describe('VaultGroup — write routing', () => {
  it('put auto-creates the shard and routes the write (autoCreate default on)', async () => {
    const h = await harness()
    await h.firm.collection('invoices').put('inv-1', { clientId: 'acme', amount: 1200, status: 'open' })

    // The shard exists and holds the record.
    const acme = await h.firm.shard('acme')
    const rec = await acme.collection<Invoice>('invoices').get('inv-1')
    expect(rec).toEqual({ clientId: 'acme', amount: 1200, status: 'open' })

    // A registry row was created.
    expect(await h.registry.get('acme')).not.toBeNull()
  })

  it('put routes records with different partition keys to different shards', async () => {
    const h = await harness()
    await h.firm.collection('invoices').put('inv-a', { clientId: 'acme', amount: 100, status: 'open' })
    await h.firm.collection('invoices').put('inv-b', { clientId: 'bigco', amount: 200, status: 'open' })

    const acme = await h.firm.shard('acme')
    const bigco = await h.firm.shard('bigco')
    expect(await acme.collection<Invoice>('invoices').get('inv-b')).toBeNull()
    expect(await bigco.collection<Invoice>('invoices').get('inv-a')).toBeNull()
    expect(await bigco.collection<Invoice>('invoices').get('inv-b')).not.toBeNull()
  })

  it('put throws UnknownShardError when autoCreate is off and the shard is unknown', async () => {
    const h = await harness({ autoCreate: false })
    await expect(
      h.firm.collection('invoices').put('inv-1', { clientId: 'acme', amount: 1, status: 'open' }),
    ).rejects.toBeInstanceOf(UnknownShardError)
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/federation-vault-group.test.ts -t "write routing"`
Expected: PASS (the routing logic from Task 3 already implements this).

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/federation-vault-group.test.ts
git commit -m "test(federation): write-routing coverage (autoCreate, multi-shard, UnknownShardError)"
```

---

## Task 5: Fan-out read + minSchemaVersion guard

**Files:**
- Test: `packages/hub/__tests__/federation-vault-group.test.ts` (append a describe block)
- (Implementation already written in Task 3.)

- [ ] **Step 1: Write the failing test**

Append to `packages/hub/__tests__/federation-vault-group.test.ts`:

```ts
describe('VaultGroup — fan-out read', () => {
  it('merges matching records across shards', async () => {
    const h = await harness()
    const inv = h.firm.collection('invoices')
    await inv.put('a-1', { clientId: 'acme', amount: 100, status: 'overdue' })
    await inv.put('a-2', { clientId: 'acme', amount: 200, status: 'open' })
    await inv.put('b-1', { clientId: 'bigco', amount: 300, status: 'overdue' })

    const out = await h.firm.collection('invoices').query().where('status', '==', 'overdue').toArray()
    expect(out.skippedVaults).toEqual([])
    expect(out.results.map((r) => r.amount).sort((x, y) => x - y)).toEqual([100, 300])
  })

  it('minVersion guard moves behind-version shards into skippedVaults (not results)', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })

    // Register template v1, create shard A at v1.
    db.withVaultTemplate('client-template', {
      version: 1,
      configure(vault: Vault) { vault.collection<Invoice>('invoices') },
    })
    const stateVault = await db.openVault('state')
    const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
    let firm = await db.openVaultGroup<Invoice>('firm-clients', {
      registry, sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
    })
    await firm.collection('invoices').put('a-1', { clientId: 'acme', amount: 100, status: 'overdue' })

    // Re-register the template at v2 and create shard B at v2.
    db.withVaultTemplate('client-template', {
      version: 2,
      configure(vault: Vault) { vault.collection<Invoice>('invoices') },
    })
    firm = await db.openVaultGroup<Invoice>('firm-clients', {
      registry, sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
    })
    await firm.collection('invoices').put('b-1', { clientId: 'bigco', amount: 300, status: 'overdue' })

    const out = await firm.collection('invoices').query()
      .where('status', '==', 'overdue')
      .toArray({ minVersion: 2 })

    expect(out.results.map((r) => r.amount)).toEqual([300]) // only the v2 shard
    expect(out.skippedVaults).toEqual([
      { vaultId: 'firm-clients--acme', reason: 'schema-drift' },
    ])
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @noy-db/hub exec vitest run __tests__/federation-vault-group.test.ts -t "fan-out read"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/federation-vault-group.test.ts
git commit -m "test(federation): cross-shard fan-out merge + minVersion schema-drift guard"
```

---

## Task 6: Public exports

**Files:**
- Modify: `packages/hub/src/index.ts`

- [ ] **Step 1: Add exports**

Add to `packages/hub/src/index.ts` (near the other capability exports):

```ts
export { VaultGroup, ShardedCollection, ShardedQuery } from './federation/index.js'
export type {
  VaultTemplate,
  VaultRegistryRow,
  ShardingConfig,
  VaultGroupOptions,
  FanoutQueryOptions,
  FanoutResult,
  SkippedVault,
} from './federation/index.js'
export { UnknownShardError, ShardProvisioningError, VaultTemplateNotFoundError } from './errors.js'
```
(If `./errors.js` is already partially re-exported, add the three names to that existing export list rather than duplicating.)

- [ ] **Step 2: Verify the package builds and types resolve**

Run: `pnpm --filter @noy-db/hub exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the full hub test suite to confirm no regressions**

Run: `pnpm --filter @noy-db/hub test`
Expected: PASS (existing suite green + the new federation file).

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/index.ts
git commit -m "feat(federation): export VaultGroup public surface from @noy-db/hub"
```

---

## Task 7: Subsystem doc + features.yaml registration

**Files:**
- Create: `docs/subsystems/vault-group.md`
- Modify: `features.yaml`
- Modify: `SUBSYSTEMS.md`

- [ ] **Step 1: Write the subsystem doc**

Create `docs/subsystems/vault-group.md`:

```markdown
# Vault Group — Multi-Vault Partition Federation (MVF)

> Status: **preview** (milestone 16 MVP). Spec:
> `docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md`.

## Overview

`VaultGroup` routes records across many per-partition shard vaults behind a
single entry point, while every shard stays an ordinary noy-db vault within its
small-DB ceiling. Shard discovery is backed by a `vault-registry` collection
that is the single source of truth (no dependency on `listAccessibleVaults`, so
it works on every backend).

## API

```ts
db.withVaultTemplate('client-template', {
  version: 1,
  configure(vault) { vault.collection('invoices') },
})

const state = await db.openVault('state')
const firm = await db.openVaultGroup('firm-clients', {
  registry: state.collection('vault-registry'),
  sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template', autoCreate: true },
})

// Transparent write — routed (and auto-provisioned) by partition key.
await firm.collection('invoices').put('inv-1', { clientId: 'acme', amount: 1200, status: 'open' })

// Cross-shard fan-out read.
const { results, skippedVaults } = await firm.collection('invoices')
  .query().where('status', '==', 'overdue').toArray({ minVersion: 1 })

// Drill down to one shard's full Collection API.
const acme = await firm.shard('acme')
```

## Guarantees & limits

- The operator `Noydb` instance owns its shards (`createShard` provisions them).
- `createShard` is idempotent; a registry row pointing at a missing vault raises
  `ShardProvisioningError` rather than recreating it.
- The `minVersion` guard pre-filters shards by their registry-recorded
  `schemaVersion`; behind-version shards land in `skippedVaults`, never mixed
  into `results`.
- **Out of scope (this MVP):** cross-shard joins, push-model cross-vault
  derivations (Insight Vault), reactive `queryAcrossLive`, `aggregateAcross`,
  and the fleet schema-migration runner. See the spec's deferred-items list.
```

- [ ] **Step 2: Add the SUBSYSTEMS.md catalog row**

In `SUBSYSTEMS.md`, change the catalog heading `## The 23 subsystems` to `## The 24 subsystems`, and add this row under the appropriate cluster table (Cluster — write/mutate or a federation cluster; place it after row 23):

```markdown
| 24 | `@noy-db/hub` (core) | Multi-vault partition federation — `db.openVaultGroup()` transparent shard routing + `vault-registry` source-of-truth + `minVersion` fan-out guard (MVP) | — | `queryAcross`, `permissions` |
```

- [ ] **Step 3: Add the features.yaml entry**

Add to `features.yaml` under the `features:` list (follow the existing core-feature shape — `cluster`, `spec`, `subsystem_doc`, `factory` are required):

```yaml
  - id: vault-group-federation
    name: Multi-vault partition federation (VaultGroup)
    cluster: core
    spec: docs/subsystems/vault-group.md#overview
    subsystem_doc: docs/subsystems/vault-group.md
    package: '@noy-db/hub'
    factory: null
    status: preview
    experimental: true
    showcases: []
    recipes: []
    playground_pages: []
    diagrams: []
    invariants:
      - 'vault-registry is the single source of truth for shard discovery'
      - 'createShard is idempotent; row-without-vault raises ShardProvisioningError'
      - 'minVersion guard pre-filters shards by registry schemaVersion (no silent shape-mixing)'
      - 'join.ts partitionScope seam is untouched (crossShardJoin deferred)'
    related: [permissions, transferable-partition]
```
(Use `related` entries that exist in the registry; if `transferable-partition` is not a registered id, drop it and keep `[permissions]`. Verify ids with `grep "id:" features.yaml`.)

- [ ] **Step 4: Validate the registry**

Run: `node scripts/validate-features.mjs`
Expected: PASS — `✓ features.yaml` (no schema, path, or spec-anchor failures).

If it fails on `status` enum, confirm `status: preview` (allowed values: stable | preview | planned). If it fails on a missing `related` id, remove the offending id.

- [ ] **Step 5: Commit**

```bash
git add docs/subsystems/vault-group.md features.yaml SUBSYSTEMS.md
git commit -m "docs(federation): vault-group subsystem doc + features.yaml registration + catalog row"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full hub suite + typecheck + feature validation**

Run:
```bash
pnpm --filter @noy-db/hub exec tsc --noEmit
pnpm --filter @noy-db/hub test
node scripts/validate-features.mjs
```
Expected: all PASS.

- [ ] **Step 2: Confirm the join.ts invariant is untouched**

Run: `git diff --stat main -- packages/hub/src/query/join.ts`
Expected: no output (file unchanged) — the deferred-work boundary held.

- [ ] **Step 3: Commit any remaining changes (if a formatter touched files)**

```bash
git add -A
git commit -m "chore(federation): formatting/lint fixups" || echo "nothing to commit"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** withVaultTemplate (T3), createShard idempotency 4-case matrix (T3), VaultGroup/openVaultGroup (T3), write routing + autoCreate (T4), fan-out + skippedVaults + minVersion guard (T5), shard() drill-down (T3 helper + T4 usage), registry-as-source-of-truth (harness uses a real `vault-registry` collection), errors (T2). Deferred items are explicitly documented, not implemented.
- **`shard()` drill-down** is exercised indirectly by the write-routing tests (`h.firm.shard('acme')`). If you want an explicit unit, add an `it('shard() throws UnknownShardError for an unknown key')` asserting `rejects.toBeInstanceOf(UnknownShardError)`.
- **Type consistency:** `VaultRegistryRow` fields (`vaultId`, `partitionKey`, `templateName`, `schemaVersion`, `createdAt`) are identical in types.ts, the createShard writer, the test rows, and the guard reader. `ShardedCollection.query()` → `ShardedQuery` → `toArray(FanoutQueryOptions)` → `FanoutResult`.
- **Encrypted-vault assumption:** `_shardVaultProvisioned` keys off the `_keyring` row, which only exists for encrypted vaults. The MVP assumes the DEK/grant model (encrypt !== false). Document if a plaintext path is ever needed (out of scope).
```
