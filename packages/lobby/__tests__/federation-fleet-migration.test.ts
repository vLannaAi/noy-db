/**
 * Fleet schema-migration runner (#271): VaultGroup.migrateShard / migrateFleet
 * + migrate-on-open, with per-shard migration-status in the StateManagement Vault.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { createNoydb } from '@noy-db/hub'
import type { Noydb } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import { StateManagementVault } from '../src/federation/state-vault.js'
import { coordinatedCutover } from '@noy-db/hub'
import { createLobby } from '../src/index.js'

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

interface Invoice extends Record<string, unknown> { id: string; clientId: string; amount: number }

// A managed group at `version` with a trivial template (no schema change) —
// exercises the runner's ORCHESTRATION (version bump, status, cohort, resume).
async function firmAt(db: Noydb, version: number, migrateOnOpen = false) {
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version,
    configure: (v: Vault) => { v.collection<Invoice>('invoices') },
  })
  return lobby.openVaultGroup<Invoice>('firm-clients', {
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template', autoCreate: true },
    migrateOnOpen,
  })
}

async function statusOf(db: Noydb, partitionKey: string) {
  const sv = await StateManagementVault.open(db)
  return sv.getMigrationStatus(`firm-clients--${partitionKey}`)
}

describe('fleet migration — orchestration (#271)', () => {
  it('migrateFleet advances behind shards to the template version + records status', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', secret: 'p' })
    const firm1 = await firmAt(db, 1)
    await firm1.collection('invoices').put('a1', { id: 'a1', clientId: 'acme', amount: 1 })
    await firm1.collection('invoices').put('b1', { id: 'b1', clientId: 'globex', amount: 2 })

    const firm2 = await firmAt(db, 2)
    const res = await firm2.migrateFleet()
    expect(res.target).toBe(2)
    expect(res.migrated.sort()).toEqual(['firm-clients--acme', 'firm-clients--globex'])
    expect(res.failed).toEqual([])

    // registry versions advanced
    const rows = await firm2.allRows()
    expect(rows.every((r) => r.schemaVersion === 2)).toBe(true)
    // migration-status recorded
    expect(await statusOf(db, 'acme')).toMatchObject({ status: 'done', targetVersion: 2 })
  })

  it('is resumable — a re-run migrates nothing once shards are current', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', secret: 'p' })
    const firm1 = await firmAt(db, 1)
    await firm1.collection('invoices').put('a1', { id: 'a1', clientId: 'acme', amount: 1 })
    const firm2 = await firmAt(db, 2)
    expect((await firm2.migrateFleet()).migrated).toEqual(['firm-clients--acme'])
    expect((await firm2.migrateFleet()).migrated).toEqual([]) // nothing left
  })

  it('cohort restricts the run (staged / canary rollout)', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', secret: 'p' })
    const firm1 = await firmAt(db, 1)
    await firm1.collection('invoices').put('a1', { id: 'a1', clientId: 'acme', amount: 1 })
    await firm1.collection('invoices').put('b1', { id: 'b1', clientId: 'globex', amount: 2 })
    const firm2 = await firmAt(db, 2)

    const canary = await firm2.migrateFleet({ cohort: ['acme'] })
    expect(canary.migrated).toEqual(['firm-clients--acme'])
    const rows = await firm2.allRows()
    expect(rows.find((r) => r.partitionKey === 'acme')?.schemaVersion).toBe(2)
    expect(rows.find((r) => r.partitionKey === 'globex')?.schemaVersion).toBe(1) // not in cohort

    // then the rest
    expect((await firm2.migrateFleet()).migrated).toEqual(['firm-clients--globex'])
  })

  it('migrateShard migrates a single shard; a current shard is a no-op', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', secret: 'p' })
    const firm1 = await firmAt(db, 1)
    await firm1.collection('invoices').put('a1', { id: 'a1', clientId: 'acme', amount: 1 })
    const firm2 = await firmAt(db, 2)
    const r1 = await firm2.migrateShard('acme')
    expect(r1).toMatchObject({ status: 'done', targetVersion: 2 })
    const r2 = await firm2.migrateShard('acme') // already current
    expect(r2).toMatchObject({ status: 'done', migrated: 0 })
  })

  it('migrateOnOpen lazily migrates a behind shard on access', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', secret: 'p' })
    const firm1 = await firmAt(db, 1)
    await firm1.collection('invoices').put('a1', { id: 'a1', clientId: 'acme', amount: 1 })

    const firm2 = await firmAt(db, 2, /* migrateOnOpen */ true)
    expect((await firm2.allRows()).find((r) => r.partitionKey === 'acme')?.schemaVersion).toBe(1)
    await firm2.shard('acme') // drilling in triggers the lazy migration
    expect((await firm2.allRows()).find((r) => r.partitionKey === 'acme')?.schemaVersion).toBe(2)
  })

  it('the minVersion fan-out guard reflects migration state', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', secret: 'p' })
    const firm1 = await firmAt(db, 1)
    await firm1.collection('invoices').put('a1', { id: 'a1', clientId: 'acme', amount: 9 })
    const firm2 = await firmAt(db, 2)
    // before migration: minVersion:2 skips the v1 shard
    const before = await firm2.collection('invoices').query().toArray({ minVersion: 2 })
    expect(before.results).toEqual([])
    expect(before.skippedVaults).toEqual([{ vaultId: 'firm-clients--acme', reason: 'schema-drift' }])
    // after migration: included
    await firm2.migrateFleet()
    const after = await firm2.collection('invoices').query().toArray({ minVersion: 2 })
    expect(after.results.map((r) => r.id)).toEqual(['a1'])
    expect(after.skippedVaults).toEqual([])
  })
})

