/**
 * exportSurface / applySurface — scoped extract-project-merge sync (FR-7 Task 4).
 *
 * Fixture
 * -------
 *   Source vault:  clients(id, name, phone)  + secret(id, data)
 *   Surface:       agreed, push, collections:['clients'], fields:{clients:['name']},
 *                  conflictPolicy:{strategy:'take-incoming'}
 *
 * Direction is orchestration metadata, NOT a primitive gate: export/apply are
 * direction-agnostic mechanics (source→slice, slice→receiver) and work for
 * push / pull / bidi alike (gating pull here would make pull surfaces unusable).
 * The sync flow decides which party exports vs applies per direction.
 *
 * Both throw SurfaceStateError for a non-agreed surface.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { StateManagementVault } from '../src/federation/state-vault.js'
import type { SurfaceRow } from '../src/federation/types.js'
import {
  proposeSurface,
  agreeSurface,
  exportSurface,
  applySurface,
  SurfaceStateError,
} from '../src/interchange/surface.js'
import type { SurfaceDefinition } from '../src/interchange/surface.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Client { id: string; name: string; phone: string }
interface Secret { id: string; data: string }

/** Build an agreed surface (two Noydb over a shared store). */
async function buildAgreedSurface(def: SurfaceDefinition): Promise<SurfaceRow> {
  const store = memory()
  const dbA = await createNoydb({ store, user: 'partyA', encrypt: false })
  const dbB = await createNoydb({ store, user: 'partyB', encrypt: false })
  const smvA = await StateManagementVault.open(dbA)
  const smvB = await StateManagementVault.open(dbB)
  const proposed = await proposeSurface(smvA, def, 'partyA', 1_000_000)
  return agreeSurface(smvB, proposed.id, 'partyB', 1_001_000)
}

const pushDef: SurfaceDefinition = {
  id: 'surf-push-1',
  collections: ['clients'],
  fields: { clients: ['name'] },
  direction: 'push',
  conflictPolicy: { strategy: 'take-incoming' },
}

// ─── Core round-trip ──────────────────────────────────────────────────────────

describe('exportSurface / applySurface — scoped field-projected sync', () => {
  it('exports only surface.collections with projected fields; receiver has name only, no phone, no secret', async () => {
    const surface = await buildAgreedSurface(pushDef)

    // Source vault: clients + secret (not in surface)
    const sourceDb = await createNoydb({ store: memory(), user: 'src', secret: 'src-secret-123' })
    const sourceVault = await sourceDb.openVault('source')
    const clients = sourceVault.collection<Client>('clients')
    await clients.put('c1', { id: 'c1', name: 'Alice', phone: '+1-555-0101' })
    await clients.put('c2', { id: 'c2', name: 'Bob', phone: '+1-555-0202' })
    const secrets = sourceVault.collection<Secret>('secret')
    await secrets.put('s1', { id: 's1', data: 'TOP SECRET' })

    // Export
    const { bundleBytes, transferKey } = await exportSurface(sourceVault, surface)
    expect(bundleBytes).toBeInstanceOf(Uint8Array)
    expect(bundleBytes.length).toBeGreaterThan(0)
    expect(transferKey).toBeInstanceOf(Uint8Array)
    expect(transferKey.length).toBe(32)

    // Receiver vault
    const recvDb = await createNoydb({ store: memory(), user: 'recv', secret: 'recv-secret-456' })
    const recvVault = await recvDb.openVault('receiver')

    // Apply
    const report = await applySurface(recvVault, surface, bundleBytes, transferKey)
    expect(report.dryRun).toBe(false)
    expect(report.summary.inserted).toBe(2)
    expect(report.summary.updated).toBe(0)

    // clients: id + name only — no phone
    const c1 = await recvVault.collection<Record<string, unknown>>('clients').get('c1')
    expect(c1).not.toBeNull()
    expect(c1!['id']).toBe('c1')
    expect(c1!['name']).toBe('Alice')
    expect(c1!['phone']).toBeUndefined()

    const c2 = await recvVault.collection<Record<string, unknown>>('clients').get('c2')
    expect(c2).not.toBeNull()
    expect(c2!['name']).toBe('Bob')
    expect(c2!['phone']).toBeUndefined()

    // secret: absent — outside the surface, never leaves
    const secretList = await recvVault.collection<Secret>('secret').list()
    expect(secretList).toHaveLength(0)
  })

  it('non-agreed (proposed) surface throws SurfaceStateError on exportSurface', async () => {
    const store = memory()
    const dbA = await createNoydb({ store, user: 'partyA', encrypt: false })
    const smvA = await StateManagementVault.open(dbA)
    const proposed = await proposeSurface(smvA, pushDef, 'partyA', 1_000_000)

    const sourceDb = await createNoydb({ store: memory(), user: 'src', secret: 'src-secret-123' })
    const sourceVault = await sourceDb.openVault('source')

    await expect(exportSurface(sourceVault, proposed)).rejects.toThrow(SurfaceStateError)
  })

  it('non-agreed (proposed) surface throws SurfaceStateError on applySurface', async () => {
    const store = memory()
    const dbA = await createNoydb({ store, user: 'partyA', encrypt: false })
    const smvA = await StateManagementVault.open(dbA)
    const proposed = await proposeSurface(smvA, pushDef, 'partyA', 1_000_000)

    const recvDb = await createNoydb({ store: memory(), user: 'recv', secret: 'recv-secret-456' })
    const recvVault = await recvDb.openVault('receiver')

    await expect(applySurface(recvVault, proposed, new Uint8Array(16), new Uint8Array(32))).rejects.toThrow(SurfaceStateError)
  })

  it('direction:pull is a direction-agnostic mechanic — export+apply work (flow agreer→proposer)', async () => {
    // A pull surface must NOT be dead: the source still exports its slice and the
    // receiver still applies it. Direction is honoured by the sync flow (who is
    // source vs receiver), not by gating the primitives.
    const pullDef: SurfaceDefinition = {
      id: 'surf-pull-1',
      collections: ['clients'],
      fields: { clients: ['name'] },
      direction: 'pull',
      conflictPolicy: { strategy: 'take-incoming' },
    }
    const surface = await buildAgreedSurface(pullDef)

    const sourceDb = await createNoydb({ store: memory(), user: 'src', secret: 'src-secret-123' })
    const sourceVault = await sourceDb.openVault('source')
    await sourceVault.collection<Client>('clients').put('c1', { id: 'c1', name: 'Alice', phone: '+1-555-0101' })

    const { bundleBytes, transferKey } = await exportSurface(sourceVault, surface)

    const recvDb = await createNoydb({ store: memory(), user: 'recv', secret: 'recv-secret-456' })
    const recvVault = await recvDb.openVault('receiver')
    const report = await applySurface(recvVault, surface, bundleBytes, transferKey)

    expect(report.summary.inserted).toBe(1)
    const c1 = await recvVault.collection<Record<string, unknown>>('clients').get('c1')
    expect(c1!['name']).toBe('Alice')
    expect(c1!['phone']).toBeUndefined()   // projection still applies
  })
})

