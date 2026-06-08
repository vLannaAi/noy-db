# StateManagement Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize the federation control plane as a `StateManagementVault` owning the shard `registry`, a per-version `schema-manifest`, and an append-only `deployment-events` log, auto-wired into `openVaultGroup`.

**Architecture:** A new `StateManagementVault` class wraps a reserved fleet-wide vault (`__noydb_state__`) opened through the existing `Noydb.openVault` credential path. It exposes typed, idempotently-configured accessors for three collections. `openVaultGroup`'s `registry` option becomes optional; when omitted, the state vault's registry is used. Registry record ids are group-qualified to prevent cross-group collisions. Schema manifests carry a deterministic fingerprint over the serializable blueprint captured from `VaultTemplate.configure` via a recording proxy.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node `crypto.subtle` (already used in hub for SHA-256), existing hub primitives (`immutableGuard`, `queryAcross`, `VaultGroup`).

**Spec:** `docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md`

---

## File Structure

- **Create** `packages/hub/src/federation/state-vault.ts` — `StateManagementVault` class + accessors.
- **Create** `packages/hub/src/federation/schema-manifest.ts` — blueprint capture (recording proxy) + canonical fingerprint.
- **Modify** `packages/hub/src/federation/types.ts` — add `group` to `VaultRegistryRow`; add `SchemaManifestRow`, `DeploymentEvent`, `CapturedBlueprint`.
- **Modify** `packages/hub/src/federation/vault-group.ts` — group-qualified `registryId`; record manifest + event on `createShard`.
- **Modify** `packages/hub/src/noydb.ts` — make `openVaultGroup`'s `registry` optional; auto-open the state vault; expose `_openStateVault` internal.
- **Modify** `packages/hub/src/errors.ts` — add `ReservedVaultNameError`.
- **Modify** `packages/hub/src/federation/index.ts` + `packages/hub/src/index.ts` — export new public types/class.
- **Create** `packages/hub/__tests__/federation-state-vault.test.ts` — all new tests.
- **Modify** `features.yaml` — registry entry for the control-plane capability.

---

## Task 1: Add new federation types

**Files:**
- Modify: `packages/hub/src/federation/types.ts`

- [ ] **Step 1: Add the `group` field and new interfaces**

In `packages/hub/src/federation/types.ts`, add `group` to `VaultRegistryRow` (after `createdAt`) and append the new interfaces. First add the import at the top with the other type imports:

```ts
import type { IndexDef } from '../indexing/eager-indexes.js'
```

Modify `VaultRegistryRow`:

```ts
/** One row in the StateManagement `vault-registry` collection. */
export interface VaultRegistryRow {
  readonly vaultId: string
  readonly partitionKey: string
  readonly templateName: string
  readonly schemaVersion: number
  readonly createdAt: number
  /** Which VaultGroup this shard belongs to (registry is shared across groups). */
  readonly group: string
}
```

Append at end of file:

```ts
/** A serializable blueprint captured from a VaultTemplate.configure run. */
export interface CapturedBlueprint {
  /** Sorted collection names declared by the template. */
  readonly collections: string[]
  /** Per-collection index defs (key order canonicalized). */
  readonly indexes: Record<string, IndexDef[]>
  /** Collections that declared `persistJsonSchema: true`. */
  readonly persistJsonSchema: string[]
}

/** One row in the StateManagement `schema-manifest` collection, keyed by `${templateName}:${version}`. */
export interface SchemaManifestRow {
  readonly templateName: string
  readonly version: number
  readonly collections: string[]
  readonly indexes: Record<string, IndexDef[]>
  readonly persistJsonSchema: string[]
  /** sha256 over the canonicalized serializable blueprint. */
  readonly fingerprint: string
  readonly recordedAt: number
}

/** One row in the append-only StateManagement `deployment-events` collection. */
export interface DeploymentEvent {
  readonly id: string
  readonly ts: number
  readonly type: 'shard-created' | 'manifest-recorded' | 'group-opened'
  readonly group: string
  readonly vaultId?: string
  readonly templateName?: string
  readonly version?: number
  readonly actor?: string
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/hub && npx tsc --noEmit`
Expected: PASS (no usages yet; types compile).

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/federation/types.ts
git commit -m "feat(federation): add group field + StateManagement control-plane types"
```

---

## Task 2: Blueprint capture + fingerprint (recording proxy)

**Files:**
- Create: `packages/hub/src/federation/schema-manifest.ts`
- Test: `packages/hub/__tests__/federation-state-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/federation-state-vault.test.ts` with this first block:

```ts
import { describe, it, expect } from 'vitest'
import { captureBlueprint, fingerprintBlueprint } from '../src/federation/schema-manifest.js'
import type { Vault } from '../src/vault.js'

