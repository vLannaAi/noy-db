/**
 * L-1 (#554): the deterministic `_det` index must NOT encrypt under the raw
 * collection DEK — that puts two IV regimes (randomized `_data`, deterministic
 * `_det`) on one key. `_det` now encrypts under a dedicated HKDF-derived key
 * (`deriveDeterministicKey`, salt `noydb-det`), still DEK-derived so the index
 * stays collection-level and rotation-stable (CEK rotation carries `_det`
 * verbatim). Back-compat: `findByDet`/`queryByDet` dual-query the new AND the
 * legacy raw-DEK target so pre-migration envelopes remain findable; they
 * self-heal to the new key on their next write.
 */
import { describe, it, expect } from 'vitest'
import {
  encryptDeterministic,
  deriveDeterministicKey,
  type EnclaveKey,
} from '../src/kernel/enclave/index.js'
import { createNoydb } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/index.js'

interface User {
  id: string
  name: string
  email: string
}

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

/** Reach the collection's private DEK resolver (test-only, runtime field). */
function collectionDek(coll: unknown, name: string): Promise<EnclaveKey> {
  const c = coll as { getDEK(collectionName: string): Promise<EnclaveKey> }
  return c.getDEK(name)
}

async function setup() {
  const store = memoryStore()
  const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
  const v = await db.openVault('v1')
  const users = v.collection<User>('users', {
    deterministicFields: ['email'],
    acknowledgeDeterministicRisk: true,
  })
  return { store, users }
}

describe('L-1 — _det encrypts under a dedicated HKDF key, not the raw DEK', () => {
  it('preserves determinism: same value → same _det slot across two writes', async () => {
    const { store, users } = await setup()
    await users.put('u1', { id: 'u1', name: 'Alice', email: 'alice@example.com' })
    await users.put('u2', { id: 'u2', name: 'Alt', email: 'alice@example.com' })
    await users.put('u3', { id: 'u3', name: 'Bob', email: 'bob@example.com' })

    const a1 = (await store.get('v1', 'users', 'u1'))!._det!.email
    const a2 = (await store.get('v1', 'users', 'u2'))!._det!.email
    const b = (await store.get('v1', 'users', 'u3'))!._det!.email
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
  })

  it('finds freshly-written records via findByDet and queryByDet', async () => {
    const { users } = await setup()
    await users.put('u1', { id: 'u1', name: 'Alice', email: 'alice@example.com' })
    await users.put('u2', { id: 'u2', name: 'Bob', email: 'bob@example.com' })

    expect(await users.findByDet('email', 'bob@example.com')).toMatchObject({ id: 'u2' })
    expect(await users.findByDet('email', 'nobody@example.com')).toBeNull()
    const hits = await users.queryByDet('email', 'alice@example.com')
    expect(hits.map((u) => u.id)).toEqual(['u1'])
  })

  it('domain separation: _det is NOT the raw-DEK deterministic ciphertext (and IS the derived-key one)', async () => {
    const { store, users } = await setup()
    await users.put('u1', { id: 'u1', name: 'Alice', email: 'alice@example.com' })

    const dek = await collectionDek(users, 'users')
    const stored = (await store.get('v1', 'users', 'u1'))!._det!.email

    // What the pre-fix raw-DEK regime would have stamped:
    const legacy = await encryptDeterministic('alice@example.com', dek, 'users/email')
    expect(stored).not.toBe(`${legacy.iv}:${legacy.data}`)

    // What the dedicated derived key stamps — proves the write side switched keys:
    const detKey = await deriveDeterministicKey(dek)
    const fresh = await encryptDeterministic('alice@example.com', detKey, 'users/email')
    expect(stored).toBe(`${fresh.iv}:${fresh.data}`)
  })

  it('deriveDeterministicKey is deterministic per DEK', async () => {
    const { users } = await setup()
    const dek = await collectionDek(users, 'users')
    const k1 = await deriveDeterministicKey(dek)
    const k2 = await deriveDeterministicKey(dek)
    const a = await encryptDeterministic('x', k1, 'users/email')
    const b = await encryptDeterministic('x', k2, 'users/email')
    expect(a.iv).toBe(b.iv)
    expect(a.data).toBe(b.data)
  })

  it('BACK-COMPAT: a legacy raw-DEK _det slot is still findable via dual-query', async () => {
    const { store, users } = await setup()
    await users.put('u1', { id: 'u1', name: 'Alice', email: 'alice@example.com' })

    // Rewrite u1's _det slot to the PRE-MIGRATION form: deterministic
    // encryption under the raw collection DEK (what the old write path stamped).
    const dek = await collectionDek(users, 'users')
    const legacy = await encryptDeterministic('alice@example.com', dek, 'users/email')
    const env = (await store.get('v1', 'users', 'u1'))!
    await store.put('v1', 'users', 'u1', {
      ...env,
      _det: { ...env._det, email: `${legacy.iv}:${legacy.data}` },
    })

    expect(await users.findByDet('email', 'alice@example.com')).toMatchObject({ id: 'u1' })
    const hits = await users.queryByDet('email', 'alice@example.com')
    expect(hits.map((u) => u.id)).toEqual(['u1'])
  })

  it('BACK-COMPAT: queryByDet returns legacy and new envelopes together for one value', async () => {
    const { store, users } = await setup()
    await users.put('u1', { id: 'u1', name: 'Alice', email: 'shared@example.com' })
    await users.put('u2', { id: 'u2', name: 'Alt', email: 'shared@example.com' })

    // Downgrade only u1 to the legacy raw-DEK stamp; u2 keeps the new-key stamp.
    const dek = await collectionDek(users, 'users')
    const legacy = await encryptDeterministic('shared@example.com', dek, 'users/email')
    const env = (await store.get('v1', 'users', 'u1'))!
    await store.put('v1', 'users', 'u1', {
      ...env,
      _det: { ...env._det, email: `${legacy.iv}:${legacy.data}` },
    })

    const hits = await users.queryByDet('email', 'shared@example.com')
    expect(hits.map((u) => u.id).sort()).toEqual(['u1', 'u2'])
  })

  it('legacy envelope self-heals to the new key on its next write', async () => {
    const { store, users } = await setup()
    await users.put('u1', { id: 'u1', name: 'Alice', email: 'alice@example.com' })

    const dek = await collectionDek(users, 'users')
    const legacy = await encryptDeterministic('alice@example.com', dek, 'users/email')
    const env = (await store.get('v1', 'users', 'u1'))!
    await store.put('v1', 'users', 'u1', {
      ...env,
      _det: { ...env._det, email: `${legacy.iv}:${legacy.data}` },
    })

    // Next write restamps _det under the dedicated key.
    await users.put('u1', { id: 'u1', name: 'Alice v2', email: 'alice@example.com' })
    const detKey = await deriveDeterministicKey(dek)
    const fresh = await encryptDeterministic('alice@example.com', detKey, 'users/email')
    const healed = (await store.get('v1', 'users', 'u1'))!._det!.email
    expect(healed).toBe(`${fresh.iv}:${fresh.data}`)
  })
})
