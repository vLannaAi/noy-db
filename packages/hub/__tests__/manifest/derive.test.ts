/**
 * Derive the schema manifest from `_schemas/<collection>` + keep it in sync
 * (#941 Task 3).
 *
 * Uses the real `toMemory()` store + `createNoydb`/`openVault` (mirrors
 * `schema-field-ids.test.ts` / `bundle-roundtrip.test.ts`) so DEKs go through
 * the real keyring, not a hand-rolled single-key stub — the manifest's
 * per-collection index is only meaningful when each `_schemas/<collection>`
 * entry is decrypted under its OWN collection's DEK.
 *
 * Tests need a DEK resolver from OUTSIDE the live `Vault` instance (the
 * instance's own resolver is private). `loadKeyring` + `ensureCollectionDEK`
 * (both public exports of `with-party/team/keyring.js`) reconstruct exactly
 * the same MINTING resolver the vault uses internally for a principal's OWN
 * collections — reading the SAME persisted, already-unwrapped
 * `_keyring/<user>` file — so this is a faithful stand-in, not a shortcut
 * around the real crypto. `deriveSchemaManifest` itself now takes a
 * NON-MINTING `LookupDEK` (see `derive.ts`'s doc); a `GetManifestDEK`
 * (minting) function is structurally assignable to that narrower contract
 * (its `Promise<EnclaveKey>` is a subtype of `Promise<EnclaveKey|undefined>`),
 * so `externalGetDEK` below still works as both — the minting behavior only
 * matters when it would actually MINT, and for a full-visibility principal
 * (who already holds every DEK) it never does.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, writeNoydbBundle, readNoydbBundle } from '../../src/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { withTeam } from '../../src/with-party/team/index.js'
import { coordinatedCutover } from '../../src/with-shape/schema-update/index.js'
import { loadFence } from '../../src/with-shape/schema-update/fence.js'
import { SCHEMAS_COLLECTION } from '../../src/with-shape/persisted-schemas/storage.js'
import { loadKeyring, ensureCollectionDEK } from '../../src/with-party/team/keyring.js'
import { loadPersistedSchema } from '../../src/with-shape/persisted-schemas/storage.js'
import { deriveSchemaManifest } from '../../src/with-shape/manifest/derive.js'
import { loadSchemaManifestEntry } from '../../src/with-shape/manifest/storage.js'
import { syncSchemaManifest } from '../../src/with-shape/manifest/sync.js'
import type { GetManifestDEK } from '../../src/with-shape/manifest/storage.js'
import type { NoydbStore } from '../../src/kernel/types.js'
import { toMemory } from '../../../to-memory/src/index.js'

const USER = 'alice'
const SECRET = 'test-pw-12345678'
const VAULT = 'acme'

/** Rebuild the same per-collection DEK resolver the vault used internally (for `userId`/`secret`). */
async function externalGetDEK(
  store: NoydbStore,
  vault: string,
  userId: string = USER,
  secret: string = SECRET,
): Promise<GetManifestDEK> {
  const keyring = await loadKeyring(store, vault, { userId, secret })
  return ensureCollectionDEK(store, vault, keyring)
}

async function openWith(store: NoydbStore, historyOn = false) {
  const db = await createNoydb({
    store, user: USER, secret: SECRET,
    ...(historyOn ? { historyStrategy: withHistory() } : {}),
  })
  return db.openVault(VAULT)
}

