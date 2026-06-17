/**
 * walkCrossVaultClosure — cross-vault FK closure planner (Task 1)
 * Plan: docs/superpowers/plans/2026-06-17-fr2-cross-vault-extraction.md §Task 1
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { walkCrossVaultClosure, type CrossVaultRef } from '../src/interchange/extract-cross-vault.js'
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
})
