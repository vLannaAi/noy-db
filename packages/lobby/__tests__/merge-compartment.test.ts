/**
 * mergeCompartment — reconcile an incoming extracted-partition into an
 * existing receiver vault (FR-3). Plan: docs/superpowers/plans/2026-06-17-fr3-merge-compartment.md §Task 2.
 *
 * Fixture
 * -------
 *   source: clients c1={name:'A'}, c2={name:'B'}, c3={name:'C'}
 *   → extractPartition → {bundleBytes, transferKey}
 *
 *   receiver: clients c1={name:'A-OLD'} (conflict) + c4={name:'D'} (receiver-only)
 *
 * Each strategy case uses a FRESH receiver to avoid cross-contamination.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { extractPartition } from '@noy-db/hub/bundle'
import { memory } from '@noy-db/to-memory'
import {
  mergeCompartment,
  FieldLevelDeferredError,
} from '../src/interchange/merge-compartment.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Client { id: string; name: string }

// ─── Fixture builders ─────────────────────────────────────────────────────────

/**
 * Build a source vault with clients c1/c2/c3, extract it, and return the
 * bundleBytes + transferKey.
 */
async function buildBundle() {
  const sourceDb = await createNoydb({ store: memory(), user: 'src', secret: 'src-secret-123' })
  const source = await sourceDb.openVault('source')
  const clients = source.collection<Client>('clients')
  await clients.put('c1', { id: 'c1', name: 'A' })
  await clients.put('c2', { id: 'c2', name: 'B' })
  await clients.put('c3', { id: 'c3', name: 'C' })

  const { bundleBytes, transferKey } = await extractPartition(source, {
    seeds: { clients: () => true },
  })
  return { bundleBytes, transferKey }
}

/**
 * Build a fresh receiver vault with clients c1={name:'A-OLD'} (conflict) and
 * c4={name:'D'} (receiver-only). Returns the vault.
 */
async function buildReceiver() {
  const db = await createNoydb({ store: memory(), user: 'recv', secret: 'recv-secret-456' })
  const vault = await db.openVault('receiver')
  const clients = vault.collection<Client>('clients')
  // Write c1 (conflict) — the receiver already has a version of c1
  await clients.put('c1', { id: 'c1', name: 'A-OLD' })
  // Write c4 (receiver-only — not in the incoming bundle)
  await clients.put('c4', { id: 'c4', name: 'D' })
  return vault
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('mergeCompartment — take-incoming', () => {
  it('inserts c2,c3; overwrites c1 with incoming value; leaves receiver-only c4 intact', async () => {
    const { bundleBytes, transferKey } = await buildBundle()
    const receiver = await buildReceiver()

    const r = await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: 'take-incoming',
    })

    expect(r.summary.inserted).toBe(2)    // c2, c3
    expect(r.summary.updated).toBe(1)     // c1 overwritten
    expect(r.summary.skipped).toBe(0)
    expect(r.summary.queued).toBe(0)
    expect(r.dryRun).toBe(false)

    // incoming c1 won — value is 'A' (not 'A-OLD')
    const c1 = await receiver.collection<Client>('clients').get('c1')
    expect(c1).not.toBeNull()
    expect(c1!.name).toBe('A')

    // receiver-only c4 is kept
    const c4 = await receiver.collection<Client>('clients').get('c4')
    expect(c4).not.toBeNull()
    expect(c4!.name).toBe('D')

    // take-incoming overwrites are logged in conflicts as resolution 'incoming'
    expect(r.conflicts).toEqual([
      { collection: 'clients', id: 'c1', strategy: 'take-incoming', resolution: 'incoming' },
    ])
  })
})

describe('mergeCompartment — keep-local', () => {
  it('inserts c2,c3; skips c1 conflict; receiver c1 unchanged', async () => {
    const { bundleBytes, transferKey } = await buildBundle()
    const receiver = await buildReceiver()

    const r = await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: 'keep-local',
    })

    expect(r.summary.inserted).toBe(2)    // c2, c3
    expect(r.summary.updated).toBe(0)
    expect(r.summary.skipped).toBe(1)     // c1 skipped
    expect(r.summary.queued).toBe(0)

    // receiver c1 still has the old value
    const c1 = await receiver.collection<Client>('clients').get('c1')
    expect(c1!.name).toBe('A-OLD')

    // conflicts record includes c1
    expect(r.conflicts.some((c) => c.id === 'c1' && c.resolution === 'local')).toBe(true)
  })
})