describe('deriveSchemaManifest', () => {
  it('2 collections with schemas → entries for both, matching each _schemas/<collection> envelope', async () => {
    const store = toMemory()
    const vault = await openWith(store)
    const Invoice = z.object({ id: z.string(), amount: z.number() })
    const Customer = z.object({ id: z.string(), name: z.string() })
    vault.collection('invoices', { schema: Invoice, persistJsonSchema: true })
    vault.collection('customers', { schema: Customer, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    const getDEK = await externalGetDEK(store, VAULT)
    const { manifest, undecodableCollections } = await deriveSchemaManifest(store, VAULT, getDEK)

    expect(undecodableCollections).toEqual([])
    expect(manifest.v).toBe(1)
    expect(manifest.kind).toBe('schema')
    expect(Object.keys(manifest.collections).sort()).toEqual(['customers', 'invoices'])

    const invEnv = await store.get(VAULT, SCHEMAS_COLLECTION, 'invoices')
    expect(invEnv).not.toBeNull()

    const fence = await loadFence(store, VAULT)
    expect(manifest.generation).toBe(fence.currentSchemaVersion)
    expect(manifest.collections.invoices?.generation).toBe(fence.currentSchemaVersion)
    expect(manifest.collections.invoices?.contentHash).toEqual(expect.any(String))
    expect(manifest.collections.invoices?.fieldIds).toBeDefined()
    expect(Object.keys(manifest.collections.invoices!.fieldIds!).sort()).toEqual(['amount', 'id'])

    // aggregateHash is deterministic — re-deriving without any change yields the same value.
    const again = await deriveSchemaManifest(store, VAULT, getDEK)
    expect(again.manifest.aggregateHash).toBe(manifest.aggregateHash)
  })

  it('empty vault (no schemas) → empty collections + deterministic aggregateHash, no crash', async () => {
    const store = toMemory()
    const vault = await openWith(store)
    vault.collection('invoices') // no schema declared
    await vault._drainPendingSchemaWrites()

    const getDEK = await externalGetDEK(store, VAULT)
    const { manifest, undecodableCollections } = await deriveSchemaManifest(store, VAULT, getDEK)

    expect(undecodableCollections).toEqual([])
    expect(manifest.collections).toEqual({})
    expect(manifest.generation).toBe(0)
    expect(manifest.aggregateHash).toEqual(expect.any(String))

    const again = await deriveSchemaManifest(store, VAULT, getDEK)
    expect(again.manifest.aggregateHash).toBe(manifest.aggregateHash)
  })
})

describe('#941 Task 3: sync wiring — persistSchemaIfNeeded keeps _manifest/schema current', () => {
  it('after declaring a schema, the persisted _manifest/schema record equals a fresh deriveSchemaManifest', async () => {
    const store = toMemory()
    const vault = await openWith(store)
    const Invoice = z.object({ id: z.string(), amount: z.number() })
    vault.collection('invoices', { schema: Invoice, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    const getDEK = await externalGetDEK(store, VAULT)
    const { manifest: derived } = await deriveSchemaManifest(store, VAULT, getDEK)
    const persisted = await loadSchemaManifestEntry(store, VAULT, getDEK)

    expect(persisted).toBeDefined()
    expect(persisted!.manifest).toEqual(derived)
  })

  it('declaring a second collection re-syncs the manifest to include both', async () => {
    const store = toMemory()
    let vault = await openWith(store)
    vault.collection('invoices', { schema: z.object({ id: z.string() }), persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    vault = await openWith(store)
    vault.collection('invoices') // touch — recognizes existing persisted schema
    vault.collection('customers', { schema: z.object({ id: z.string(), name: z.string() }), persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    const getDEK = await externalGetDEK(store, VAULT)
    const { manifest: derived } = await deriveSchemaManifest(store, VAULT, getDEK)
    const persisted = await loadSchemaManifestEntry(store, VAULT, getDEK)

    expect(Object.keys(derived.collections).sort()).toEqual(['customers', 'invoices'])
    expect(persisted!.manifest).toEqual(derived)
  })

  it('#941 flake fix: a stale first snapshot (a sibling _schemas write not yet visible) is caught up by the recheck-loop, not left permanently partial', async () => {
    // Deterministic reproduction of the race that made the AC #2 round-trip
    // test intermittently fail under full-suite parallel load: two
    // collections' `persistSchemaIfNeeded` calls run concurrently, and a
    // `syncSchemaManifest` invocation can `deriveSchemaManifest` BEFORE a
    // sibling collection's `_schemas` write has landed — captures a
    // partial view. Rather than relying on real timing to hit that window,
    // wrap `store.list` so its FIRST call against `_schemas` deterministically
    // returns a snapshot missing 'customers' (as if invoices' sync ran
    // before customers' write committed), while both `_schemas` records are
    // ALREADY fully written underneath. Before the fix, `syncSchemaManifest`
    // would persist that partial (invoices-only) manifest and stop. After
    // the fix, its post-write recheck detects the mismatch and loops until
    // the manifest reflects both collections.
    const store = toMemory()
    const vault = await openWith(store)
    vault.collection('invoices', { schema: z.object({ id: z.string(), amount: z.number() }), persistJsonSchema: true })
    vault.collection('customers', { schema: z.object({ id: z.string(), name: z.string() }), persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()
    // Both _schemas/invoices and _schemas/customers are now fully written and stable.

    const getDEK = await externalGetDEK(store, VAULT)

    let staleServed = false
    const staleFirstList: NoydbStore = {
      ...store,
      async list(v, c) {
        const names = await store.list(v, c)
        if (c === SCHEMAS_COLLECTION && !staleServed) {
          staleServed = true
          return names.filter((n) => n !== 'customers') // simulate: customers' write not yet visible
        }
        return names
      },
    }

    await syncSchemaManifest(staleFirstList, VAULT, { getDEK, lookupDEK: getDEK })

    const { manifest: trueManifest } = await deriveSchemaManifest(store, VAULT, getDEK)
    const persisted = await loadSchemaManifestEntry(store, VAULT, getDEK)

    expect(staleServed).toBe(true) // the stale snapshot really was served once
    expect(Object.keys(trueManifest.collections).sort()).toEqual(['customers', 'invoices'])
    // The persisted manifest must NOT be left stuck on the partial (stale) view.
    expect(persisted?.manifest).toEqual(trueManifest)
  })
})

describe('#941 review CRITICAL fix: a scoped principal must never clobber the pod-wide manifest', () => {
  it('a member granted access to ONLY one collection does not drop siblings from _manifest, and their own DEK lookup never mints sibling DEKs into their keyring', async () => {
    const store = toMemory()
    const owner = await createNoydb({ store, user: 'owner', secret: SECRET, teamStrategy: withTeam() })
    const ownerVault = await owner.openVault(VAULT)
    const Invoice = z.object({ id: z.string(), amount: z.number() })
    const Customer = z.object({ id: z.string(), name: z.string() })
    ownerVault.collection('invoices', { schema: Invoice, persistJsonSchema: true })
    ownerVault.collection('customers', { schema: Customer, persistJsonSchema: true })
    await ownerVault._drainPendingSchemaWrites()

    // Sanity: before granting Bob, the full manifest already has both.
    const ownerGetDEK = await externalGetDEK(store, VAULT, 'owner', SECRET)
    const before = await loadSchemaManifestEntry(store, VAULT, ownerGetDEK)
    expect(Object.keys(before!.manifest.collections).sort()).toEqual(['customers', 'invoices'])

    // Grant Bob access to ONLY 'invoices' — a collection-scoped operator.
    const BOB_SECRET = 'bob-pass-long-enough-1234'
    await owner.grant(VAULT, {
      userId: 'bob', displayName: 'Bob', role: 'operator', secret: BOB_SECRET,
      permissions: { invoices: 'rw' },
    })

    // Bob unlocks and re-declares/changes HIS OWN collection's schema —
    // this fires HIS OWN persistSchemaIfNeeded → syncSchemaManifest, using
    // HIS OWN (scoped) keyring, not the owner's.
    const bobDb = await createNoydb({ store, user: 'bob', secret: BOB_SECRET })
    const bobVault = await bobDb.openVault(VAULT)
    const InvoiceV2 = z.object({ id: z.string(), amount: z.number(), note: z.string() })
    bobVault.collection('invoices', { schema: InvoiceV2, persistJsonSchema: true })
    await bobVault._drainPendingSchemaWrites()

    // Bob's own source-of-truth write DID land (his declare isn't blocked).
    // Deliberately does NOT call `deriveSchemaManifest` with a MINTING
    // resolver here (it would iterate 'customers' too and mint exactly the
    // pollution this test is checking for) — reads only Bob's own
    // legitimately-held 'invoices' DEK directly.
    const bobsOwnGetDEK = await externalGetDEK(store, VAULT, 'bob', BOB_SECRET)
    const bobsInvoicesDek = await bobsOwnGetDEK('invoices')
    const bobsInvoicesSchema = await loadPersistedSchema(store, VAULT, 'invoices', bobsInvoicesDek)
    expect(bobsInvoicesSchema?.fieldIds?.['note']).toBeDefined()

    // CRITICAL: the persisted pod-wide manifest must STILL contain BOTH
    // collections — Bob's incomplete view must not have clobbered 'customers'.
    const afterOwnerGetDEK = await externalGetDEK(store, VAULT, 'owner', SECRET)
    const persisted = await loadSchemaManifestEntry(store, VAULT, afterOwnerGetDEK)
    expect(Object.keys(persisted!.manifest.collections).sort()).toEqual(['customers', 'invoices'])
    // 'customers' entry is untouched by Bob's declare (still the owner's original).
    expect(persisted!.manifest.collections.customers).toEqual(before!.manifest.collections.customers)

    // IMPORTANT 2: Bob's OWN keyring must NOT have gained a 'customers' DEK
    // — the old `ensureCollectionDEK`-based lookup would have minted (and
    // persisted) a garbage one on every declare. Re-load from the store
    // (not the in-memory `bobVault`) to see exactly what's persisted.
    const bobKeyring = await loadKeyring(store, VAULT, { userId: 'bob', secret: BOB_SECRET })
    expect(bobKeyring.deks.has('customers')).toBe(false)
    expect(bobKeyring.deks.has('invoices')).toBe(true) // sanity: Bob DOES have his own scope
    expect(bobKeyring.deks.has('_manifest')).toBe(true) // sanity: system-prefix propagation (grant())
  })
})

describe('#941 AC #2: round-trip identity', () => {
  it('dump → restore into a fresh store → re-derived manifest equals the original', async () => {
    const srcStore = toMemory()
    const srcVault = await openWith(srcStore)
    const Invoice = z.object({ id: z.string(), amount: z.number() })
    const Customer = z.object({ id: z.string(), name: z.string() })
    srcVault.collection('invoices', { schema: Invoice, persistJsonSchema: true })
    srcVault.collection('customers', { schema: Customer, persistJsonSchema: true })
    await srcVault._drainPendingSchemaWrites()

    const srcGetDEK = await externalGetDEK(srcStore, VAULT)
    const { manifest: original } = await deriveSchemaManifest(srcStore, VAULT, srcGetDEK)

    const bundleBytes = await writeNoydbBundle(srcVault, { compression: 'none' })

    const dstStore = toMemory()
    const dstDb = await createNoydb({ store: dstStore, user: USER, secret: SECRET })
    const dstVault = await dstDb.openVault(VAULT)
    const { dumpJson } = await readNoydbBundle(bundleBytes)
    await dstVault.load(dumpJson)

    const dstGetDEK = await externalGetDEK(dstStore, VAULT)
    const { manifest: restored, undecodableCollections } = await deriveSchemaManifest(dstStore, VAULT, dstGetDEK)

    expect(undecodableCollections).toEqual([])
    expect(restored).toEqual(original)

    // The synced `_manifest/schema` record travels too and still matches.
    const persisted = await loadSchemaManifestEntry(dstStore, VAULT, dstGetDEK)
    expect(persisted?.manifest).toEqual(original)
  })
})

describe('#941: field identity survives a rename through coordinatedCutover', () => {
  it("a→b rename: the manifest's fieldIds carries a's id forward under b", async () => {
    const store = toMemory()
    const oldS = z.object({ id: z.string(), a: z.number() })
    const newS = z.object({ id: z.string(), b: z.number() })
    const transform = (d: Record<string, unknown>) => {
      const { a, ...rest } = d as { a?: number }
      return { ...rest, b: a }
    }

    let vault = await openWith(store)
    vault.collection('invoices', { schema: oldS, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    const getDEK = await externalGetDEK(store, VAULT)
    const { manifest: before } = await deriveSchemaManifest(store, VAULT, getDEK)
    const aId = before.collections.invoices?.fieldIds?.['a']
    expect(aId).toBeDefined()

    vault = await openWith(store)
    vault.collection('invoices', {
      schema: newS, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })],
    })
    await vault._drainPendingSchemaWrites()
    await vault.runSchemaCutover()

    // Cutover alone doesn't re-persist `_schemas` — the next declare does
    // (matches schema-field-ids.test.ts's pattern), which is also when the
    // manifest sync fires.
    vault = await openWith(store)
    vault.collection('invoices', { schema: newS, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    const { manifest: after } = await deriveSchemaManifest(store, VAULT, getDEK)
    const bId = after.collections.invoices?.fieldIds?.['b']
    expect(bId).toBeDefined()
    expect(bId).toBe(aId)
    expect(after.collections.invoices?.fieldIds?.['a']).toBeUndefined()

    const persisted = await loadSchemaManifestEntry(store, VAULT, getDEK)
    expect(persisted?.manifest).toEqual(after)
  })
})

describe('#941 AC #5: schema mutations are ledger-audited', () => {
  it('declaring a schema (with the history strategy on) appends an op:migration ledger entry for the manifest sync', async () => {
    const store = toMemory()
    const vault = await openWith(store, /* historyOn */ true)
    vault.collection('invoices', { schema: z.object({ id: z.string(), amount: z.number() }), persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()

    const entries = await vault.ledger().entries({})
    const migrations = entries.filter((e) => e.op === 'migration')
    expect(migrations.length).toBeGreaterThanOrEqual(1)
    expect(migrations[0]?.collection).toBe('_manifest')
    expect(migrations[0]?.id).toBe('schema')
  })

  it('a second, unrelated schema-content-unchanged re-declare does NOT append a second migration entry', async () => {
    const store = toMemory()
    let vault = await openWith(store, true)
    const Invoice = z.object({ id: z.string(), amount: z.number() })
    vault.collection('invoices', { schema: Invoice, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()
    const afterFirst = (await vault.ledger().entries({})).filter((e) => e.op === 'migration').length

    vault = await openWith(store, true)
    vault.collection('invoices', { schema: Invoice, persistJsonSchema: true }) // identical schema — skip path
    await vault._drainPendingSchemaWrites()
    const afterSecond = (await vault.ledger().entries({})).filter((e) => e.op === 'migration').length

    expect(afterSecond).toBe(afterFirst)
  })
})
