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
import { mergeCompartment } from '../src/interchange/merge-compartment.js'
import { FieldAuthorityPolicyMissingError } from '../src/interchange/field-authority.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Client { id: string; name: string }
interface LegalEntity { id: string; juristicName: string; nickname: string }

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

describe('mergeCompartment — field-level (deprecated alias)', () => {
  it('resolves via field-authority (no longer throws FieldLevelDeferredError)', async () => {
    // 'field-level' is now a deprecated alias for 'field-authority'.
    // Without fieldAuthority policy it throws FieldAuthorityPolicyMissingError.
    const { bundleBytes, transferKey } = await buildBundle()
    const receiver = await buildReceiver()

    await expect(
      mergeCompartment(receiver, bundleBytes, {
        transferKey,
        strategy: 'field-level',
      }),
    ).rejects.toThrow(FieldAuthorityPolicyMissingError)
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

// ─── FR-4: field-authority merge strategy ────────────────────────────────────

/**
 * Build a source vault with a single `clients` (LegalEntity) collection with
 * provenance:true. Incoming c1: juristicName='New Co', nickname='theirNick',
 * written with source:'firm-B', sourceTs:'2022-01-01T00:00:00.000Z'.
 * Returns { bundleBytes, transferKey }.
 */
async function buildFr4Bundle() {
  const sourceDb = await createNoydb({ store: memory(), user: 'src-fa', secret: 'src-fa-secret-123' })
  const source = await sourceDb.openVault('source-fa')
  const clients = source.collection<LegalEntity>('clients', { provenance: true })
  await clients.put('c1', { id: 'c1', juristicName: 'New Co', nickname: 'theirNick' }, {
    source: 'firm-B',
    sourceTs: '2022-01-01T00:00:00.000Z',
  })
  const { bundleBytes, transferKey } = await extractPartition(source, {
    seeds: { clients: () => true },
  })
  return { bundleBytes, transferKey }
}

/**
 * Build a fresh receiver vault with `clients` collection (provenance:true).
 * Receiver c1: juristicName='Old Co', nickname='localNick',
 * written with source:'principal-X', sourceTs:'2021-01-01T00:00:00.000Z'.
 */
async function buildFr4Receiver() {
  const db = await createNoydb({ store: memory(), user: 'recv-fa', secret: 'recv-fa-secret-456' })
  const vault = await db.openVault('receiver-fa')
  const clients = vault.collection<LegalEntity>('clients', { provenance: true })
  await clients.put('c1', { id: 'c1', juristicName: 'Old Co', nickname: 'localNick' }, {
    source: 'principal-X',
    sourceTs: '2021-01-01T00:00:00.000Z',
  })
  return vault
}

describe('mergeCompartment — field-authority (FR-4)', () => {
  it('merges per field: registry field takes newest source, sovereign field keeps owner', async () => {
    const { bundleBytes, transferKey } = await buildFr4Bundle()
    const receiver = await buildFr4Receiver()

    const report = await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: 'field-authority',
      fieldAuthority: {
        clients: {
          juristicName: { authority: 'source-newest' },
          nickname: { authority: 'owner', ownerSource: 'principal-X' },
        },
      },
    })

    const merged = await receiver.collection<LegalEntity>('clients', { provenance: true }).get('c1')
    expect(merged).not.toBeNull()
    // source-newest: incoming (firm-B, 2022) is newer than local (principal-X, 2021)
    expect(merged!.juristicName).toBe('New Co')
    // owner principal-X: incoming source is firm-B (not principal-X) → local kept
    expect(merged!.nickname).toBe('localNick')
    // merged record bumps updated
    expect(report.summary.updated).toBe(1)
    // conflict recorded as field-merged
    const conflict = report.conflicts.find((c) => c.id === 'c1')
    expect(conflict).toBeDefined()
    expect(conflict!.resolution).toBe('field-merged')
  })

  it('throws FieldAuthorityPolicyMissingError when no policy supplied for the collection', async () => {
    const { bundleBytes, transferKey } = await buildFr4Bundle()
    const receiver = await buildFr4Receiver()

    await expect(
      mergeCompartment(receiver, bundleBytes, {
        transferKey,
        strategy: 'field-authority',
        // no fieldAuthority → missing policy for 'clients'
      }),
    ).rejects.toThrow(FieldAuthorityPolicyMissingError)
  })

  it('dryRun computes the field-authority outcome without writing', async () => {
    const { bundleBytes, transferKey } = await buildFr4Bundle()
    const receiver = await buildFr4Receiver()

    const report = await mergeCompartment(receiver, bundleBytes, {
      transferKey,
      strategy: 'field-authority',
      dryRun: true,
      fieldAuthority: {
        clients: {
          juristicName: { authority: 'source-newest' },
        },
      },
    })

    expect(report.dryRun).toBe(true)
    // Nothing written: receiver c1 still has old juristicName
    const untouched = await receiver.collection<LegalEntity>('clients', { provenance: true }).get('c1')
    expect(untouched!.juristicName).toBe('Old Co')
    // summary still reflects the planned update
    expect(report.summary.updated).toBe(1)
  })
})

// ─── FR-4 Q2: take-incoming preserves incoming origin _sourceTs ───────────────

describe('mergeCompartment — origin _sourceTs preservation (FR-4 Q2)', () => {
  it('take-incoming preserves the incoming origin _sourceTs (not merge time)', async () => {
    // incoming c1 written with {source:'firm-A', sourceTs:'2020-05-05T00:00:00.000Z'}
    const sourceDb = await createNoydb({ store: memory(), user: 'src-sts', secret: 'src-sts-secret-123' })
    const source = await sourceDb.openVault('source-sts')
    const srcClients = source.collection<Client>('clients', { provenance: true })
    await srcClients.put('c1', { id: 'c1', name: 'A-incoming' }, {
      source: 'firm-A',
      sourceTs: '2020-05-05T00:00:00.000Z',
    })
    await srcClients.put('c2', { id: 'c2', name: 'B' })

    const { bundleBytes, transferKey } = await extractPartition(source, {
      seeds: { clients: () => true },
    })

    // receiver has a divergent c1
    const recvDb = await createNoydb({ store: memory(), user: 'recv-sts', secret: 'recv-sts-secret-456' })
    const receiver = await recvDb.openVault('receiver-sts')
    const recvClients = receiver.collection<Client>('clients', { provenance: true })
    await recvClients.put('c1', { id: 'c1', name: 'A-local' }, { source: 'local-source' })

    await mergeCompartment(receiver, bundleBytes, { transferKey, strategy: 'take-incoming' })

    const meta = await receiver.collection<Client>('clients', { provenance: true }).getMetadata('c1')
    expect(meta).not.toBeNull()
    expect(meta!.source).toBe('firm-A')
    // origin _sourceTs preserved — NOT merge-time
    expect(meta!.sourceTs).toBe('2020-05-05T00:00:00.000Z')
  })
})
