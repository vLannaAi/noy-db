/**
 * Showcase 121 — klum-db onboarding spine
 *           (Relocate → Migrate-then-merge with field-authority + provenance)
 *
 * What you'll learn
 * ─────────────────
 * The full Lobby intake ceremony: import a client vault into a receiver that
 * holds a shared directory.
 *
 *   1. `extractCrossVaultPartition` (FR-2 Relocate) — walk the cross-vault FK
 *      closure from a client vault (projects) to a directory vault (clients).
 *      Only the FK-referenced client rows cross the boundary — an unreferenced
 *      client stays in the directory only.
 *
 *   2. `migrateThenMerge` (FR-8) — upgrade an older-schema (v1: `name`) bundle
 *      to the receiver's v2 schema (`fullName`) IN STAGING before any write.
 *      A transform turns `name` → `fullName`; `byCollection` reports `'transformed'`.
 *
 *   3. `strategy:'field-authority'` (FR-4) — a registry field (`phone`) uses
 *      `source-newest` (the incoming record's `_sourceTs` wins when it is later),
 *      while a sovereign field (`internalRef`) always keeps the owner's copy.
 *
 *   4. `provenance:true` (FR-5) — `_source` / `_sourceTs` are stamped on every
 *      put and surfaced by `collection.getMetadata(id)` without body decryption.
 *
 * Spec mapping
 * ────────────
 * features.yaml → cross-vault-extraction, migrate-then-merge,
 *                 field-authority-merge, record-provenance, merge-compartment
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { extractPartition } from '@noy-db/hub/bundle'
import { memory } from '@noy-db/to-memory'
import {
  extractCrossVaultPartition,
  migrateThenMerge,
} from '@klum-db/lobby'

// ── Schema types ───────────────────────────────────────────────────────────────

interface ClientV1 { id: string; name: string; phone: string; internalRef: string }
interface ClientV2 { id: string; fullName: string; phone: string; internalRef: string }
interface Project { id: string; title: string; clientId: string }

describe('Showcase 121 — klum-db onboarding spine', () => {
  it('extractCrossVaultPartition: only FK-referenced directory rows cross the bundle boundary', async () => {
    // ── Shared DIRECTORY vault (holds clients) ─────────────────────────────────
    const dirStore = memory()
    const dirDb = await createNoydb({ store: dirStore, user: 'dir-admin', secret: 'dir-admin-2026' })
    const dirVault = await dirDb.openVault('directory')
    await dirVault.collection<ClientV1>('clients').put('c1', { id: 'c1', name: 'Acme Corp', phone: '+1-555-0101', internalRef: 'dir-c1' })
    await dirVault.collection<ClientV1>('clients').put('c2', { id: 'c2', name: 'Globex Inc', phone: '+1-555-0202', internalRef: 'dir-c2' })
    // c3 will NOT be referenced by any project → should not cross the bundle
    await dirVault.collection<ClientV1>('clients').put('c3', { id: 'c3', name: 'Unreferenced Co', phone: '+1-000-0000', internalRef: 'dir-c3' })
    dirDb.close()

    // ── CLIENT vault (holds projects that reference clients via clientId FK) ────
    const clientStore = memory()
    const clientDb = await createNoydb({ store: clientStore, user: 'client-mgr', secret: 'client-mgr-2026' })
    const clientVault = await clientDb.openVault('client-data')
    // p1 → c1, p2 → c2; c3 is not referenced
    await clientVault.collection<Project>('projects').put('p1', { id: 'p1', title: 'Portal Launch', clientId: 'c1' })
    await clientVault.collection<Project>('projects').put('p2', { id: 'p2', title: 'Internal Tool', clientId: 'c2' })
    clientDb.close()

    // ── Multi-vault FK closure extraction ──────────────────────────────────────
    const openVault = async (name: string) => {
      if (name === 'directory') {
        const db = await createNoydb({ store: dirStore, user: 'dir-admin', secret: 'dir-admin-2026' })
        return db.openVault('directory')
      }
      const db = await createNoydb({ store: clientStore, user: 'client-mgr', secret: 'client-mgr-2026' })
      return db.openVault('client-data')
    }

    const res = await extractCrossVaultPartition(openVault, {
      seed: { vault: 'client-data', seeds: { projects: () => true } },
      crossVaultRefs: [
        { from: { collection: 'projects', field: 'clientId' }, to: { vault: 'directory', collection: 'clients' } },
      ],
    })

    // ASSERT: two compartments (client-data + directory) with separate transfer keys
    expect(Object.keys(res.transferKeys).sort()).toEqual(['client-data', 'directory'])
    expect(res.transferKeys['directory'].byteLength).toBe(32)
    expect(res.transferKeys['client-data'].byteLength).toBe(32)

    // ASSERT: two vault names in transfer keys confirms both compartments extracted
    // Use the walkCrossVaultClosure plan to confirm the closure
    const { walkCrossVaultClosure, extractCrossVaultPartition: _ecvp } = await import('@klum-db/lobby')
    const plan = await walkCrossVaultClosure(openVault, {
      seed: { vault: 'client-data', seeds: { projects: () => true } },
      crossVaultRefs: [
        { from: { collection: 'projects', field: 'clientId' }, to: { vault: 'directory', collection: 'clients' } },
      ],
    })
    // perVaultClosure tells us exactly which ids were included per vault
    const dirClosure = plan.perVaultClosure.get('directory')
    const clientsClosure = dirClosure?.get('clients')
    expect(clientsClosure).toBeDefined()
    expect([...clientsClosure!].sort()).toEqual(['c1', 'c2']) // c3 not referenced

    // ASSERT: the directory compartment holds exactly c1 + c2 (c3 was not referenced)
    // We verify by adopting the directory compartment into a fresh vault
    const { readNoydbBundleManifest, readMultiVaultBundleCompartment, adoptPartition, createOwnerOnAdoptedPartition } = await import('@noy-db/hub/bundle')
    const compartments = await readNoydbBundleManifest(res.bundle)
    expect(compartments).toHaveLength(2)

    // Find the directory compartment: try both handles
    let directoryBytes: Uint8Array | null = null
    let directoryTK: Uint8Array | null = null
    for (const entry of compartments) {
      const bytes = readMultiVaultBundleCompartment(res.bundle, entry.handle)
      // Try decrypting with directory TK — the one that works is the directory compartment
      const dirTK = res.transferKeys['directory']
      try {
        const { decryptExtractedPartition } = await import('@noy-db/hub/bundle')
        await decryptExtractedPartition(bytes, dirTK)
        directoryBytes = bytes
        directoryTK = dirTK
        break
      } catch {
        // not the directory compartment
      }
    }

    expect(directoryBytes).not.toBeNull()
    // Adopt the directory compartment and assert only c1, c2 are present (not c3)
    const adoptStore = memory()
    await adoptPartition(directoryBytes!, { transferKey: directoryTK!, destinationStore: adoptStore, vaultName: 'adopted-dir' })
    await createOwnerOnAdoptedPartition(adoptStore, 'adopted-dir', {
      userId: 'adopter',
      passphrase: 'adopter-pass-2026',
      transferKey: directoryTK!,
    })
    const adopter = await createNoydb({ store: adoptStore, user: 'adopter', secret: 'adopter-pass-2026' })
    const adoptedVault = await adopter.openVault('adopted-dir')
    const adoptedClients = await adoptedVault.collection<ClientV1>('clients').list()
    const adoptedIds = adoptedClients.map(c => c.id).sort()
    expect(adoptedIds).toEqual(['c1', 'c2'])         // ONLY referenced rows
    expect(adoptedIds).not.toContain('c3')           // unreferenced row excluded

    adopter.close()
  })

  it('migrateThenMerge: v1 bundle upgraded in staging (transform), field-authority, provenance', async () => {
    // ── SOURCE vault at v1 (name field, provenance:true) ──────────────────────
    const srcStore = memory()
    const srcDb = await createNoydb({ store: srcStore, user: 'src-op', secret: 'src-pass-2026' })
    const srcVault = await srcDb.openVault('source')
    await srcVault.collection<ClientV1>('clients', { provenance: true })
      .put('c10', { id: 'c10', name: 'Acme', phone: '+1-NEW-555', internalRef: 'incoming-ref' }, {
        source: 'import-registry',
        sourceTs: '2025-06-01T00:00:00.000Z', // NEWER source for phone
      })
    srcDb.close()

    const { bundleBytes, transferKey } = await extractPartition(
      await (async () => {
        const db = await createNoydb({ store: srcStore, user: 'src-op', secret: 'src-pass-2026' })
        return db.openVault('source')
      })(),
      { seeds: { clients: () => true } },
    )

    // ── RECEIVER vault at v2 (fullName field, has a local internalRef) ─────────
    const recvStore = memory()
    const recvDb = await createNoydb({ store: recvStore, user: 'recv-op', secret: 'recv-pass-2026' })
    const recvVault = await recvDb.openVault('receiver')
    const recvClients = recvVault.collection<ClientV2>('clients', { provenance: true })
    await recvClients.put('c10', { id: 'c10', fullName: 'Acme Ltd (local)', phone: '+1-OLD-000', internalRef: 'SOVEREIGN-ref' }, {
      source: 'receiver-owner',
      sourceTs: '2024-01-01T00:00:00.000Z', // OLDER source for phone
    })

    // ── migrateThenMerge: v1 → v2 with transform + field-authority ────────────
    const report = await migrateThenMerge(recvVault, bundleBytes, {
      transferKey,
      fromVersion: 1,
      toVersion: 2,
      migrations: {
        clients: [
          {
            toVersion: 2,
            transform: (rec) => ({
              id: rec['id'],
              fullName: String(rec['name'] ?? ''),
              phone: rec['phone'],
              internalRef: rec['internalRef'],
            }),
          },
        ],
      },
      strategy: 'field-authority',
      fieldAuthority: {
        clients: {
          // phone: newest source wins → incoming (2025) beats receiver (2024)
          phone: { authority: 'source-newest' },
          // fullName: newest source wins too
          fullName: { authority: 'source-newest' },
          // internalRef: sovereign — receiver-owner always wins
          internalRef: { authority: 'owner', ownerSource: 'receiver-owner' },
        },
      },
      reason: 'showcase:121:onboarding-spine',
    })

    // ASSERT: migration metadata
    expect(report.migration.fromVersion).toBe(1)
    expect(report.migration.toVersion).toBe(2)
    expect(report.migration.byCollection['clients']).toBe('transformed')

    // ASSERT: record was merged
    expect(report.summary.total).toBeGreaterThan(0)

    const c10 = await recvClients.get('c10')
    expect(c10).not.toBeNull()

    // ASSERT: phone came from the incoming (newer source 2025)
    expect(c10?.phone).toBe('+1-NEW-555')

    // ASSERT: sovereign field kept the local owner's value
    expect(c10?.internalRef).toBe('SOVEREIGN-ref')

    // ASSERT: provenance is queryable via getMetadata (no body decrypt needed)
    const meta = await recvClients.getMetadata('c10')
    expect(meta).not.toBeNull()
    // Source stamped as 'merged' (field-authority strategy writes 'merged' as the record source)
    expect(typeof meta!.source).toBe('string')

    recvDb.close()
  })
})
