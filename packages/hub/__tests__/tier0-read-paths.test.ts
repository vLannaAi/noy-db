/**
 * #691 — tier-0 enclave read paths vs elevated records. An elevated
 * (_tier > 0) record is INVISIBLE through every tier-0 door: verify /
 * verifyGroup pad-false exactly like a missing record, findByDigest drops
 * the hit, det scans skip it — in BOTH the elevating (warm cekCache)
 * session and a cold reopened session. Pre-#691 these paths resolved the
 * record CEK under the collection tier-0 DEK unconditionally: cold
 * sessions threw (InvalidKeyError/TamperedError, an elevation oracle that
 * also aborted det scans), and the warm session leaked tier-1 plaintext
 * through findByDet with no CrossTierAccessEvent.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withClassified } from '../src/via/classified/active.js'
import { classified } from '../src/via/classified/presets.js'
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

interface User extends Record<string, unknown> { name?: string; password?: string; email?: string; a1?: string; a2?: string }

/** One store, reopenable: open() twice = cold second session over the same ciphertext. */
function tieredClassifiedHarness() {
  const store = memoryStore()
  const open = async () => {
    const db = await createNoydb({
      store, user: 'owner', secret: 'pw-691-tier-gate',
      tiersStrategy: withTiers(), classifiedStrategy: withClassified(),
    })
    const vault = await db.openVault('v1')
    const users = vault.collection<User>('users', {
      perRecordKeys: true,
      tiers: [0, 1],
      acknowledgeEquatableRisk: true,
      classifiedFields: {
        password: classified.password({ equatable: true }), // equatable: true enables findByDigest's _bidx door
        email: classified.email(),           // recoverable → _sealed → text door
        a1: classified.secretAnswer(),
        a2: classified.secretAnswer(),
      },
    })
    return { vault, users }
  }
  return { store, open }
}

describe('#691 verify doors: elevated ≡ missing', () => {
  it('verify (digest + text doors) pads false on an elevated record, warm and cold', async () => {
    const h = tieredClassifiedHarness()
    const { users } = await h.open()
    await users.put('u1', { name: 'n', password: 'correct-horse-battery', email: 'u1@example.com', a1: 'Rex', a2: 'Bangkok' })
    expect(await users.verify('u1', 'password', 'correct-horse-battery')).toMatchObject({ ok: true })
    expect(await users.verify('u1', 'email', 'u1@example.com')).toMatchObject({ ok: true })

    await users.elevate('u1', 1)

    // Warm (elevating) session: verdict-only — MUST NOT throw, MUST NOT verify.
    expect(await users.verify('u1', 'password', 'correct-horse-battery')).toEqual({ ok: false }) // digest door
    expect(await users.verify('u1', 'email', 'u1@example.com')).toEqual({ ok: false })           // text door
    // Same shape as a genuinely missing id — no elevation oracle.
    expect(await users.verify('no-such-id', 'password', 'correct-horse-battery')).toEqual({ ok: false })

    // Cold session (fresh cekCache) — identical verdicts, still no throw.
    const cold = await h.open()
    expect(await cold.users.verify('u1', 'password', 'correct-horse-battery')).toEqual({ ok: false })
    expect(await cold.users.verify('u1', 'email', 'u1@example.com')).toEqual({ ok: false })
  }, 60_000)

  it('verifyGroup pads all members false on an elevated record', async () => {
    const h = tieredClassifiedHarness()
    const { users } = await h.open()
    await users.put('u1', { name: 'n', password: 'pw-grp-secret-1', email: 'g@example.com', a1: 'Rex', a2: 'Bangkok' })
    expect(await users.verifyGroup('u1', { a1: 'Rex', a2: 'Bangkok' }, { min: 2 })).toEqual({ passed: true })
    await users.elevate('u1', 1)
    expect(await users.verifyGroup('u1', { a1: 'Rex', a2: 'Bangkok' }, { min: 2 })).toEqual({ passed: false })
    const cold = await h.open()
    expect(await cold.users.verifyGroup('u1', { a1: 'Rex', a2: 'Bangkok' }, { min: 2 })).toEqual({ passed: false })
  }, 60_000)

  it('findByDigest drops the elevated hit and keeps scanning tier-0 hits', async () => {
    const h = tieredClassifiedHarness()
    const { users } = await h.open()
    await users.put('u0', { name: 'a', password: 'pw-zero-stays-00', email: 'z@example.com', a1: 'x', a2: 'y' })
    await users.put('u1', { name: 'b', password: 'pw-one-moves-111', email: 'o@example.com', a1: 'x', a2: 'y' })
    await users.elevate('u1', 1)

    expect(await users.findByDigest('password', 'pw-one-moves-111')).toEqual([])        // elevated hit dropped, no throw
    expect(await users.findByDigest('password', 'pw-zero-stays-00')).toEqual(['u0'])    // scan NOT aborted

    const cold = await h.open()
    expect(await cold.users.findByDigest('password', 'pw-one-moves-111')).toEqual([])
    expect(await cold.users.findByDigest('password', 'pw-zero-stays-00')).toEqual(['u0'])
  }, 60_000)

  it('findByDigest same-scan abort: elevated record sharing a tier-0 candidate\'s _bidx tag does not hide the tier-0 hit', async () => {
    const h = tieredClassifiedHarness()
    const { users } = await h.open()
    await users.put('u0', { name: 'a', password: 'shared-secret-pw', email: 'z@example.com', a1: 'x', a2: 'y' })
    await users.put('u1', { name: 'b', password: 'shared-secret-pw', email: 'o@example.com', a1: 'x', a2: 'y' })
    await users.elevate('u1', 1)

    expect(await users.findByDigest('password', 'shared-secret-pw')).toEqual(['u0'])
  }, 60_000)
})

