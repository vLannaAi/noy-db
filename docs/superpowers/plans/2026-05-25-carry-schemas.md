# `carrySchemas` Opt-In — Implementation Plan (Plan 6, #204)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `carrySchemas?: boolean` (default `false`) to `extractPartition` (#204). When on, the persisted JSON Schemas (`_schemas/<collection>`) for the closure collections are re-keyed under the destination DEKs and carried in the bundle; `adoptPartition` imports them so the recipient can validate records and run `noydb describe` against the same schema the source enforced.

**Architecture:** `_schemas/<collection>` is an AES-GCM envelope encrypted under that collection's DEK — identical shape to a data record. So re-keying a schema is the same `decrypt(srcDEK) → encrypt(destDEK)` step `reKeyClosure` already does, using the destination DEKs it already mints. Carried schemas ride in the dump's `_internal._schemas` map (`VaultBackup._internal`, the same channel `vault.dump()` uses). `adoptPartition` gains a step to import `backup._internal` into the destination store (today it only imports `collections`).

**Tech Stack:** TypeScript, Vitest, `@noy-db/hub` (bundle subsystem, `crypto.ts`, `persisted-schemas`).

---

## Epic context

**Plan 6 of the Transferable Partition Bundles epic.** Plans 1–5 (the full extract→adopt→own ceremony) are in PR #225. `carrySchemas` is an independent opt-in on top of `extractPartition`/`adoptPartition`; default-off preserves Plan 3b/4 behaviour exactly. `carryLedger` (#205) is a separate plan (hash-chain handling is riskier).

## Confirmed facts

- `_schemas/<collection>` envelope: `decrypt(env._iv, env._data, collectionDEK)` → JSON; `encrypt(json, dek)` → `{ iv, data }`. Encrypted under the **collection's own DEK** (`persisted-schemas/storage.ts:32-72`). `SCHEMAS_COLLECTION = '_schemas'`.
- `vault.dump()` carries `_schemas` inside `_internal` (a `VaultSnapshot`): `internalSnapshot[SCHEMAS_COLLECTION] = { <collection>: envelope }` (`vault.ts:2546`).
- `reKeyClosure` (Plan 3b) returns `{ collections, deks }` — `deks: Map<collection, CryptoKey>` are the fresh destination DEKs.
- `extractPartition` builds the `VaultBackup` manually (Plan 3b) — `{ ...keyrings: {}, collections }`. Add `_internal` when `carrySchemas`.
- `adoptPartition` (Plan 4) does `saveAll(vaultName, backup.collections)` — does NOT import `_internal` today.
- Source DEK access: `vault._introspectState().getDEK(collection)`; raw envelope: `adapter.get(name, '_schemas', collection)`.

## File structure

- **Modify:** `packages/hub/src/bundle/extract-partition.ts` — `reKeySchemas` helper + `carrySchemas` option.
- **Modify:** `packages/hub/src/bundle/adopt-partition.ts` — import `backup._internal`.
- **Test:** `packages/hub/__tests__/carry-schemas.test.ts`.

---

## Task 1: `reKeySchemas` — re-key closure schemas under destination DEKs

**Files:**
- Modify: `packages/hub/src/bundle/extract-partition.ts`
- Test: `packages/hub/__tests__/carry-schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test file with the `memory()` factory (copy from `__tests__/extract-partition.test.ts`).

```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { ref } from '../src/refs.js'
import { ConflictError } from '../src/errors.js'
import { z } from 'zod'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { reKeySchemas } from '../src/bundle/extract-partition.js'

// ── paste memory() factory ──

interface Client { id: string; name: string; operatorUserId: string }

