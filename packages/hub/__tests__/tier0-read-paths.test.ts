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
})
