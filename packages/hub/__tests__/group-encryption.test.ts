import { describe, it, expect } from 'vitest'
import {
  generateDEK,
  deriveSealedFieldKey,
  encrypt,
  decrypt,
} from '../src/crypto.js'
import { createNoydb } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/index.js'

interface Person {
  id: string
  name: string
  ssn?: string
  dob?: string
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

describe('crypto — deriveSealedFieldKey', () => {
  it('derives a usable AES-GCM key that round-trips', async () => {
    const dek = await generateDEK()
    const key = await deriveSealedFieldKey(dek, 'people', 'ssn')
    const { iv, data } = await encrypt(JSON.stringify('123-45-6789'), key)
    expect(JSON.parse(await decrypt(iv, data, key))).toBe('123-45-6789')
  })

  it('derives different keys per field (isolation)', async () => {
    const dek = await generateDEK()
    const keyA = await deriveSealedFieldKey(dek, 'people', 'ssn')
    const keyB = await deriveSealedFieldKey(dek, 'people', 'dob')
    const { iv, data } = await encrypt(JSON.stringify('secret'), keyA)
    // ciphertext sealed under field a must NOT decrypt under field b's key
    await expect(decrypt(iv, data, keyB)).rejects.toThrow()
  })

  it('derives different keys per collection', async () => {
    const dek = await generateDEK()
    const keyP = await deriveSealedFieldKey(dek, 'people', 'ssn')
    const keyC = await deriveSealedFieldKey(dek, 'clients', 'ssn')
    const { iv, data } = await encrypt(JSON.stringify('secret'), keyP)
    await expect(decrypt(iv, data, keyC)).rejects.toThrow()
  })
})

describe('collection — group-encryption (_sealed)', () => {
  it('round-trips a record with a sensitive field', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1')
    const people = v.collection<Person>('people', { sensitive: ['ssn'] })

    const original: Person = { id: 'p1', name: 'Alice', ssn: '123-45-6789' }
    await people.put('p1', original)

    // Public reads return sensitive fields as opaque Sealed handles (#503
    // access gate); non-sensitive fields stay plain. reveal() round-trips.
    const got = await people.get('p1')
    expect(got).not.toBeNull()
    expect(got!.id).toBe('p1')
    expect(got!.name).toBe('Alice')
    expect((got!.ssn as unknown as { sealed: boolean }).sealed).toBe(true)
    expect(await (got!.ssn as unknown as { reveal(): Promise<string> }).reveal()).toBe('123-45-6789')
  })

  it('stores the sensitive field in _sealed, out of the open _data blob', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1')
    const people = v.collection<Person>('people', { sensitive: ['ssn'] })

    await people.put('p1', { id: 'p1', name: 'Alice', ssn: '123-45-6789' })

    const env = await store.get('v1', 'people', 'p1')
    expect(env).not.toBeNull()
    expect(env!._sealed).toBeDefined()
    expect(env!._sealed!.ssn).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
    // non-sensitive fields are NOT promoted into _sealed
    expect(env!._sealed!.name).toBeUndefined()

    // Prove ssn is NOT inside the open _data blob: strip _sealed from the
    // stored envelope and re-read with a fresh instance (no decrypt cache).
    // If ssn lived in _data it would survive; it must not.
    const raw = store._data.get('v1')!.get('people')!.get('p1')!
    const stripped: Record<string, unknown> = { ...raw }
    delete stripped._sealed
    store._data.get('v1')!.get('people')!.set('p1', stripped as unknown as EncryptedEnvelope)

    const db2 = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v2 = await db2.openVault('v1')
    const people2 = v2.collection<Person>('people', { sensitive: ['ssn'] })
    const partial = await people2.get('p1')
    expect(partial).not.toBeNull()
    expect(partial!.name).toBe('Alice')
    expect(partial!.ssn).toBeUndefined()
  })

  it('seals every present sensitive field under its own key', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1')
    const people = v.collection<Person>('people', { sensitive: ['ssn', 'dob'] })

    const original: Person = { id: 'p1', name: 'Alice', ssn: '111', dob: '1990-01-01' }
    await people.put('p1', original)

    const env = await store.get('v1', 'people', 'p1')
    expect(env!._sealed!.ssn).toBeDefined()
    expect(env!._sealed!.dob).toBeDefined()
    // distinct ciphertext per field
    expect(env!._sealed!.ssn).not.toBe(env!._sealed!.dob)

    // Both sensitive fields come back as handles that reveal their values.
    const got = await people.get('p1')
    expect(await (got!.ssn as unknown as { reveal(): Promise<string> }).reveal()).toBe('111')
    expect(await (got!.dob as unknown as { reveal(): Promise<string> }).reveal()).toBe('1990-01-01')
  })

  it('omits absent sensitive fields from _sealed', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1')
    const people = v.collection<Person>('people', { sensitive: ['ssn', 'dob'] })

    const original: Person = { id: 'p1', name: 'Bob' }
    await people.put('p1', original)

    const env = await store.get('v1', 'people', 'p1')
    // no sensitive fields present → no _sealed map at all
    expect(env!._sealed).toBeUndefined()
    expect(await people.get('p1')).toEqual(original)
  })

  it('default-off: no sensitive option → no _sealed key, classic envelope shape', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner' })
    const v = await db.openVault('v1')
    const people = v.collection<Person>('people')

    await people.put('p1', { id: 'p1', name: 'Alice', ssn: '123-45-6789' })

    const env = await store.get('v1', 'people', 'p1')
    expect(env).not.toBeNull()
    expect('_sealed' in env!).toBe(false)
    // classic encrypted-envelope keys only
    expect(Object.keys(env!).sort()).toEqual(['_by', '_data', '_iv', '_noydb', '_ts', '_v'])
  })
})
