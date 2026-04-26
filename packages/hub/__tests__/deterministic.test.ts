import { describe, it, expect } from 'vitest'
import {
  generateDEK,
  encryptDeterministic,
  decryptDeterministic,
  encrypt,
  decrypt,
} from '../src/crypto.js'
import { createNoydb } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/index.js'

interface User {
  id: string
  name: string
  email: string
  phone?: string
}

function memoryStore(): NoydbStore & { _data: Map<string, Map<string, Map<string, EncryptedEnvelope>>> } {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    _data: data,
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

describe('crypto — encryptDeterministic', () => {
  it('produces identical ciphertext for identical inputs', async () => {
    const dek = await generateDEK()
    const a = await encryptDeterministic('alice@example.com', dek, 'users/email')
    const b = await encryptDeterministic('alice@example.com', dek, 'users/email')
    expect(a.iv).toBe(b.iv)
    expect(a.data).toBe(b.data)
  })

  it('produces different ciphertext for different plaintexts', async () => {
    const dek = await generateDEK()
    const a = await encryptDeterministic('alice@example.com', dek, 'users/email')
    const b = await encryptDeterministic('bob@example.com', dek, 'users/email')
    expect(a.iv).not.toBe(b.iv)
    expect(a.data).not.toBe(b.data)
  })

  it('domain-separates by context string', async () => {
    const dek = await generateDEK()
    const emailField = await encryptDeterministic('same-value', dek, 'users/email')
    const phoneField = await encryptDeterministic('same-value', dek, 'users/phone')
    expect(emailField.iv).not.toBe(phoneField.iv)
    expect(emailField.data).not.toBe(phoneField.data)
  })

  it('round-trips through decryptDeterministic', async () => {
    const dek = await generateDEK()
    const { iv, data } = await encryptDeterministic('secret', dek, 'users/email')
    expect(await decryptDeterministic(iv, data, dek)).toBe('secret')
  })

  it('interoperates with randomized decrypt (same AES-GCM wire format)', async () => {
    const dek = await generateDEK()
    const { iv, data } = await encryptDeterministic('roundtrip', dek, 'users/email')
    expect(await decrypt(iv, data, dek)).toBe('roundtrip')
  })

  it('randomized encrypt still produces different ciphertext for same input', async () => {
    const dek = await generateDEK()
    const a = await encrypt('same', dek)
    const b = await encrypt('same', dek)
    expect(a.iv).not.toBe(b.iv)
  })
})

describe('collection — deterministicFields', () => {
  it('rejects deterministicFields without acknowledgeDeterministicRisk', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    expect(() =>
      v.collection<User>('users', {
        deterministicFields: ['email'],
      }),
    ).toThrow(/acknowledgeDeterministicRisk/)
  })

  it('attaches _det to envelopes for declared fields', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const users = v.collection<User>('users', {
      deterministicFields: ['email'],
      acknowledgeDeterministicRisk: true,
    })

    await users.put('u1', { id: 'u1', name: 'Alice', email: 'alice@example.com' })
    const store = (db as unknown as { options: { store: NoydbStore } }).options.store
    const env = await store.get('v1', 'users', 'u1')
    expect(env).not.toBeNull()
    expect(env!._det).toBeDefined()
    expect(env!._det!.email).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
  })

  it('produces identical _det slots for the same field value across records', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const users = v.collection<User>('users', {
      deterministicFields: ['email'],
      acknowledgeDeterministicRisk: true,
    })

    await users.put('u1', { id: 'u1', name: 'Alice', email: 'alice@example.com' })
    await users.put('u2', { id: 'u2', name: 'Alice (alt)', email: 'alice@example.com' })
    await users.put('u3', { id: 'u3', name: 'Bob', email: 'bob@example.com' })

    const store = (db as unknown as { options: { store: NoydbStore } }).options.store
    const a1 = (await store.get('v1', 'users', 'u1'))!._det!.email
    const a2 = (await store.get('v1', 'users', 'u2'))!._det!.email
    const b = (await store.get('v1', 'users', 'u3'))!._det!.email

    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
  })

  it('findByDet returns the matching record', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const users = v.collection<User>('users', {
      deterministicFields: ['email'],
      acknowledgeDeterministicRisk: true,
    })

    await users.put('u1', { id: 'u1', name: 'Alice', email: 'alice@example.com' })
    await users.put('u2', { id: 'u2', name: 'Bob', email: 'bob@example.com' })

    const found = await users.findByDet('email', 'bob@example.com')
    expect(found).toMatchObject({ id: 'u2', name: 'Bob' })

    const none = await users.findByDet('email', 'nobody@example.com')
    expect(none).toBeNull()
  })

  it('queryByDet returns every match', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const users = v.collection<User>('users', {
      deterministicFields: ['email'],
      acknowledgeDeterministicRisk: true,
    })

    await users.put('u1', { id: 'u1', name: 'Alice', email: 'shared@example.com' })
    await users.put('u2', { id: 'u2', name: 'Alice alt', email: 'shared@example.com' })
    await users.put('u3', { id: 'u3', name: 'Bob', email: 'bob@example.com' })

    const hits = await users.queryByDet('email', 'shared@example.com')
    expect(hits).toHaveLength(2)
    expect(hits.map(u => u.id).sort()).toEqual(['u1', 'u2'])
  })

  it('throws on findByDet for an undeclared field', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const users = v.collection<User>('users', {
      deterministicFields: ['email'],
      acknowledgeDeterministicRisk: true,
    })
    await expect(users.findByDet('name', 'Alice')).rejects.toThrow(/not declared in deterministicFields/)
  })

  it('skips _det for undefined field values', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1', { passphrase: 'pw' })
    const users = v.collection<User>('users', {
      deterministicFields: ['email', 'phone'],
      acknowledgeDeterministicRisk: true,
    })
    await users.put('u1', { id: 'u1', name: 'Alice', email: 'a@x.com' })
    const store = (db as unknown as { options: { store: NoydbStore } }).options.store
    const env = (await store.get('v1', 'users', 'u1'))!
    expect(env._det!.email).toBeDefined()
    expect(env._det!.phone).toBeUndefined()
  })
})