describe('#691 det scans: elevated records are skipped', () => {
  function tieredDetHarness() {
    const store = memoryStore()
    const open = async () => {
      const db = await createNoydb({ store, user: 'owner', secret: 'pw-691-det', tiersStrategy: withTiers() })
      const vault = await db.openVault('v1')
      const accounts = vault.collection<User>('accounts', {
        perRecordKeys: true,
        tiers: [0, 1],
        deterministicFields: ['email'],
        acknowledgeDeterministicRisk: true,
        prefetch: false, // lazy mode: sidesteps eager ensureHydrated() (out of scope — separate pre-existing gap, not a #691 det-scan door)
        cache: { maxRecords: 100 },
      })
      return { vault, accounts }
    }
    return { store, open }
  }

  it('warm (elevating) session: findByDet must NOT leak the elevated record via the cekCache', async () => {
    const h = tieredDetHarness()
    const { accounts } = await h.open()
    await accounts.put('e1', { name: 'leaky', email: 'x@y.z' })
    await accounts.elevate('e1', 1) // caches the CEK — pre-#691 findByDet then SUCCEEDS here, audit-free
    expect(await accounts.findByDet('email', 'x@y.z')).toBeNull()
  })

  it('cold session: det scans skip the elevated match instead of throwing, and keep tier-0 matches', async () => {
    const h = tieredDetHarness()
    const { accounts } = await h.open()
    await accounts.put('a0', { name: 'a', email: 'shared@y.z' })
    await accounts.put('b0', { name: 'b', email: 'shared@y.z' })
    await accounts.put('e1', { name: 'c', email: 'shared@y.z' })
    await accounts.elevate('e1', 1)

    const cold = await h.open()
    // Pre-#691: the scan throws on e1's tier-wrapped key material, ABORTING
    // the whole query and losing a0/b0.
    const hits = await cold.accounts.queryByDet('email', 'shared@y.z')
    expect(hits.map(r => r.name).sort()).toEqual(['a', 'b'])
    // findByDet on a value only the elevated record carries → null, no throw.
    await cold.accounts.put('solo', { name: 's', email: 'solo@y.z' })
    await cold.accounts.elevate('solo', 1)
    expect(await cold.accounts.findByDet('email', 'solo@y.z')).toBeNull()
  })
})

