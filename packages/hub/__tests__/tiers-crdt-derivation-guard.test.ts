/**
 * #739 — follow-up from #722 (PR #738). `RecordCodec.decryptRecordAtDek()`
 * (the tier-aware pre-move decode `syncDerived` uses on elevate()/demote())
 * has no CRDT resolution step, so a registered rollup/derivation reading a
 * CRDT-mode tiered SOURCE collection sees raw `CrdtState` instead of the
 * resolved record — its key/value fields read as `undefined` and the
 * recompute silently no-ops, letting the #722 leak back in for this
 * combination. Refused at construction (mirrors the #724/#748/#740
 * `UnsupportedTierCompositionError` guards in `collection-config.ts`)
 * instead of fixed via CRDT-aware pre-move decode.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withRollup, withDerivation, UnsupportedTierCompositionError, ConflictError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withCrdt } from '../src/with-commit/crdt/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }

describe('#739 — tiers + crdt + derivation/rollup source is refused at construction', () => {
  it('refuses a tiered CRDT collection that is a rollup `from` (child) source', async () => {
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-crdt-rollup-from-passphrase-2026',
      tiersStrategy: withTiers(),
      crdtStrategy: withCrdt(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')

    expect(() =>
      vault.collection<Sale>('sales', { tiers: [0, 1], perRecordKeys: true, crdt: 'lww-map' }),
    ).toThrow(UnsupportedTierCompositionError)
  })

  it('refuses a tiered CRDT collection that is a rollup `into` (parent) source', async () => {
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-crdt-rollup-into-passphrase-2026',
      tiersStrategy: withTiers(),
      crdtStrategy: withCrdt(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')

    expect(() =>
      vault.collection<Buyer>('buyers', { tiers: [0, 1], perRecordKeys: true, crdt: 'lww-map' }),
    ).toThrow(UnsupportedTierCompositionError)
  })

  it('refuses a tiered CRDT collection that is a plain (non-rollup) derivation source', async () => {
    interface Worker extends Record<string, unknown> { id: string; period: string; baseSalary: number }
    interface ActivePeriod extends Record<string, unknown> { id: string; workerId: string; period: string }
    const strategy = withDerivation<Worker, { activeInPeriod: ActivePeriod[] }>({
      source: 'workers',
      deterministic: true,
      outputs: { activeInPeriod: { shape: 'array', collection: 'workerActiveInPeriod', key: (o) => `${o.workerId as string}|${o.period as string}` } },
      derive: (worker) => ({ activeInPeriod: [{ id: `${worker.id}|${worker.period}`, workerId: worker.id, period: worker.period }] }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-crdt-derivation-passphrase-2026',
      tiersStrategy: withTiers(),
      crdtStrategy: withCrdt(),
      derivationStrategies: [strategy],
    })
    const vault = await db.openVault('acme')

    expect(() =>
      vault.collection<Worker>('workers', { tiers: [0, 1], perRecordKeys: true, crdt: 'lww-map' }),
    ).toThrow(UnsupportedTierCompositionError)
  })

  it('allows tiers + crdt WITHOUT a derivation/rollup', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-crdt-only-passphrase-2026',
      tiersStrategy: withTiers(),
      crdtStrategy: withCrdt(),
    })
    const vault = await db.openVault('firm')

    expect(() =>
      vault.collection<Sale>('sales', { tiers: [0, 1], perRecordKeys: true, crdt: 'lww-map' }),
    ).not.toThrow()
  })

  it('allows crdt + a rollup source WITHOUT tiers', async () => {
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'crdt-rollup-no-tiers-passphrase-2026',
      crdtStrategy: withCrdt(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')

    expect(() => vault.collection<Sale>('sales', { crdt: 'lww-map' })).not.toThrow()
  })

  it('allows tiers + a rollup source WITHOUT crdt', async () => {
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-rollup-no-crdt-passphrase-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')

    expect(() =>
      vault.collection<Sale>('sales', { tiers: [0, 1], perRecordKeys: true }),
    ).not.toThrow()
  })
})