describe('reKeySchemas', () => {
  it('re-keys persisted schemas for closure collections under the destination DEKs', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')
    // A collection with a persisted JSON schema.
    const clients = company.collection<Client>('clients', {
      schema: z.object({ id: z.string(), name: z.string(), operatorUserId: z.string() }),
      persistJsonSchema: true,
    })
    await clients.put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })

    // Fresh dest DEK for the collection (as reKeyClosure would mint).
    const { generateDEK, decrypt } = await import('../src/crypto.js')
    const destDek = await generateDEK()
    const deks = new Map([['clients', destDek]])

    const schemas = await reKeySchemas(company, new Map([['clients', new Set(['c-1'])]]), deks)

    // The carried _schemas/clients envelope decrypts under the DEST DEK.
    const env = schemas['clients']!
    const json = await decrypt(env._iv, env._data, destDek)
    expect(JSON.parse(json)._noydb_schema).toBe(1)
  })

  it('returns an empty map when no closure collection has a persisted schema', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')
    const clients = company.collection<Client>('clients') // no persistJsonSchema
    await clients.put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })

    const { generateDEK } = await import('../src/crypto.js')
    const schemas = await reKeySchemas(company, new Map([['clients', new Set(['c-1'])]]), new Map([['clients', await generateDEK()]]))
    expect(Object.keys(schemas)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-schemas.test.ts -t "re-keys persisted"`
Expected: FAIL — `reKeySchemas` not exported.

- [ ] **Step 3: Write minimal implementation**

In `extract-partition.ts`, add (after `reKeyClosure`):

```ts
import { SCHEMAS_COLLECTION } from '../persisted-schemas/storage.js'

/**
 * Re-key the persisted JSON Schemas (`_schemas/<collection>`) for the
 * closure collections under the destination DEKs (#204). Returns a
 * `{ collection: envelope }` map for the carried collections that actually
 * have a schema; collections without one are omitted.
 */
export async function reKeySchemas(
  vault: Vault,
  closure: Map<string, Set<string>>,
  destDeks: Map<string, CryptoKey>,
): Promise<Record<string, EncryptedEnvelope>> {
  const { name: vaultName, adapter, getDEK } = vault._introspectState()
  const out: Record<string, EncryptedEnvelope> = {}

  for (const collectionName of closure.keys()) {
    const env = await adapter.get(vaultName, SCHEMAS_COLLECTION, collectionName)
    if (!env) continue // collection has no persisted schema — skip
    const destDek = destDeks.get(collectionName)
    if (!destDek) continue
    const srcDek = await getDEK(collectionName)
    const plaintext = await decrypt(env._iv, env._data, srcDek)
    const { iv, data } = await encrypt(plaintext, destDek)
    out[collectionName] = { ...env, _iv: iv, _data: data }
  }
  return out
}
```

(`SCHEMAS_COLLECTION` import path: verify with `grep -n "SCHEMAS_COLLECTION" packages/hub/src/persisted-schemas/storage.ts` — it's `export const SCHEMAS_COLLECTION = '_schemas'`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-schemas.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/extract-partition.ts packages/hub/__tests__/carry-schemas.test.ts
git commit -m "feat(hub): reKeySchemas — re-key persisted schemas under dest DEKs (#204)"
```

---

## Task 2: `extractPartition({ carrySchemas })` writes `_internal._schemas`

**Files:**
- Modify: `packages/hub/src/bundle/extract-partition.ts`
- Test: `packages/hub/__tests__/carry-schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { extractPartition } from '../src/bundle/extract-partition.js'
import { readNoydbBundle, parseExtractedPartitionBody } from '../src/bundle/bundle.js'
import { z } from 'zod'

async function bundleBody(bytes: Uint8Array) {
  const { dump } = parseExtractedPartitionBody((await readNoydbBundle(bytes)).dumpJson)
  return JSON.parse(dump) as { collections: Record<string, unknown>; _internal?: { _schemas?: Record<string, unknown> } }
}

describe('extractPartition carrySchemas', () => {
  async function setup() {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const company = await db.openVault('demo-co')
    company.collection<Client>('clients', {
      schema: z.object({ id: z.string(), name: z.string(), operatorUserId: z.string() }),
      persistJsonSchema: true,
    })
    await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
    return company
  }

  it('carries _internal._schemas when carrySchemas: true', async () => {
    const company = await setup()
    const { bundleBytes } = await extractPartition(company, { seeds: { clients: () => true }, carrySchemas: true })
    const body = await bundleBody(bundleBytes)
    expect(body._internal?._schemas?.['clients']).toBeTruthy()
  })

  it('omits _internal by default (carrySchemas off)', async () => {
    const company = await setup()
    const { bundleBytes } = await extractPartition(company, { seeds: { clients: () => true } })
    const body = await bundleBody(bundleBytes)
    expect(body._internal).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-schemas.test.ts -t "carries _internal"`
Expected: FAIL — `carrySchemas` option ignored; `_internal` absent.

- [ ] **Step 3: Write minimal implementation**

In `extract-partition.ts`, extend the `extractPartition` options type and the backup build. Change the options type:

```ts
export async function extractPartition(
  vault: Vault,
  opts: WalkClosureOptions & {
    readonly compression?: 'auto' | 'brotli' | 'gzip' | 'none'
    readonly carrySchemas?: boolean
  },
): Promise<ExtractPartitionResult> {
```

After `const { collections, deks } = await reKeyClosure(vault, closure)` add:

```ts
  const internal = opts.carrySchemas
    ? await reKeySchemas(vault, closure, deks)
    : {}
  const hasInternal = Object.keys(internal).length > 0
```

In the `backup` object, conditionally add `_internal`:

```ts
  const backup = {
    _noydb_backup: NOYDB_BACKUP_VERSION,
    _compartment: vaultName,
    _exported_at: new Date().toISOString(),
    _exported_by: '',
    keyrings: {},
    collections,
    ...(hasInternal ? { _internal: { [SCHEMAS_COLLECTION]: internal } } : {}),
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/extract-partition.ts packages/hub/__tests__/carry-schemas.test.ts
git commit -m "feat(hub): extractPartition carrySchemas option → _internal._schemas (#204)"
```

---

## Task 3: `adoptPartition` imports `_internal` (schemas land in the store)

**Files:**
- Modify: `packages/hub/src/bundle/adopt-partition.ts`
- Test: `packages/hub/__tests__/carry-schemas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { adoptPartition } from '../src/bundle/adopt-partition.js'

describe('adoptPartition imports carried schemas', () => {
  it('writes _schemas/<collection> into the destination store', async () => {
    const company = await (async () => {
      const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
      const c = await db.openVault('demo-co')
      c.collection<Client>('clients', {
        schema: z.object({ id: z.string(), name: z.string(), operatorUserId: z.string() }),
        persistJsonSchema: true,
      })
      await c.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
      return c
    })()
    const { bundleBytes, transferKey } = await extractPartition(company, { seeds: { clients: () => true }, carrySchemas: true })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })

    expect(await dest.get('acme', '_schemas', 'clients')).toBeTruthy()
  })

  it('imports nothing extra when the bundle has no _internal (default)', async () => {
    const company = await (async () => {
      const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
      const c = await db.openVault('demo-co')
      await c.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'A', operatorUserId: 'belle' })
      return c
    })()
    const { bundleBytes, transferKey } = await extractPartition(company, { seeds: { clients: () => true } })
    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    expect(await dest.get('acme', '_schemas', 'clients')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-schemas.test.ts -t "writes _schemas"`
Expected: FAIL — `_schemas/clients` is null in the destination (adoptPartition ignores `_internal`).

- [ ] **Step 3: Write minimal implementation**

In `adopt-partition.ts`, in `adoptPartition`, after `await destinationStore.saveAll(vaultName, backup.collections)`, add an `_internal` import. First widen the `backup` parse type:

```ts
  const backup = JSON.parse(dump) as {
    collections: VaultSnapshot
    _internal?: VaultSnapshot
  }
  await destinationStore.saveAll(vaultName, backup.collections)

  // Import carried internal collections (e.g. _schemas from #204 carrySchemas).
  // saveAll only writes data collections; _internal is written per-record.
  if (backup._internal) {
    for (const [collection, records] of Object.entries(backup._internal)) {
      for (const [id, envelope] of Object.entries(records)) {
        await destinationStore.put(vaultName, collection, id, envelope)
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/bundle/adopt-partition.ts packages/hub/__tests__/carry-schemas.test.ts
git commit -m "feat(hub): adoptPartition imports carried _internal collections (#204)"
```

---

## Task 4: End-to-end — recipient loads the carried schema after owning

**Files:**
- Test: `packages/hub/__tests__/carry-schemas.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
import { createOwnerOnAdoptedPartition } from '../src/bundle/adopt-partition.js'
import { loadPersistedSchema } from '../src/persisted-schemas/storage.js'

describe('carrySchemas full ceremony', () => {
  it('recipient owns the partition and the carried schema decrypts under their keyring DEK', async () => {
    const company = await (async () => {
      const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
      const c = await db.openVault('demo-co')
      c.collection<Client>('clients', {
        schema: z.object({ id: z.string(), name: z.string(), operatorUserId: z.string() }),
        persistJsonSchema: true,
      })
      await c.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
      return c
    })()
    const { bundleBytes, transferKey } = await extractPartition(company, { seeds: { clients: () => true }, carrySchemas: true })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
    await createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'belle', passphrase: 'belle-2026', transferKey })

    // Open as the recipient; the clients DEK from their keyring decrypts the schema.
    const recipientDb = await createNoydb({ store: dest, user: 'belle', secret: 'belle-2026' })
    const vault = await recipientDb.openVault('acme')
    const clientsDek = await vault._introspectState().getDEK('clients')
    const schema = await loadPersistedSchema(dest, 'acme', 'clients', clientsDek)
    expect(schema?._noydb_schema).toBe(1)
  })
})
```

- [ ] **Step 2: Run + full verification**

Run: `cd packages/hub && pnpm vitest run __tests__/carry-schemas.test.ts`
Expected: PASS. (If the schema decrypt fails, the carried `_schemas` envelope was re-keyed under a DEK that doesn't match the recipient's keyring entry — verify `reKeySchemas` used the same `destDeks` map `reKeyClosure` returned, which #208 wraps into the keyring.)

Run: `cd packages/hub && pnpm typecheck && pnpm exec eslint src/bundle/extract-partition.ts src/bundle/adopt-partition.ts && pnpm vitest run`
Expected: typecheck clean, lint clean, full suite green.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/carry-schemas.test.ts
git commit -m "test(hub): carrySchemas full ceremony — recipient loads carried schema (#204)"
```

---

## Out of scope (follow-ups)

- **`carryLedger`** (#205) — separate plan; filtering a hash-chain to the closure subset while keeping `verifyBackupIntegrity` valid is the delicate part.
- **Schema migration at extraction** (source v2 → dest v3) — #204 is faithful carry-over only (per the issue's out-of-scope).
- **`noydb describe <bundle> --schemas full`** surfacing carried schemas — CLI follow-up.

## Self-review notes

- **Spec coverage (#204):** `carrySchemas: true` carries `_schemas/<collection>` for every closure collection that has one, re-encrypted under the destination DEK; default `false` produces no `_internal` (back-compat with Plan 3b/4); re-encryption correctness (opens under dest DEK, proven in Tasks 1 + 4). Partial carry (some collections have schemas, others don't) handled by the `if (!env) continue` skip.
- **Type consistency:** `reKeySchemas` returns `Record<collection, EncryptedEnvelope>`; rides in `_internal[SCHEMAS_COLLECTION]`. `adoptPartition` imports any `_internal` collection generically (not schema-specific) — so the same import path serves `carryLedger` (#205) later.
- **DEK alignment:** schemas are re-keyed under the SAME `destDeks` map `reKeyClosure` produces, which #208 wraps into the recipient keyring — so a record and its schema decrypt under the same keyring entry (Task 4 proves it).
```