describe('#701 hydration / lazy reads / reveal: elevated records are invisible, never a brick or leak', () => {
  function eagerTierHarness() {
    const store = memoryStore()
    const open = async () => {
      const db = await createNoydb({ store, user: 'owner', secret: 'pw-701', tiersStrategy: withTiers() })
      const vault = await db.openVault('v1')
      const docs = vault.collection<User>('docs', { tiers: [0, 1], perRecordKeys: true })
      return { vault, docs }
    }
    return { store, open }
  }

  it('cold-session eager hydration skips the elevated record instead of bricking the collection', async () => {
    const h = eagerTierHarness()
    const { docs } = await h.open()
    await docs.put('a', { name: 'stays' })
    await docs.put('b', { name: 'moves' })
    await docs.elevate('b', 1)

    // Pre-#701: the first decrypt of b's tier-wrapped envelope during cold
    // hydration threw, aborting the loop — get('a') / any read or write on
    // the whole collection rejected.
    const cold = await h.open()
    expect((await cold.docs.get('a'))?.name).toBe('stays')
    expect(await cold.docs.get('b')).toBeNull()          // invisible, not an error
    await cold.docs.put('c', { name: 'writable' })       // collection is usable
    expect((await cold.docs.get('c'))?.name).toBe('writable')
  })

  it('vault-snapshot hydration path (hydrateFromSnapshot) also skips the elevated record — no in-repo caller reaches this loop otherwise, so it is exercised directly', async () => {
    const h = eagerTierHarness()
    const { docs } = await h.open()
    await docs.put('a', { name: 'stays' })
    await docs.put('b', { name: 'moves' })
    await docs.elevate('b', 1)

    const cold = await h.open() // fresh, un-hydrated Collection over the same store
    const snapshot = await h.store.loadAll('v1')
    await cold.docs.hydrateFromSnapshot(snapshot['docs'] ?? {})
    expect((await cold.docs.get('a'))?.name).toBe('stays')
    expect(await cold.docs.get('b')).toBeNull()
  })

  it('lazy direct-address read: null in BOTH sessions (warm pre-#701 LEAKED via cekCache, cold threw)', async () => {
    const store = memoryStore()
    const open = async () => {
      const db = await createNoydb({ store, user: 'owner', secret: 'pw-701-lazy', tiersStrategy: withTiers() })
      const vault = await db.openVault('v1')
      const docs = vault.collection<User>('ldocs', { tiers: [0, 1], perRecordKeys: true, prefetch: false, cache: { maxRecords: 100 } })
      return { docs }
    }
    const { docs } = await open()
    await docs.put('e1', { name: 'leaky' })
    await docs.elevate('e1', 1) // evicts the LRU (#700) and caches the CEK
    expect(await docs.get('e1')).toBeNull()   // warm: pre-#701 returned plaintext (leak)
    const cold = await open()
    expect(await cold.docs.get('e1')).toBeNull() // cold: pre-#701 threw
  })

  it('reveal on an elevated record throws the domain not-found error, not a raw crypto error', async () => {
    const h = tieredClassifiedHarness()
    const { users } = await h.open()
    await users.put('r1', { name: 'n', password: 'pw-reveal-r1-xx', email: 'r@example.com', a1: 'x', a2: 'y' })
    expect(await users.reveal('r1', 'email')).toBe('r@example.com')
    await users.elevate('r1', 1)
    // Elevated ≡ missing on this tier-0 surface — same error/message class as
    // a genuinely absent id, no elevation disclosure, never InvalidKeyError.
    await expect(users.reveal('r1', 'email')).rejects.toThrow(/not found/)
  }, 60_000)
})