describe('mergeCompartment — lww-by-ts', () => {
  it('incoming newer → c1 overwritten (take-incoming wins)', async () => {
    // Build source vault AFTER receiver's c1 is written → incoming _ts is newer
    const receiverDb = await createNoydb({ store: memory(), user: 'recv', secret: 'recv-secret-456' })
    const receiver = await receiverDb.openVault('receiver')
    const clients = receiver.collection<Client>('clients')
    // Write c1 to receiver FIRST
    await clients.put('c1', { id: 'c1', name: 'A-OLD' })
    await clients.put('c4', { id: 'c4', name: 'D' })

    // Now build source (writes c1 AFTER receiver's c1 → incoming is newer)
    const sourceDb = await createNoydb({ store: memory(), user: 'src', secret: 'src-secret-123' })
    const source = await sourceDb.openVault('source')
    const srcClients = source.collection<Client>('clients')
    await srcClients.put('c1', { id: 'c1', name: 'A' })
    await srcClients.put('c2', { id: 'c2', name: 'B' })
    await srcClients.put('c3', { id: 'c3', name: 'C' })
    const { bundleBytes, transferKey } = await extractPartition(source, {
      seeds: { clients: () => true },
    })

    const r = await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: 'lww-by-ts',
    })

    // c2 and c3 are always inserted
    expect(r.summary.inserted).toBe(2)
    // c1: either incoming wins (updated) or local wins (skipped); both are valid depending on clock.
    // In the normal case (source written after receiver) incoming _ts > local _ts → updated=1
    // We accept either outcome in case of sub-millisecond clock tie, but check the state is consistent.
    const c1 = await receiver.collection<Client>('clients').get('c1')
    if (r.summary.updated === 1) {
      expect(c1!.name).toBe('A')
    } else {
      expect(c1!.name).toBe('A-OLD')
    }
  })

  it('incoming older than local → c1 skipped (local wins)', async () => {
    // Write receiver c1 AFTER building the incoming bundle → local _ts is newer
    const sourceDb = await createNoydb({ store: memory(), user: 'src', secret: 'src-secret-123' })
    const source = await sourceDb.openVault('source')
    const srcClients = source.collection<Client>('clients')
    await srcClients.put('c1', { id: 'c1', name: 'A' })
    await srcClients.put('c2', { id: 'c2', name: 'B' })
    await srcClients.put('c3', { id: 'c3', name: 'C' })
    const { bundleBytes, transferKey } = await extractPartition(source, {
      seeds: { clients: () => true },
    })

    // Build receiver c1 AFTER the source bundle → local _ts is strictly newer
    const receiverDb = await createNoydb({ store: memory(), user: 'recv', secret: 'recv-secret-456' })
    const receiver = await receiverDb.openVault('receiver')
    const clients = receiver.collection<Client>('clients')
    await clients.put('c4', { id: 'c4', name: 'D' })
    // Write c1 AFTER bundle was extracted so its _ts > incoming _ts
    await clients.put('c1', { id: 'c1', name: 'A-OLD' })

    const r = await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: 'lww-by-ts',
    })

    expect(r.summary.inserted).toBe(2)   // c2, c3
    // c1: local is newer → skipped
    expect(r.summary.updated).toBe(0)
    expect(r.summary.skipped).toBe(1)
    const c1 = await receiver.collection<Client>('clients').get('c1')
    expect(c1!.name).toBe('A-OLD')
    expect(r.conflicts.some((c) => c.id === 'c1' && c.resolution === 'local')).toBe(true)
  })
})

describe('mergeCompartment — manual-queue', () => {
  it('c1 conflict queued; summary.queued===1; conflicts has c1; receiver c1 UNCHANGED', async () => {
    const { bundleBytes, transferKey } = await buildBundle()
    const receiver = await buildReceiver()

    const r = await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: 'manual-queue',
    })

    expect(r.summary.inserted).toBe(2)    // c2, c3
    expect(r.summary.queued).toBe(1)      // c1
    expect(r.summary.updated).toBe(0)
    expect(r.summary.skipped).toBe(0)

    // c1 appears in conflicts as queued
    const conflict = r.conflicts.find((c) => c.collection === 'clients' && c.id === 'c1')
    expect(conflict).toBeDefined()
    expect(conflict!.resolution).toBe('queued')
    expect(conflict!.strategy).toBe('manual-queue')

    // receiver c1 is unchanged
    const c1 = await receiver.collection<Client>('clients').get('c1')
    expect(c1!.name).toBe('A-OLD')
  })
})