describe('captureBlueprint', () => {
  it('records declared collections + indexes deterministically', () => {
    const configure = (v: Vault) => {
      v.collection('invoices', { indexes: [{ field: 'buyerId' }] })
      v.collection('ledger')
    }
    const bp = captureBlueprint(configure)
    expect(bp.collections).toEqual(['invoices', 'ledger'])
    expect(bp.indexes.invoices).toEqual([{ field: 'buyerId' }])
  })

  it('produces a stable fingerprint across two runs', async () => {
    const configure = (v: Vault) => { v.collection('a', { indexes: [{ field: 'x' }] }) }
    const f1 = await fingerprintBlueprint(captureBlueprint(configure))
    const f2 = await fingerprintBlueprint(captureBlueprint(configure))
    expect(f1).toBe(f2)
    expect(f1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes the fingerprint when an index is added', async () => {
    const a = (v: Vault) => { v.collection('a') }
    const b = (v: Vault) => { v.collection('a', { indexes: [{ field: 'x' }] }) }
    const fa = await fingerprintBlueprint(captureBlueprint(a))
    const fb = await fingerprintBlueprint(captureBlueprint(b))
    expect(fa).not.toBe(fb)
  })

  it('does NOT change the fingerprint when only a validator changes (documented boundary)', async () => {
    const a = (v: Vault) => { v.collection('a', { schema: { '~standard': { version: 1, vendor: 'z', validate: (x: unknown) => ({ value: x }) } } } as never) }
    const b = (v: Vault) => { v.collection('a', { schema: { '~standard': { version: 1, vendor: 'z', validate: (_x: unknown) => ({ value: 42 }) } } } as never) }
    const fa = await fingerprintBlueprint(captureBlueprint(a))
    const fb = await fingerprintBlueprint(captureBlueprint(b))
    expect(fa).toBe(fb)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t captureBlueprint`
Expected: FAIL — `captureBlueprint` / `fingerprintBlueprint` not found.

- [ ] **Step 3: Write the implementation**

Create `packages/hub/src/federation/schema-manifest.ts`:

```ts
/**
 * @category capability
 * StateManagement Vault — schema blueprint capture + deterministic
 * fingerprint. See
 * docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md.
 */
import type { Vault } from '../vault.js'
import type { IndexDef } from '../indexing/eager-indexes.js'
import { sha256Hex } from '../crypto.js'
import type { CapturedBlueprint } from './types.js'

interface RecordedCollection {
  name: string
  indexes: IndexDef[]
  persistJsonSchema: boolean
}

/**
 * Run `configure` against a recording proxy that intercepts
 * `collection(name, opts)` calls and captures the declared blueprint.
 * The proxy delegates every other access to a no-op stub so unrelated
 * `configure` calls (guards, blob setup) do not throw — only the
 * declared collections/indexes feed the fingerprint.
 */
export function captureBlueprint(configure: (vault: Vault) => void): CapturedBlueprint {
  const recorded: RecordedCollection[] = []
  // Minimal chainable stub returned by intercepted collection() — supports
  // the fluent calls a template might make without affecting the blueprint.
  const collectionStub = new Proxy(
    {},
    {
      get: () => () => collectionStub,
    },
  )
  const proxy = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'collection') {
          return (name: string, opts?: { indexes?: IndexDef[]; persistJsonSchema?: boolean }) => {
            recorded.push({
              name,
              indexes: opts?.indexes ?? [],
              persistJsonSchema: !!opts?.persistJsonSchema,
            })
            return collectionStub
          }
        }
        // Any other vault method/property: a no-op callable that returns the proxy.
        return () => proxy
      },
    },
  ) as unknown as Vault

  configure(proxy)

  const sorted = [...recorded].sort((a, b) => a.name.localeCompare(b.name))
  const indexes: Record<string, IndexDef[]> = {}
  const persistJsonSchema: string[] = []
  for (const c of sorted) {
    indexes[c.name] = c.indexes
    if (c.persistJsonSchema) persistJsonSchema.push(c.name)
  }
  return {
    collections: sorted.map((c) => c.name),
    indexes,
    persistJsonSchema: persistJsonSchema.sort(),
  }
}

/** Canonical JSON: object keys sorted recursively so the bytes are stable. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}

/** sha256 (hex) over the canonicalized serializable blueprint. Uses the shared hub helper. */
export async function fingerprintBlueprint(bp: CapturedBlueprint): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonical(bp)))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t captureBlueprint`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/federation/schema-manifest.ts packages/hub/__tests__/federation-state-vault.test.ts
git commit -m "feat(federation): blueprint capture + deterministic schema fingerprint"
```

---

## Task 3: `ReservedVaultNameError`

