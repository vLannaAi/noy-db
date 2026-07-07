/**
 * Sync pair-expansion + resolver mirroring (#591 Task 11).
 *
 * `push({ collections })` / `pull({ collections })` treat a satellite pair as
 * one unit: filtering by the base name also carries the satellite's dirty
 * entries (incl. DELETEs — the security-relevant case, otherwise a
 * satellite's heavy envelope lingers on the remote indefinitely). Registering
 * a conflict resolver on one pair member registers it for both (spec
 * convergence rule 5b).
 *
 * Fixture (inline memory adapter w/ CAS conflict support, `encrypt: false`)
 * copied from sync-partial.test.ts / sync-conflict-policy.test.ts. Satellite
 * declaration pattern copied from satellites-fanout.test.ts.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

interface Msg extends Record<string, unknown> { from?: string; subject?: string; body?: string }

const COMP = 'v1'

describe('satellite sync pair-expansion + resolver mirroring (#591 Task 11)', () => {
  it('push({ collections: [base] }) transmits the satellite pair partner\'s dirty entries too', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(COMP)
    vault.collection<Msg>('msgs', {})
    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'] })

    await vault.collection<Msg>('msgs').put('m1', { from: 'alice' })
    await vault.collection<Msg>('msgs_text').put('m1', { subject: 's', body: 'b' })
    expect(db.syncStatus(COMP).dirty).toBe(2)

    const result = await db.push(COMP, { collections: ['msgs'] })

    expect(result.pushed).toBe(2)
    expect(await remote.get(COMP, 'msgs', 'm1')).not.toBeNull()
    expect(await remote.get(COMP, 'msgs_text', 'm1')).not.toBeNull()
    expect(db.syncStatus(COMP).dirty).toBe(0)
  })

  it('push({ collections: [base] }) transmits the satellite\'s DELETE too (security: no lingering remote envelope)', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(COMP)
    vault.collection<Msg>('msgs', {})
    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'] })

    await vault.collection<Msg>('msgs').put('m2', { from: 'bob' })
    await vault.collection<Msg>('msgs_text').put('m2', { subject: 's2', body: 'b2' })
    await db.push(COMP) // land both on remote first
    expect(await remote.get(COMP, 'msgs', 'm2')).not.toBeNull()
    expect(await remote.get(COMP, 'msgs_text', 'm2')).not.toBeNull()

    // Base-side delete fans out to the satellite (pairDelete, Task 6).
    await vault.collection<Msg>('msgs').delete('m2')
    expect(db.syncStatus(COMP).dirty).toBe(2) // both deletes tracked

    const result = await db.push(COMP, { collections: ['msgs'] })

    expect(result.pushed).toBe(2)
    expect(await remote.get(COMP, 'msgs', 'm2')).toBeNull()
    expect(await remote.get(COMP, 'msgs_text', 'm2')).toBeNull() // no lingering heavy envelope
    expect(db.syncStatus(COMP).dirty).toBe(0)
  })

  it('pull({ collections: [base] }) pulls the satellite pair partner\'s records too', async () => {
    const localA = inlineMemory()
    const localB = inlineMemory()
    const remote = inlineMemory()

    const dbA = await createNoydb({ store: localA, sync: remote, user: 'a', syncStrategy: withSync(), encrypt: false })
    const vaultA = await dbA.openVault(COMP)
    vaultA.collection<Msg>('msgs', {})
    vaultA.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'] })
    await vaultA.collection<Msg>('msgs').put('m3', { from: 'carol' })
    await vaultA.collection<Msg>('msgs_text').put('m3', { subject: 's3', body: 'b3' })
    await dbA.push(COMP)

    // dbB declares the same pair on its own vault (own registry/pairExpander).
    const dbB = await createNoydb({ store: localB, sync: remote, user: 'b', syncStrategy: withSync(), encrypt: false })
    const vaultB = await dbB.openVault(COMP)
    vaultB.collection<Msg>('msgs', {})
    vaultB.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'] })

    const result = await dbB.pull(COMP, { collections: ['msgs'] })

    expect(result.pulled).toBe(2)
    expect(await localB.get(COMP, 'msgs', 'm3')).not.toBeNull()
    expect(await localB.get(COMP, 'msgs_text', 'm3')).not.toBeNull()
  })

  /**
   * Builds a same-version (_v=2 both sides) CAS push-conflict on `msgs_text`
   * where the LOCAL side has the older timestamp: LWW resolves to remote,
   * FWW (and the default 'version' db-level fallback) keep local — so the
   * winning subject fully discriminates WHICH resolver actually fired.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function driveSatelliteConflict(db: any, vault: any, local: NoydbStore, remote: NoydbStore) {
    await vault.collection('msgs').put('m4', { from: 'dave' })
    await vault.collection('msgs_text').put('m4', { subject: 'local-1', body: '' })
    await db.push(COMP) // remote msgs_text/m4 now at _v=1

    // Someone else pushes a newer version to remote out-of-band, with a
    // FUTURE timestamp.
    const futureTs = new Date(Date.now() + 60_000).toISOString()
    await remote.put(COMP, 'msgs_text', 'm4', {
      _noydb: 1, _v: 2, _ts: futureTs, _iv: '', _data: JSON.stringify({ subject: 'REMOTE', body: 'remote body' }),
    })

    // Local writes again (now also at _v=2, but with an OLDER timestamp) —
    // pushing this creates a same-version CAS conflict against remote.
    await vault.collection('msgs_text').put('m4', { subject: 'local-2', body: '' })

    const result = await db.push(COMP, { collections: ['msgs'] })
    const localEnv = await local.get(COMP, 'msgs_text', 'm4')
    return { result, winner: (JSON.parse(localEnv!._data) as Msg).subject }
  }

  it('rule 5b, NORMAL order: base declared with conflictPolicy first, satellite second — resolver still fires for a satellite conflict', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(COMP)

    // Normal declaration order: the base's conflictPolicy is registered
    // BEFORE the pair exists — retroactive re-mirroring at pair-registration
    // time must copy it onto the satellite.
    vault.collection<Msg>('msgs', { conflictPolicy: 'last-writer-wins' })
    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'] })

    const { result, winner } = await driveSatelliteConflict(db, vault, local, remote)

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.collection).toBe('msgs_text')
    // LWW picked remote (later _ts) — the mirrored resolver fired instead of
    // the default 'version' fallback (which keeps local at equal versions).
    expect(winner).toBe('REMOTE')
  })

  it('rule 5b, satellite-first order: a resolver registered on the base after the pair exists fires for a satellite conflict', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(COMP)

    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'] })
    vault.collection<Msg>('msgs', { conflictPolicy: 'last-writer-wins' })

    const { result, winner } = await driveSatelliteConflict(db, vault, local, remote)

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]!.collection).toBe('msgs_text')
    expect(winner).toBe('REMOTE')
  })

  it('rule 5b tie-break: when BOTH members carried different resolvers before pairing, the base\'s wins', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(COMP)

    // Both collections carry (different) resolvers BEFORE the pair is
    // declared: base LWW, satellite FWW. In the driven conflict LWW resolves
    // to remote and FWW keeps local — fully discriminating.
    vault.collection<Msg>('msgs', { conflictPolicy: 'last-writer-wins' })
    vault.collection<Msg>('msgs_text', { conflictPolicy: 'first-writer-wins' })
    // NOW pair them (no conflictPolicy on this redeclare) — re-mirroring
    // must pick the BASE's resolver as canonical for both members.
    vault.collection<Msg>('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'] })

    const { result, winner } = await driveSatelliteConflict(db, vault, local, remote)

    expect(result.conflicts).toHaveLength(1)
    // Base's LWW (→ remote) won over the satellite's pre-pairing FWW (→ local).
    expect(winner).toBe('REMOTE')
  })

  it('control: without any satellite declared, push({ collections }) behaves exactly as before', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(COMP)
    vault.collection<Msg>('invoices', {})
    vault.collection<Msg>('payments', {})

    await vault.collection<Msg>('invoices').put('inv-1', { from: 'x' })
    await vault.collection<Msg>('payments').put('pay-1', { from: 'y' })

    const result = await db.push(COMP, { collections: ['invoices'] })

    expect(result.pushed).toBe(1)
    expect(await remote.get(COMP, 'invoices', 'inv-1')).not.toBeNull()
    expect(await remote.get(COMP, 'payments', 'pay-1')).toBeNull()
    expect(db.syncStatus(COMP).dirty).toBe(1) // payments still dirty
  })
})
