/**
 * v0.18 hierarchical access — tier DEKs, invisibility/ghost, elevate/demote,
 * delegation, cross-tier audit (#205–#210).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, TierNotGrantedError, TierDemoteDeniedError } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, GhostRecord, CrossTierAccessEvent } from '../src/index.js'

interface Doc {
  id: string
  title: string
  body: string
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

async function freshVault() {
  const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner' })
  const vault = await db.openVault('v1', { passphrase: 'pw' })
  return { db, vault }
}

describe('v0.18 hierarchical access', () => {
  describe('#205 tier put + get', () => {
    it('stores _tier on envelopes for non-zero tiers', async () => {
      const { db, vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
      await docs.putAtTier('d1', { id: 'd1', title: 'Top', body: 'secret' }, 2)
      const store = (db as unknown as { options: { store: NoydbStore } }).options.store
      const env = await store.get('v1', 'docs', 'd1')
      expect(env!._tier).toBe(2)
      expect(env!._data).not.toContain('secret')
    })

    it('does not store _tier for tier 0', async () => {
      const { db, vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
      await docs.putAtTier('d1', { id: 'd1', title: 'Public', body: 'ok' }, 0)
      const store = (db as unknown as { options: { store: NoydbStore } }).options.store
      const env = await store.get('v1', 'docs', 'd1')
      expect(env!._tier).toBeUndefined()
    })

    it('getAtTier decrypts when the caller has the tier DEK', async () => {
      const { vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
      const record = { id: 'd1', title: 'Top', body: 'secret' }
      await docs.putAtTier('d1', record, 2)
      const out = await docs.getAtTier('d1')
      expect(out).toEqual(record)
    })

    it('throws when putting at a tier not declared on the collection', async () => {
      const { vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
      await expect(docs.putAtTier('d1', { id: 'd1', title: 't', body: 'b' }, 5)).rejects.toThrow(/not declared/)
    })
  })

  describe('#207 invisibility mode', () => {
    it('returns null when the caller lacks the tier DEK', async () => {
      const { vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
      await docs.putAtTier('d1', { id: 'd1', title: 'Secret', body: 'x' }, 1)
      // Strip the tier-1 DEK from the keyring to simulate a lower-tier user.
      const kr = (vault as unknown as { keyring: { deks: Map<string, CryptoKey> } }).keyring
      kr.deks.delete('docs#1')
      const result = await docs.getAtTier('d1')
      expect(result).toBeNull()
    })

    it('listAtTier omits above-tier ids in invisibility mode', async () => {
      const { vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
      await docs.putAtTier('d0', { id: 'd0', title: 'Public', body: 'ok' }, 0)
      await docs.putAtTier('d1', { id: 'd1', title: 'Secret', body: 'x' }, 1)
      const kr = (vault as unknown as { keyring: { deks: Map<string, CryptoKey> } }).keyring
      kr.deks.delete('docs#1')
      const list = await docs.listAtTier()
      expect(list.map(r => r.id)).toEqual(['d0'])
    })
  })

  describe('#208 ghost mode', () => {
    it('returns a GhostRecord placeholder instead of null', async () => {
      const { vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1], tierMode: 'ghost' })
      await docs.putAtTier('d1', { id: 'd1', title: 'Hidden', body: 'y' }, 1)
      const kr = (vault as unknown as { keyring: { deks: Map<string, CryptoKey> } }).keyring
      kr.deks.delete('docs#1')
      const result = (await docs.getAtTier('d1')) as GhostRecord
      expect(result).toEqual({ _ghost: true, _tier: 1 })
    })

    it('listAtTier marks above-tier ids as not readable in ghost mode', async () => {
      const { vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1], tierMode: 'ghost' })
      await docs.putAtTier('d0', { id: 'd0', title: 'Public', body: 'ok' }, 0)
      await docs.putAtTier('d1', { id: 'd1', title: 'Secret', body: 'x' }, 1)
      const kr = (vault as unknown as { keyring: { deks: Map<string, CryptoKey> } }).keyring
      kr.deks.delete('docs#1')
      const list = await docs.listAtTier()
      const ghost = list.find(r => r.id === 'd1')
      expect(ghost).toEqual({ id: 'd1', tier: 1, readable: false })
    })
  })

  describe('#206 elevate / demote', () => {
    it('elevate rewraps record with higher-tier DEK', async () => {
      const { db, vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
      await docs.putAtTier('d1', { id: 'd1', title: 't', body: 'b' }, 0)
      await docs.elevate('d1', 2)

      const store = (db as unknown as { options: { store: NoydbStore } }).options.store
      const env = await store.get('v1', 'docs', 'd1')
      expect(env!._tier).toBe(2)
      expect(env!._elevatedBy).toBe('owner')
    })

    it('owner can demote after elevate', async () => {
      const { vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
      await docs.putAtTier('d1', { id: 'd1', title: 't', body: 'b' }, 0)
      await docs.elevate('d1', 2)
      await docs.demote('d1', 0)
      const out = (await docs.getAtTier('d1')) as Doc
      expect(out.title).toBe('t')
    })

    it('demote by non-elevator-non-owner throws', async () => {
      const { vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
      await docs.putAtTier('d1', { id: 'd1', title: 't', body: 'b' }, 0)
      await docs.elevate('d1', 2)

      // Mutate the keyring to pretend we're a different non-owner user.
      const kr = (vault as unknown as { keyring: { userId: string; role: string } }).keyring
      kr.userId = 'charlie'
      kr.role = 'operator'
      await expect(docs.demote('d1', 0)).rejects.toBeInstanceOf(TierDemoteDeniedError)
    })

    it('putAtTier without the tier DEK throws TierNotGrantedError for non-admin roles', async () => {
      const { vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
      // Simulate an operator whose keyring has tier-1 but not tier-2.
      await docs.putAtTier('seed', { id: 'seed', title: 's', body: 'b' }, 1)
      const kr = (vault as unknown as { keyring: { deks: Map<string, CryptoKey>; role: string } }).keyring
      kr.deks.delete('docs#2')
      kr.role = 'operator'
      expect(kr.deks.has('docs#2')).toBe(false)
      await expect(docs.putAtTier('d2', { id: 'd2', title: 't', body: 'b' }, 2))
        .rejects.toBeInstanceOf(TierNotGrantedError)
    })
  })

  describe('#210 cross-tier audit', () => {
    it('fires onCrossTierAccess on put at tier > 0', async () => {
      const { vault } = await freshVault()
      const events: CrossTierAccessEvent[] = []
      vault.onCrossTierAccess(e => events.push(e))
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
      await docs.putAtTier('d1', { id: 'd1', title: 't', body: 'b' }, 1)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ op: 'put', tier: 1, collection: 'docs', id: 'd1' })
    })

    it('does not fire for tier-0 puts', async () => {
      const { vault } = await freshVault()
      const events: CrossTierAccessEvent[] = []
      vault.onCrossTierAccess(e => events.push(e))
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
      await docs.putAtTier('d0', { id: 'd0', title: 't', body: 'b' }, 0)
      expect(events).toHaveLength(0)
    })

    it('fires on elevate with authorization: "elevation"', async () => {
      const { vault } = await freshVault()
      const events: CrossTierAccessEvent[] = []
      vault.onCrossTierAccess(e => events.push(e))
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
      await docs.putAtTier('d1', { id: 'd1', title: 't', body: 'b' }, 0)
      await docs.elevate('d1', 2)
      const elev = events.find(e => e.op === 'elevate')
      expect(elev).toMatchObject({ authorization: 'elevation', tier: 2 })
    })
  })

  describe('#209 delegation tokens', () => {
    it('issueDelegation writes an encrypted envelope to _delegations', async () => {
      const { db, vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
      // Seed tier-1 DEK.
      await docs.putAtTier('seed', { id: 'seed', title: 's', body: 'b' }, 1)
      const token = await vault.delegate({
        toUser: 'owner',
        tier: 1,
        collection: 'docs',
        until: new Date(Date.now() + 60_000).toISOString(),
      })
      expect(token.id).toBeTruthy()
      const store = (db as unknown as { options: { store: NoydbStore } }).options.store
      const ids = await store.list('v1', '_delegations')
      expect(ids).toContain(token.id)
    })

    it('revokeDelegation removes the envelope', async () => {
      const { db, vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
      await docs.putAtTier('seed', { id: 'seed', title: 's', body: 'b' }, 1)
      const token = await vault.delegate({
        toUser: 'owner',
        tier: 1,
        collection: 'docs',
        until: new Date(Date.now() + 60_000).toISOString(),
      })
      await vault.revokeDelegation(token.id)
      const store = (db as unknown as { options: { store: NoydbStore } }).options.store
      expect(await store.get('v1', '_delegations', token.id)).toBeNull()
    })
  })

  it('tiers disabled by default throws on putAtTier', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('docs')
    await expect(docs.putAtTier('d1', { id: 'd1', title: 't', body: 'b' }, 1))
      .rejects.toThrow(/tiers are not enabled/)
  })
})