**Files:**
- Modify: `packages/hub/src/errors.ts`
- Test: `packages/hub/__tests__/federation-state-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `federation-state-vault.test.ts`:

```ts
import { ReservedVaultNameError } from '../src/errors.js'

describe('ReservedVaultNameError', () => {
  it('carries the offending name', () => {
    const e = new ReservedVaultNameError('__noydb_state__')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ReservedVaultNameError')
    expect(e.message).toContain('__noydb_state__')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t ReservedVaultNameError`
Expected: FAIL — `ReservedVaultNameError` not exported.

- [ ] **Step 3: Add the error class**

In `packages/hub/src/errors.ts`, after the `StoreCapabilityError` class (around line 414+), add a class following the existing `NoydbError` subclass pattern:

```ts
/** Thrown when a reserved internal vault name (e.g. `__noydb_state__`) is used as a group name or partition key. */
export class ReservedVaultNameError extends NoydbError {
  constructor(name: string) {
    super(`"${name}" is a reserved internal vault name and cannot be used as a group name or partition key`)
    this.name = 'ReservedVaultNameError'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t ReservedVaultNameError`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/errors.ts packages/hub/__tests__/federation-state-vault.test.ts
git commit -m "feat(federation): ReservedVaultNameError for reserved internal vault names"
```

---

## Task 4: `StateManagementVault` class

**Files:**
- Create: `packages/hub/src/federation/state-vault.ts`
- Test: `packages/hub/__tests__/federation-state-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `federation-state-vault.test.ts` (reuse the `memory()`/`createNoydb` setup copied from `federation-vault-group.test.ts`; the import block at the top of that file shows the exact imports — `createNoydb` from `../src/noydb.js`, the `memory()` store helper):

```ts
import { createNoydb } from '../src/noydb.js'
import { StateManagementVault } from '../src/federation/state-vault.js'
// `memory()` — copy the in-memory NoydbStore helper from federation-vault-group.test.ts

describe('StateManagementVault', () => {
  it('configures registry/manifest/event accessors idempotently', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    const sv = await StateManagementVault.open(db)
    const sv2 = await StateManagementVault.open(db) // idempotent
    await sv.registry.put('g--p1', {
      vaultId: 'g--p1', partitionKey: 'p1', templateName: 't', schemaVersion: 1, createdAt: 1, group: 'g',
    })
    expect((await sv2.registry.get('g--p1'))?.partitionKey).toBe('p1')
  })

  it('appendEvent writes append-only events with unique ids', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    const sv = await StateManagementVault.open(db)
    await sv.appendEvent({ type: 'group-opened', group: 'g' })
    await sv.appendEvent({ type: 'group-opened', group: 'g' })
    const events = await sv.deploymentEvents.query().toArray()
    expect(events.length).toBe(2)
    expect(events[0].id).not.toBe(events[1].id)
  })

  it('recordManifest stores a fingerprinted row keyed by template:version', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    const sv = await StateManagementVault.open(db)
    await sv.recordManifest('client', { version: 1, configure: (v) => { v.collection('invoices') } })
    const row = await sv.schemaManifest.get('client:1')
    expect(row?.collections).toEqual(['invoices'])
    expect(row?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t StateManagementVault`
Expected: FAIL — `StateManagementVault` not found.

- [ ] **Step 3: Write the implementation**

Create `packages/hub/src/federation/state-vault.ts`:

```ts
/**
 * @category capability
 * StateManagement Vault — federation control plane (registry +
 * schema-manifest + append-only deployment-events). See
 * docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md.
 */
import type { Noydb } from '../noydb.js'
import type { Collection } from '../collection.js'
import type { VaultRegistryRow, SchemaManifestRow, DeploymentEvent, VaultTemplate } from './types.js'
import { captureBlueprint, fingerprintBlueprint } from './schema-manifest.js'

/** Reserved fleet-wide control-plane vault name. */
export const STATE_VAULT_NAME = '__noydb_state__'

const REGISTRY = 'vault-registry'
const MANIFEST = 'schema-manifest'
const EVENTS = 'deployment-events'

export class StateManagementVault {
  private constructor(
    readonly registry: Collection<VaultRegistryRow>,
    readonly schemaManifest: Collection<SchemaManifestRow>,
    readonly deploymentEvents: Collection<DeploymentEvent>,
  ) {}

  /** Idempotently open the reserved state vault and bind the three control-plane collections. */
  static async open(db: Noydb): Promise<StateManagementVault> {
    const vault = await db.openVault(STATE_VAULT_NAME)
    return new StateManagementVault(
      vault.collection<VaultRegistryRow>(REGISTRY),
      vault.collection<SchemaManifestRow>(MANIFEST),
      vault.collection<DeploymentEvent>(EVENTS),
    )
  }

  /**
   * Append a deployment event. Append-only is enforced here: only `put`
   * with a fresh unique id is ever issued; no update/delete is exposed.
   * Best-effort — callers treat failures as non-fatal.
   */
  async appendEvent(event: Omit<DeploymentEvent, 'id' | 'ts'> & { ts?: number }): Promise<void> {
    const ts = event.ts ?? Date.now()
    const id = `${ts}-${event.type}-${event.group}-${event.vaultId ?? ''}-${crypto.randomUUID()}`
    await this.deploymentEvents.put(id, { ...event, id, ts })
  }

  /**
   * Ensure a manifest row exists for `(templateName, template.version)`.
   * Idempotent: re-recording the same version overwrites with an
   * identical fingerprint. Returns the fingerprint.
   */
  async recordManifest(templateName: string, template: VaultTemplate): Promise<string> {
    const bp = captureBlueprint(template.configure)
    const fingerprint = await fingerprintBlueprint(bp)
    await this.schemaManifest.put(`${templateName}:${template.version}`, {
      templateName,
      version: template.version,
      collections: bp.collections,
      indexes: bp.indexes,
      persistJsonSchema: bp.persistJsonSchema,
      fingerprint,
      recordedAt: Date.now(),
    })
    return fingerprint
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t StateManagementVault`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/federation/state-vault.ts packages/hub/__tests__/federation-state-vault.test.ts
git commit -m "feat(federation): StateManagementVault class with registry/manifest/event accessors"
```

---

## Task 5: Group-qualified registry id in `VaultGroup`

**Files:**
- Modify: `packages/hub/src/federation/vault-group.ts`
- Test: `packages/hub/__tests__/federation-state-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `federation-state-vault.test.ts`:

```ts
import type { VaultRegistryRow as VRow } from '../src/federation/index.js'

describe('group-qualified registry ids', () => {
  it('keys registry rows by `${group}--${partitionKey}` so two groups do not collide', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    db.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    const sv = await StateManagementVault.open(db)
    const groupA = await db.openVaultGroup<{ pk: string }>('groupA', {
      registry: sv.registry,
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    const groupB = await db.openVaultGroup<{ pk: string }>('groupB', {
      registry: sv.registry,
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    await groupA.createShard('shared')
    await groupB.createShard('shared')
    expect((await sv.registry.get('groupA--shared'))?.group).toBe('groupA')
    expect((await sv.registry.get('groupB--shared'))?.group).toBe('groupB')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t "group-qualified"`
Expected: FAIL — both shards write to bare id `shared`, so `groupA--shared` is `undefined`.

- [ ] **Step 3: Add `registryId` and update all registry access points**

In `packages/hub/src/federation/vault-group.ts`, add a private helper after `shardVaultId` (around line 70):

```ts
  /** Group-qualified registry record id (avoids cross-group key collisions). */
  private registryId(partitionKey: string): string {
    return `${this.name}${SHARD_SEPARATOR}${partitionKey}`
  }
```

Update `createShard` (line 95 + 104) to use it and write the `group` field:

```ts
    const vaultId = this.shardVaultId(partitionKey)
    const row = await this.registry.get(this.registryId(partitionKey))
    const provisioned = await this.db._shardVaultProvisioned(vaultId)

    if (row && !provisioned) throw new ShardProvisioningError(vaultId, partitionKey)
    if (row && provisioned) return this.openShard(partitionKey)

    const vault = await this.db.openVault(vaultId)
    this.template.configure(vault)
    await this.registry.put(this.registryId(partitionKey), {
      vaultId,
      partitionKey,
      templateName: this.sharding.vaultTemplate,
      schemaVersion: this.template.version,
      createdAt: Date.now(),
      group: this.name,
    })
    return vault
```

Update `shard` (line 121): `const row = await this.registry.get(this.registryId(partitionKey))`.

Update `ShardedCollection.put` (line 165): `const row = await this.group.registry.get(this.group.registryId(key))` — and change `registryId` from `private` to internal visibility so `ShardedCollection` can call it. Match the existing pattern: the other `VaultGroup` members `ShardedCollection` uses (`registry`, `sharding`, `name`, `createShard`, `openShard`, `template`, `db`) are marked `/** @internal */ readonly` or public methods. Make `registryId` `/** @internal */` and non-private:

```ts
  /** @internal — group-qualified registry record id (avoids cross-group key collisions). */
  registryId(partitionKey: string): string {
    return `${this.name}${SHARD_SEPARATOR}${partitionKey}`
  }
```

- [ ] **Step 4: Run the new test + the full federation suite**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t "group-qualified" && npx vitest run __tests__/federation-vault-group.test.ts __tests__/federation-query-aggregate.test.ts`
Expected: the new test PASSES; the existing federation tests still PASS (they pass their own `registry` and use a single group, so qualification is transparent).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-state-vault.test.ts
git commit -m "feat(federation): group-qualified registry ids + group field on shard rows"
```

---

## Task 6: Auto-wire the state vault into `openVaultGroup` + record manifest/event on createShard

**Files:**
- Modify: `packages/hub/src/federation/types.ts` (make `registry` optional)
- Modify: `packages/hub/src/noydb.ts`
- Modify: `packages/hub/src/federation/vault-group.ts`
- Test: `packages/hub/__tests__/federation-state-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `federation-state-vault.test.ts`:

```ts
import { STATE_VAULT_NAME } from '../src/federation/state-vault.js'

describe('openVaultGroup auto-wiring', () => {
  it('auto-opens the state vault when registry is omitted, recording row + manifest + event', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    db.withVaultTemplate('client', { version: 2, configure: (v) => { v.collection('invoices') } })
    const group = await db.openVaultGroup<{ pk: string }>('firm', {
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 'client' },
    })
    await group.createShard('acme')

    const sv = await StateManagementVault.open(db)
    expect((await sv.registry.get('firm--acme'))?.group).toBe('firm')
    expect((await sv.schemaManifest.get('client:2'))?.collections).toEqual(['invoices'])
    const events = await sv.deploymentEvents.query().toArray()
    expect(events.some((e) => e.type === 'shard-created' && e.vaultId === 'firm--acme')).toBe(true)
  })

  it('still honors an explicitly-passed registry (backward-compat)', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    db.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    const sv = await StateManagementVault.open(db)
    const group = await db.openVaultGroup<{ pk: string }>('g', {
      registry: sv.registry,
      sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' },
    })
    await group.createShard('p1')
    expect((await sv.registry.get('g--p1'))?.partitionKey).toBe('p1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t "auto-wiring"`
Expected: FAIL — `registry` is required (TS) / no manifest+event recorded.

- [ ] **Step 3a: Make `registry` optional in the options type**

In `packages/hub/src/federation/types.ts`, change `VaultGroupOptions`:

```ts
/** Options for `Noydb.openVaultGroup`. */
export interface VaultGroupOptions<T> {
  /**
   * The `vault-registry` collection (source of truth for shard discovery).
   * Optional: when omitted, the reserved StateManagement vault's registry
   * is auto-opened and used.
   */
  readonly registry?: Collection<VaultRegistryRow>
  readonly sharding: ShardingConfig<T>
}
```

- [ ] **Step 3b: Auto-open the state vault in `openVaultGroup`**

In `packages/hub/src/noydb.ts`, replace the body of `openVaultGroup` (lines 1015-1023):

```ts
  async openVaultGroup<T>(name: string, opts: VaultGroupOptions<T>): Promise<VaultGroup<T>> {
    if (this.closed) throw new ValidationError('Instance is closed')
    if (name === STATE_VAULT_NAME) throw new ReservedVaultNameError(name)
    const template = this.vaultTemplates.get(opts.sharding.vaultTemplate)
    if (!template) throw new VaultTemplateNotFoundError(opts.sharding.vaultTemplate)
    const { VaultGroup } = await import('./federation/vault-group.js')
    const { StateManagementVault } = await import('./federation/state-vault.js')
    // Managed control plane when no explicit registry is supplied.
    const stateVault = opts.registry ? undefined : await StateManagementVault.open(this)
    const registry = opts.registry ?? stateVault!.registry
    const group = new VaultGroup<T>(this, name, registry, opts.sharding, template)
    if (stateVault) {
      group._attachStateVault(stateVault)
      await stateVault.recordManifest(opts.sharding.vaultTemplate, template)
      await stateVault.appendEvent({ type: 'group-opened', group: name })
    }
    return group
  }
```

Add the imports at the top of `noydb.ts` (with the other `./errors.js` and federation imports):

```ts
import { ReservedVaultNameError } from './errors.js'
import { STATE_VAULT_NAME } from './federation/state-vault.js'
```

Note: `STATE_VAULT_NAME` is a plain string constant (safe to import eagerly; it does not pull the federation chunk's heavy graph — but if bundle-size CI flags it, inline the literal `'__noydb_state__'` here and keep the constant for the class).

- [ ] **Step 3c: Let `VaultGroup` hold the state vault and record on `createShard`**

In `packages/hub/src/federation/vault-group.ts`, add a field + attach method on `VaultGroup` (after the constructor):

```ts
  /** @internal — set when the group is managed (no explicit registry). */
  private stateVault: import('./state-vault.js').StateManagementVault | undefined

  /** @internal */
  _attachStateVault(sv: import('./state-vault.js').StateManagementVault): void {
    this.stateVault = sv
  }
```

In `createShard`, after the successful `this.registry.put(...)` and before `return vault`, add a best-effort event (manifest is already recorded at group-open, but record it defensively too):

```ts
    if (this.stateVault) {
      try {
        await this.stateVault.appendEvent({
          type: 'shard-created',
          group: this.name,
          vaultId,
          templateName: this.sharding.vaultTemplate,
          version: this.template.version,
        })
      } catch {
        /* best-effort: event logging never fails the shard write */
      }
    }
```

- [ ] **Step 4: Run the new tests + full federation suite**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts __tests__/federation-vault-group.test.ts __tests__/federation-query-aggregate.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/noydb.ts packages/hub/src/federation/types.ts packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-state-vault.test.ts
git commit -m "feat(federation): auto-wire StateManagement vault into openVaultGroup"
```

---

## Task 7: Reserved-name rejection for group names and partition keys

**Files:**
- Modify: `packages/hub/src/federation/vault-group.ts`
- Test: `packages/hub/__tests__/federation-state-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { ReservedVaultNameError } from '../src/errors.js'

describe('reserved-name rejection', () => {
  it('rejects the reserved state-vault name as a group name', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    db.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    await expect(
      db.openVaultGroup('__noydb_state__', { sharding: { keyOf: (r: { pk: string }) => r.pk, vaultTemplate: 't' } }),
    ).rejects.toBeInstanceOf(ReservedVaultNameError)
  })

  it('rejects the reserved name as a partition key', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    db.withVaultTemplate('t', { version: 1, configure: (v) => { v.collection('items') } })
    const group = await db.openVaultGroup<{ pk: string }>('g', { sharding: { keyOf: (r) => r.pk, vaultTemplate: 't' } })
    await expect(group.createShard('__noydb_state__')).rejects.toBeInstanceOf(ReservedVaultNameError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t "reserved-name"`
Expected: the group-name case already passes (added in Task 6); the partition-key case FAILS.

- [ ] **Step 3: Reject the reserved name in `assertSafePartitionKey`**

In `packages/hub/src/federation/vault-group.ts`, add the import and a check. At the top, import the constant and error:

```ts
import { ShardProvisioningError, UnknownShardError, ValidationError, ReservedVaultNameError } from '../errors.js'
import { STATE_VAULT_NAME } from './state-vault.js'
```

In `assertSafePartitionKey`, after the empty-string check, add:

```ts
  if (partitionKey === STATE_VAULT_NAME) {
    throw new ReservedVaultNameError(partitionKey)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t "reserved-name"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/federation/vault-group.ts packages/hub/__tests__/federation-state-vault.test.ts
git commit -m "feat(federation): reject reserved state-vault name as group/partition key"
```

---

## Task 8: Drift detection via manifest fingerprint

**Files:**
- Modify: `packages/hub/src/federation/state-vault.ts`
- Test: `packages/hub/__tests__/federation-state-vault.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
describe('manifest drift detection', () => {
  it('detects when a configure shape no longer matches a recorded manifest version', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    const sv = await StateManagementVault.open(db)
    await sv.recordManifest('client', { version: 1, configure: (v) => { v.collection('invoices') } })
    // Same declared version, different shape → drift.
    const drift = await sv.detectDrift('client', { version: 1, configure: (v) => { v.collection('invoices'); v.collection('extra') } })
    expect(drift).toBe(true)
    const ok = await sv.detectDrift('client', { version: 1, configure: (v) => { v.collection('invoices') } })
    expect(ok).toBe(false)
  })

  it('treats a missing manifest as drift', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    const sv = await StateManagementVault.open(db)
    expect(await sv.detectDrift('client', { version: 9, configure: (v) => { v.collection('x') } })).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t "drift"`
Expected: FAIL — `detectDrift` not found.

- [ ] **Step 3: Add `detectDrift`**

In `packages/hub/src/federation/state-vault.ts`, add to the class:

```ts
  /**
   * True when `template`'s serializable shape does not match the recorded
   * manifest for `(templateName, template.version)`. A missing manifest is
   * treated as drift (nothing to verify against).
   */
  async detectDrift(templateName: string, template: VaultTemplate): Promise<boolean> {
    const row = await this.schemaManifest.get(`${templateName}:${template.version}`)
    if (!row) return true
    const current = await fingerprintBlueprint(captureBlueprint(template.configure))
    return current !== row.fingerprint
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t "drift"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/federation/state-vault.ts packages/hub/__tests__/federation-state-vault.test.ts
git commit -m "feat(federation): manifest fingerprint drift detection"
```

---

## Task 9: Optional immutableGuard hardening test (append-only)

**Files:**
- Test: `packages/hub/__tests__/federation-state-vault.test.ts`

- [ ] **Step 1: Write the test**

Append (asserts the documented optional-hardening path; reuses the public `immutableGuard` export):

```ts
import { immutableGuard } from '../src/index.js'
import { RecordLockedError } from '../src/errors.js'

describe('deployment-events optional WORM hardening', () => {
  it('rejects mutation of an event when the consumer adds immutableGuard', async () => {
    const db = createNoydb({
      store: memory(),
      encrypt: false,
      guardStrategies: [immutableGuard({ collection: 'deployment-events', appendOnly: true })],
    })
    const sv = await StateManagementVault.open(db)
    await sv.appendEvent({ type: 'group-opened', group: 'g' })
    const [ev] = await sv.deploymentEvents.query().toArray()
    await expect(sv.deploymentEvents.put(ev.id, { ...ev, group: 'tampered' })).rejects.toBeInstanceOf(RecordLockedError)
  })
})
```

- [ ] **Step 2: Run the test**

Run: `cd packages/hub && npx vitest run __tests__/federation-state-vault.test.ts -t "WORM hardening"`
Expected: PASS. (If guard wiring needs the vault opened with the strategy, confirm `StateManagementVault.open` → `db.openVault` inherits instance `guardStrategies`; it does, via `_initGuards` in `noydb.ts:545`.)

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/federation-state-vault.test.ts
git commit -m "test(federation): optional immutableGuard WORM hardening for deployment-events"
```

---

## Task 10: Public exports

**Files:**
- Modify: `packages/hub/src/federation/index.ts`
- Modify: `packages/hub/src/index.ts`

- [ ] **Step 1: Export from the federation barrel**

In `packages/hub/src/federation/index.ts`, add:

```ts
export { StateManagementVault, STATE_VAULT_NAME } from './state-vault.js'
export { captureBlueprint, fingerprintBlueprint } from './schema-manifest.js'
```

And extend the `export type { … } from './types.js'` block with:

```ts
  SchemaManifestRow,
  DeploymentEvent,
  CapturedBlueprint,
```

- [ ] **Step 2: Re-export from the hub root**

In `packages/hub/src/index.ts`, alongside the existing `export type { VaultGroup, ShardedCollection, ShardedQuery } from './federation/index.js'` (line 301) and the federation type block (lines ~310-315), add:

```ts
export { StateManagementVault, STATE_VAULT_NAME } from './federation/index.js'
export type { SchemaManifestRow, DeploymentEvent, CapturedBlueprint } from './federation/index.js'
```

And add `ReservedVaultNameError` to the existing federation error re-export line (where `UnknownShardError, ShardProvisioningError, VaultTemplateNotFoundError` are exported from `./errors.js`):

```ts
export { UnknownShardError, ShardProvisioningError, VaultTemplateNotFoundError, ReservedVaultNameError } from './errors.js'
```

- [ ] **Step 3: Typecheck + full hub test suite**

Run: `cd packages/hub && npx tsc --noEmit && npx vitest run`
Expected: PASS (all hub tests green, including the existing federation suites untouched).

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/federation/index.ts packages/hub/src/index.ts
git commit -m "feat(federation): export StateManagementVault + control-plane types"
```

---

## Task 11: Control-plane showcase

**Files:**
- Create: `showcases/src/100-state-management-vault.showcase.test.ts`

The existing federation entry (`features.yaml` → `vault-group-federation`) references its capabilities through **showcases** (98, 99). The features.yaml `showcases[].path` values are validated to exist, so the registry update in Task 12 needs a real showcase file. Mirror the header style of `showcases/src/98-vault-group-federation.showcase.test.ts`.

- [ ] **Step 1: Write the showcase (it doubles as an integration test)**

Create `showcases/src/100-state-management-vault.showcase.test.ts`:

```ts
/**
 * Showcase 100 — StateManagement Vault (federation control plane)
 *
 * What you'll learn
 * ─────────────────
 * `openVaultGroup(name)` with no explicit `registry` auto-opens a reserved,
 * fleet-wide control-plane vault (`__noydb_state__`) that OWNS three things:
 *   1. vault-registry    — the authoritative shard list (group-qualified ids)
 *   2. schema-manifest   — a per-(template,version) blueprint + fingerprint
 *   3. deployment-events — an append-only operational log
 *
 * Why it matters
 * ──────────────
 * The control plane removes the hand-rolled `stateVault.collection('n')`
 * boilerplate, makes the registry portable (works on backends where
 * `listAccessibleVaults()` is unavailable), and gives drift detection +
 * an audit trail for fleet operations — the foundation the schema-migration
 * runner (next slice) builds on.
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → vault-group-federation (showcase 100)
 * spec → docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, StateManagementVault } from '@noy-db/hub'

// Minimal in-memory store: copy the `memory()` helper used by the other
// showcases (see 98-vault-group-federation.showcase.test.ts) or import the
// shared showcase store helper if one exists in showcases/src.

describe('Showcase 100 — StateManagement Vault', () => {
  it('auto-opens the control plane and records registry + manifest + event', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    db.withVaultTemplate('client', { version: 1, configure: (v) => { v.collection('invoices', { indexes: [{ field: 'buyerId' }] }) } })

    const firm = await db.openVaultGroup<{ buyerId: string }>('firm', {
      sharding: { keyOf: (r) => r.buyerId, vaultTemplate: 'client' },
    })
    await firm.collection('invoices').put('inv-1', { buyerId: 'acme' })

    const state = await StateManagementVault.open(db)
    // 1. authoritative, group-qualified registry row
    expect((await state.registry.get('firm--acme'))?.group).toBe('firm')
    // 2. fingerprinted manifest for the template version
    const manifest = await state.schemaManifest.get('client:1')
    expect(manifest?.collections).toEqual(['invoices'])
    expect(manifest?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    // 3. append-only deployment log captured the shard creation
    const events = await state.deploymentEvents.query().toArray()
    expect(events.some((e) => e.type === 'shard-created' && e.vaultId === 'firm--acme')).toBe(true)
  })

  it('detects schema drift against a recorded manifest', async () => {
    const db = createNoydb({ store: memory(), encrypt: false })
    const state = await StateManagementVault.open(db)
    await state.recordManifest('client', { version: 1, configure: (v) => { v.collection('invoices') } })
    expect(await state.detectDrift('client', { version: 1, configure: (v) => { v.collection('invoices'); v.collection('audit') } })).toBe(true)
  })
})
```

- [ ] **Step 2: Run the showcase**

Run: `cd showcases && npx vitest run src/100-state-management-vault.showcase.test.ts`
Expected: PASS (2 tests). If `memory()` is undefined, copy the helper from `showcases/src/98-vault-group-federation.showcase.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add showcases/src/100-state-management-vault.showcase.test.ts
git commit -m "test(showcase): StateManagement Vault control-plane showcase (100)"
```

---

## Task 12: `features.yaml` registry update

**Files:**
- Modify: `features.yaml`

- [ ] **Step 1: Append the showcase to the existing federation entry**

The StateManagement Vault is the same subsystem/milestone as `vault-group-federation` (entry at `features.yaml:1096`). Append showcase 100 to that entry's `showcases:` list (after the `99-vault-group-live-aggregate` item) — matching the exact existing key shape:

```yaml
      - id: 100-state-management-vault
        path: showcases/src/100-state-management-vault.showcase.test.ts
```

- [ ] **Step 2: Reference the new spec in the entry**

Add the design spec to the same entry so the spec↔artefact graph links it. Locate the `spec:` / `subsystem_doc:` keys of the `vault-group-federation` entry and add a sibling note. The existing entry uses `spec: docs/subsystems/vault-group.md#overview`. Add a short "Control plane" section to `docs/subsystems/vault-group.md` linking to `docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md`, so the subsystem doc covers the new capability (the entry already points at that subsystem doc):

Run: `rg -n "## " docs/subsystems/vault-group.md | tail` to find the end, then append:

```markdown

## Control plane — StateManagement Vault

`openVaultGroup(name)` (no explicit `registry`) auto-opens the reserved
`__noydb_state__` vault, which owns the `vault-registry`, a per-version
`schema-manifest` (blueprint + fingerprint), and an append-only
`deployment-events` log. See the design spec:
`docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md`.
```

- [ ] **Step 3: Run the spec-coverage check**

Run: `rg -n "spec.coverage|features.yaml|spec:check" package.json .github/workflows/*.yml | head` then run the validation script it names (e.g. `npm run spec:check` or the node script under `scripts/`). If none runs locally, note it and rely on CI.
Expected: no dangling-ref failure; showcase path resolves.

- [ ] **Step 4: Commit**

```bash
git add features.yaml docs/subsystems/vault-group.md
git commit -m "chore(features): register StateManagement Vault control-plane capability"
```

---

## Final verification

- [ ] **Run the full hub suite + typecheck + lint**

Run: `cd packages/hub && npx tsc --noEmit && npx vitest run && cd ../.. && npm run lint 2>/dev/null || true`
Expected: all green; no new lint errors in the touched files.

- [ ] **Confirm bundle-chunk isolation unchanged**

The federation module is dynamically `import()`-ed in `openVaultGroup`; the only new eager import in `noydb.ts` is the `STATE_VAULT_NAME` string constant + `ReservedVaultNameError`. If `bundle-check` (known to drift on main per project notes) flags a real new leak of the federation chunk into core, inline the `'__noydb_state__'` literal in `noydb.ts` instead of importing the constant. Verify by checking the core entry does not statically pull `state-vault.js`.

Run: `rg -n "state-vault" packages/hub/dist/index.js 2>/dev/null | head` (after a build) — expect no static reference in the core chunk.
