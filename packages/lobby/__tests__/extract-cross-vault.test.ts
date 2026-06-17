/**
 * walkCrossVaultClosure — cross-vault FK closure planner (Task 1)
 * extractCrossVaultPartition — multi-compartment bundle emitter (Task 2)
 * Plan: docs/superpowers/plans/2026-06-17-fr2-cross-vault-extraction.md §Task 1, §Task 2
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import {
  walkCrossVaultClosure,
  extractCrossVaultPartition,
  describeCrossVaultExtraction,
  type CrossVaultRef,
} from '../src/interchange/extract-cross-vault.js'
import {
  readNoydbBundleManifest,
  readMultiVaultBundleCompartment,
  adoptPartition,
  createOwnerOnAdoptedPartition,
} from '@noy-db/hub/bundle'
import type { Noydb } from '@noy-db/hub'

// ─── Fixture ──────────────────────────────────────────────────────────────────

interface Entity { id: string; name: string }
interface Bill { id: string; entityId: string }

async function buildFixture(): Promise<{
  dirDb: Noydb
  clientDb: Noydb
  openVault: (name: string) => ReturnType<Noydb['openVault']>
}> {
  const dirDb = await createNoydb({ store: memory(), user: 'admin', secret: 'dir-secret' })
  const clientDb = await createNoydb({ store: memory(), user: 'admin', secret: 'client-secret' })

  // --- directory vault ---
  const dirVault = await dirDb.openVault('directory')
  const entities = dirVault.collection<Entity>('entities')
  await entities.put('e1', { id: 'e1', name: 'Acme' })
  await entities.put('e2', { id: 'e2', name: 'Beta' })
  await entities.put('e3', { id: 'e3', name: 'Gamma' })

  // --- client vault ---
  const clientVault = await clientDb.openVault('client')
  const bills = clientVault.collection<Bill>('bills')
  await bills.put('b1', { id: 'b1', entityId: 'e1' })
  await bills.put('b2', { id: 'b2', entityId: 'e2' })

  const openVault = (name: string) => {
    if (name === 'directory') return dirDb.openVault('directory')
    if (name === 'client') return clientDb.openVault('client')
    throw new Error(`Unknown vault: ${name}`)
  }

  return { dirDb, clientDb, openVault }
}

const refs: CrossVaultRef[] = [
  { from: { collection: 'bills', field: 'entityId' }, to: { vault: 'directory', collection: 'entities' } },
]

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('walkCrossVaultClosure', () => {
  it('primary closure contains all bills; directory closure contains only FK-reachable entities (e1, e2 — NOT e3)', async () => {
    const { openVault } = await buildFixture()

    const plan = await walkCrossVaultClosure(openVault, {
      seed: { vault: 'client', seeds: { bills: () => true } },
      crossVaultRefs: refs,
    })

    // primary vault closure has both bills
    expect(plan.perVaultClosure.get('client')?.get('bills')?.size).toBe(2)

    // directory closure has EXACTLY e1, e2 — NOT e3
    const dirEntities = plan.perVaultClosure.get('directory')?.get('entities')
    expect(dirEntities).toBeDefined()
    expect([...(dirEntities ?? [])].sort()).toEqual(['e1', 'e2'])

    // no dangling refs
    expect(plan.dangling).toEqual([])
  })

  it('bill referencing a missing entity lands in dangling', async () => {
    const { clientDb, openVault } = await buildFixture()

    // add a bill pointing to a non-existent e9
    const clientVault = await clientDb.openVault('client')
    await clientVault.collection<Bill>('bills').put('b9', { id: 'b9', entityId: 'e9' })

    const plan = await walkCrossVaultClosure(openVault, {
      seed: { vault: 'client', seeds: { bills: () => true } },
      crossVaultRefs: refs,
    })

    const dangling = plan.dangling
    expect(dangling.length).toBeGreaterThan(0)
    expect(dangling).toContainEqual({ vault: 'directory', collection: 'entities', id: 'e9' })
  })

  it('perVaultSeeds contains entries for both client and directory', async () => {
    const { openVault } = await buildFixture()

    const plan = await walkCrossVaultClosure(openVault, {
      seed: { vault: 'client', seeds: { bills: () => true } },
      crossVaultRefs: refs,
    })

    expect(plan.perVaultSeeds.has('client')).toBe(true)
    expect(plan.perVaultSeeds.has('directory')).toBe(true)
  })

  it('rejects a non-id cross-vault to.field (not yet supported)', async () => {
    const { openVault } = await buildFixture()

    await expect(walkCrossVaultClosure(openVault, {
      seed: { vault: 'client', seeds: { bills: () => true } },
      crossVaultRefs: [{ from: { collection: 'bills', field: 'entityId' }, to: { vault: 'directory', collection: 'entities', field: 'slug' } }],
    })).rejects.toThrow(/not supported|to\.field/i)
  })
})

// ─── Task 2: extractCrossVaultPartition ───────────────────────────────────────

describe('extractCrossVaultPartition', () => {
  it('emits a multi-compartment bundle with roleTag-labelled compartments and per-vault transfer keys', async () => {
    const { openVault } = await buildFixture()

    const res = await extractCrossVaultPartition(openVault, {
      seed: { vault: 'client', seeds: { bills: () => true } },
      crossVaultRefs: refs,
      compartmentMeta: {
        client: { roleTag: 'shard' },
        directory: { roleTag: 'pool', disclose: { name: true } },
      },
    })

    // manifest has 2 compartments with the correct roleTags
    const manifest = await readNoydbBundleManifest(res.bundle)
    expect(manifest.map((m) => m.roleTag).sort()).toEqual(['pool', 'shard'])

    // both vault names present in transferKeys
    expect(Object.keys(res.transferKeys).sort()).toEqual(['client', 'directory'])
  })

  it('directory compartment contains EXACTLY e1,e2 (not e3) after adopt + createOwner', async () => {
    const { openVault } = await buildFixture()

    const res = await extractCrossVaultPartition(openVault, {
      seed: { vault: 'client', seeds: { bills: () => true } },
      crossVaultRefs: refs,
      compartmentMeta: {
        client: { roleTag: 'shard' },
        directory: { roleTag: 'pool', disclose: { name: true } },
      },
    })

    // extract the directory compartment bytes
    const manifest = await readNoydbBundleManifest(res.bundle)
    const dirEntry = manifest.find((m) => m.roleTag === 'pool')!
    expect(dirEntry).toBeDefined()
    const dirBytes = readMultiVaultBundleCompartment(res.bundle, dirEntry.handle)

    // adopt into a fresh in-memory store
    const destStore = memory()
    await adoptPartition(dirBytes, {
      transferKey: res.transferKeys['directory']!,
      destinationStore: destStore,
      vaultName: 'dir-adopted',
    })
    await createOwnerOnAdoptedPartition(destStore, 'dir-adopted', {
      userId: 'u',
      passphrase: 'correct-horse-battery-staple',
      transferKey: res.transferKeys['directory']!,
    })

    // open the adopted vault and verify EXACTLY e1,e2 (not e3)
    const dest = await (
      await createNoydb({ store: destStore, user: 'u', secret: 'correct-horse-battery-staple' })
    ).openVault('dir-adopted')
    const adoptedEntities = (await dest.collection('entities').list())
      .map((r: Record<string, unknown>) => r['id'] as string)
      .sort()
    expect(adoptedEntities).toEqual(['e1', 'e2'])
  })

  it('throws CrossVaultDanglingRefError when a referenced entity is missing', async () => {
    const { clientDb, openVault } = await buildFixture()

    // add a bill pointing to a non-existent e9
    const clientVault = await clientDb.openVault('client')
    await clientVault.collection<Bill>('bills').put('b9', { id: 'b9', entityId: 'e9' })

    await expect(
      extractCrossVaultPartition(openVault, {
        seed: { vault: 'client', seeds: { bills: () => true } },
        crossVaultRefs: refs,
      }),
    ).rejects.toThrow('cross-vault extraction')
  })
})

// ─── Task 2 (FR-8): schemaVersion stamping ───────────────────────────────────

describe('extractCrossVaultPartition — schemaVersion stamp (FR-8)', () => {
  it('stamps each compartment schemaVersion from the source vault fence', async () => {
    const { openVault } = await buildFixture()

    const res = await extractCrossVaultPartition(openVault, {
      seed: { vault: 'client', seeds: { bills: () => true } },
      crossVaultRefs: refs,
      compartmentMeta: {
        client: { roleTag: 'shard' },
        directory: { roleTag: 'pool' },
      },
    })

    const manifest = await readNoydbBundleManifest(res.bundle)

    // check both compartments have schemaVersion stamped equal to the source vault fence
    for (const entry of manifest) {
      const vaultName = entry.roleTag === 'shard' ? 'client' : 'directory'
      const v = await openVault(vaultName)
      const fence = await v.schemaFenceState()
      expect(entry.schemaVersion).toBe(fence.currentSchemaVersion)
    }
  })
})

// ─── Task 3: describeCrossVaultExtraction ─────────────────────────────────────

describe('describeCrossVaultExtraction', () => {
  it('returns per-compartment preview for both vaults; directory entities count is 2 (e1,e2); no dangling', async () => {
    const { openVault } = await buildFixture()

    const preview = await describeCrossVaultExtraction(openVault, {
      seed: { vault: 'client', seeds: { bills: () => true } },
      crossVaultRefs: refs,
    })

    // both vaults appear in compartments
    expect(preview.compartments.map((c) => c.vault).sort()).toEqual(['client', 'directory'])

    // directory compartment preview shows exactly 2 entities (e1,e2 — NOT e3)
    const dir = preview.compartments.find((c) => c.vault === 'directory')!
    expect(dir).toBeDefined()
    const entitiesEntry = dir.preview.byCollection.find((b) => b.name === 'entities')!
    expect(entitiesEntry).toBeDefined()
    expect(entitiesEntry.recordCount).toBe(2)

    // no dangling refs
    expect(preview.dangling).toEqual([])
  })

  it('surfaces dangling refs in preview.dangling without throwing (b9→e9 missing-ref)', async () => {
    const { clientDb, openVault } = await buildFixture()

    // add a bill pointing to a non-existent e9
    const clientVault = await clientDb.openVault('client')
    await clientVault.collection<Bill>('bills').put('b9', { id: 'b9', entityId: 'e9' })

    // describeCrossVaultExtraction MUST RESOLVE (not throw) even with dangling refs —
    // that is its core contract: surface, don't throw (contrast: extractCrossVaultPartition throws)
    const preview = await describeCrossVaultExtraction(openVault, {
      seed: { vault: 'client', seeds: { bills: () => true } },
      crossVaultRefs: refs,
    })

    // dangling is non-empty and contains the missing e9 reference
    expect(preview.dangling.length).toBeGreaterThan(0)
    expect(preview.dangling).toContainEqual({ vault: 'directory', collection: 'entities', id: 'e9' })

    // compartments are still returned (non-empty) even with dangling refs
    expect(preview.compartments.length).toBeGreaterThan(0)
  })
})