// ─── Isolation guarantee ──────────────────────────────────────────────────────

describe('exportSurface — ensures only surface.collections are in the bundle', () => {
  it('a non-surface collection (secret) has no records in the receiver after apply', async () => {
    const surface = await buildAgreedSurface({
      id: 'surf-isolation-1',
      collections: ['clients'],
      direction: 'push',
      conflictPolicy: { strategy: 'take-incoming' },
    })

    const sourceDb = await createNoydb({ store: memory(), user: 'src', secret: 'src-secret-123' })
    const sourceVault = await sourceDb.openVault('source')
    await sourceVault.collection<Client>('clients').put('c1', { id: 'c1', name: 'Alice', phone: '555' })
    await sourceVault.collection<Secret>('secret').put('s1', { id: 's1', data: 'SENSITIVE' })
    await sourceVault.collection<Secret>('secret').put('s2', { id: 's2', data: 'CONFIDENTIAL' })

    const { bundleBytes, transferKey } = await exportSurface(sourceVault, surface)

    const recvDb = await createNoydb({ store: memory(), user: 'recv', secret: 'recv-secret-456' })
    const recvVault = await recvDb.openVault('receiver')
    await applySurface(recvVault, surface, bundleBytes, transferKey)

    // secret must NOT be in receiver
    expect(await recvVault.collection<Secret>('secret').list()).toHaveLength(0)
    // clients IS in receiver
    expect(await recvVault.collection<Client>('clients').list()).toHaveLength(1)
  })
})

// ─── Lobby Surface API ────────────────────────────────────────────────────────

describe('Lobby Surface API — delegate to surface.ts helpers', () => {
  it('Lobby.exportSurface / Lobby.applySurface round-trip via vault name', async () => {
    const { createLobby } = await import('../src/index.js')

    // Agree a surface via the low-level helpers
    const surface = await buildAgreedSurface({
      id: 'surf-lobby-1',
      collections: ['orders'],
      fields: { orders: ['amount'] },
      direction: 'push',
      conflictPolicy: { strategy: 'take-incoming' },
    })

    // Source Lobby
    const srcDb = await createNoydb({ store: memory(), user: 'src', secret: 'src-secret-123' })
    const srcLobby = createLobby(srcDb)
    interface Order { id: string; amount: number; note: string }
    const srcVault = await srcDb.openVault('orders')
    await srcVault.collection<Order>('orders').put('o1', { id: 'o1', amount: 100, note: 'confidential' })
    await srcVault.collection<Order>('orders').put('o2', { id: 'o2', amount: 200, note: 'also private' })

    const { bundleBytes, transferKey } = await srcLobby.exportSurface('orders', surface)

    // Receiver Lobby
    const recvDb = await createNoydb({ store: memory(), user: 'recv', secret: 'recv-secret-456' })
    const recvLobby = createLobby(recvDb)

    const report = await recvLobby.applySurface('orders', surface, bundleBytes, transferKey)
    expect(report.summary.inserted).toBe(2)

    // amount only, no note
    const recvVault = await recvDb.openVault('orders')
    const o1 = await recvVault.collection<Record<string, unknown>>('orders').get('o1')
    expect(o1!['amount']).toBe(100)
    expect(o1!['note']).toBeUndefined()
  })
})