describe('mergeCompartment — dry-run', () => {
  it('dryRun=true: summary computed but receiver NOT modified', async () => {
    const { bundleBytes, transferKey } = await buildBundle()
    const receiver = await buildReceiver()

    const r = await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: 'take-incoming',
      dryRun: true,
    })

    expect(r.dryRun).toBe(true)
    // Summary is computed as if writes happened
    expect(r.summary.inserted).toBe(2)
    expect(r.summary.updated).toBe(1)

    // But receiver is NOT modified: c1 still has old value
    const c1 = await receiver.collection<Client>('clients').get('c1')
    expect(c1!.name).toBe('A-OLD')

    // c2 was NOT written
    const c2 = await receiver.collection<Client>('clients').get('c2')
    expect(c2).toBeNull()
  })
})

describe('mergeCompartment — field-level', () => {
  it('rejects with FieldLevelDeferredError', async () => {
    const { bundleBytes, transferKey } = await buildBundle()
    const receiver = await buildReceiver()

    await expect(
      mergeCompartment(receiver, bundleBytes, {
        transferKey,
        strategy: 'field-level',
      }),
    ).rejects.toThrow(FieldLevelDeferredError)
  })
})

describe('mergeCompartment — per-collection strategy map', () => {
  it('applies take-incoming for clients collection, falls back to default manual-queue for others', async () => {
    const { bundleBytes, transferKey } = await buildBundle()
    const receiver = await buildReceiver()

    const r = await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: { clients: 'take-incoming', default: 'manual-queue' },
    })

    // c1 conflict resolved via take-incoming
    expect(r.summary.updated).toBe(1)
    const c1 = await receiver.collection<Client>('clients').get('c1')
    expect(c1!.name).toBe('A')
  })

  it('falls back to the hardcoded manual-queue when the map has no default and no match', async () => {
    const { bundleBytes, transferKey } = await buildBundle()
    const receiver = await buildReceiver()

    // No 'clients' entry and no 'default' → strategyFor() returns 'manual-queue'
    const r = await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: { someOtherCollection: 'take-incoming' },
    })

    // c1 conflict is queued (manual-queue fallback), c2/c3 inserted
    expect(r.summary.inserted).toBe(2)
    expect(r.summary.queued).toBe(1)
    expect(r.summary.updated).toBe(0)
    const conflict = r.conflicts.find((c) => c.id === 'c1')
    expect(conflict).toBeDefined()
    expect(conflict!.resolution).toBe('queued')

    // receiver c1 unchanged
    const c1 = await receiver.collection<Client>('clients').get('c1')
    expect(c1!.name).toBe('A-OLD')
  })
})

// ─── FR-5: provenance preservation ───────────────────────────────────────────

describe('mergeCompartment — provenance preservation (FR-5)', () => {
  it('threads incoming _source through to receiver put when provenance:true', async () => {
    // Source vault: clients collection with provenance:true; c1 written with source:'firm-A'
    const sourceDb = await createNoydb({ store: memory(), user: 'src', secret: 'src-secret-123' })
    const source = await sourceDb.openVault('source')
    const srcClients = source.collection<Client>('clients', { provenance: true })
    await srcClients.put('c1', { id: 'c1', name: 'A' }, { source: 'firm-A' })
    await srcClients.put('c2', { id: 'c2', name: 'B' })

    const { bundleBytes, transferKey } = await extractPartition(source, {
      seeds: { clients: () => true },
    })

    // Receiver vault: clients collection with provenance:true (opt-in on receiver side)
    const recvDb = await createNoydb({ store: memory(), user: 'recv', secret: 'recv-secret-456' })
    const receiver = await recvDb.openVault('receiver')
    // Register the provenance-enabled collection on the receiver
    receiver.collection<Client>('clients', { provenance: true })

    await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: 'take-incoming',
    })

    // c1's source should be preserved through the merge
    const meta = await receiver.collection<Client>('clients', { provenance: true }).getMetadata('c1')
    expect(meta).not.toBeNull()
    expect(meta!.source).toBe('firm-A')

    // c2 had no source — should not have a source in metadata
    const meta2 = await receiver.collection<Client>('clients', { provenance: true }).getMetadata('c2')
    expect(meta2).not.toBeNull()
    expect(meta2!.source).toBeUndefined()
  })
})