describe('fleet migration — real coordinatedCutover across shards (#271)', () => {
  const oldSchema = z.object({ id: z.string(), clientId: z.string(), total: z.number() })
  const newSchema = z.object({ id: z.string(), clientId: z.string(), amount: z.object({ gross: z.number() }) })
  const transform = (d: Record<string, unknown>) => ({ id: d['id'], clientId: d['clientId'], amount: { gross: d['total'] } })

  it('migrateFleet runs each shard cutover and transforms records in place', async () => {
    const store = memory()
    const sharding = { keyOf: (r: { clientId: string }) => r.clientId, vaultTemplate: 'ct', autoCreate: true }

    // Session 1 (v1): seed old-shape data + persist the schema baseline per shard.
    const db1 = await createNoydb({ store, user: 'op', secret: 'p' })
    const lobby1 = createLobby(db1)
    lobby1.withVaultTemplate('ct', { version: 1, configure: (v: Vault) => { v.collection('invoices', { schema: oldSchema, persistJsonSchema: true }) } })
    const firm1 = await lobby1.openVaultGroup('firm-clients', { sharding })
    await firm1.collection('invoices').put('a1', { id: 'a1', clientId: 'acme', total: 100 })
    await firm1.collection('invoices').put('b1', { id: 'b1', clientId: 'globex', total: 250 })
    await (await firm1.shard('acme'))._drainPendingSchemaWrites()
    await (await firm1.shard('globex'))._drainPendingSchemaWrites()

    // Session 2 (v2 — fresh Noydb over the same store, like an operator restart):
    // shards are re-opened fresh so the new schema is detected vs the v1 baseline.
    const db2 = await createNoydb({ store, user: 'op', secret: 'p' })
    const lobby2 = createLobby(db2)
    lobby2.withVaultTemplate('ct', {
      version: 2,
      configure: (v: Vault) => { v.collection('invoices', { schema: newSchema, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })] }) },
    })
    const firm2 = await lobby2.openVaultGroup('firm-clients', { sharding })

    const res = await firm2.migrateFleet()
    expect(res.migrated.sort()).toEqual(['firm-clients--acme', 'firm-clients--globex'])
    expect(res.failed).toEqual([])

    // records transformed in place on each shard
    const acme = await firm2.shard('acme')
    expect((await acme.collection<{ id: string; amount: { gross: number } }>('invoices').get('a1'))?.amount.gross).toBe(100)
    const globex = await firm2.shard('globex')
    expect((await globex.collection<{ id: string; amount: { gross: number } }>('invoices').get('b1'))?.amount.gross).toBe(250)

    // status reflects a real migration (migrated >= 1)
    const sv = await StateManagementVault.open(db2)
    const st = await sv.getMigrationStatus('firm-clients--acme')
    expect(st?.status).toBe('done')
    expect(st?.migrated).toBe(1)
  })
})
