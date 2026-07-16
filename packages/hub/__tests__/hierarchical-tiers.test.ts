/**
 * v0.18 hierarchical access — tier DEKs, invisibility/ghost, elevate/demote,
 * delegation, cross-tier audit.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, TierNotGrantedError, TierDemoteDeniedError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { rewrapBodyToDek, buildDeleteMarker } from '../src/kernel/enclave/index.js'
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
  const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner', tiersStrategy: withTiers() })
  const vault = await db.openVault('v1')
  return { db, vault }
}

describe('v0.18 hierarchical access', () => {
  describe('tier put + get', () => {
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

  describe('invisibility mode', () => {
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

  describe('ghost mode', () => {
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

  describe('elevate / demote', () => {
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

    it('putAtTier over a record at a tier the caller lacks throws TierNotGrantedError and mints NO from-tier DEK (#712 whole-branch fix-1)', async () => {
      const { vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1, 2] })
      // Owner mints both tier-1 and tier-2 DEKs, then parks d1 at tier 2.
      await docs.putAtTier('seed', { id: 'seed', title: 's', body: 'b' }, 1)
      await docs.putAtTier('d1', { id: 'd1', title: 'Top', body: 'secret' }, 2)

      // Simulate an operator whose keyring holds tier-1 but NOT tier-2 —
      // cleared for the TARGET tier of the call below, but not for the
      // EXISTING tier of the record it targets.
      const kr = (vault as unknown as { keyring: { deks: Map<string, CryptoKey>; role: string } }).keyring
      kr.deks.delete('docs#2')
      kr.role = 'operator'
      expect(kr.deks.has('docs#1')).toBe(true)
      expect(kr.deks.has('docs#2')).toBe(false)

      // putAtTier(d1, ..., 1): target tier 1 is granted, but d1 currently
      // sits at tier 2, which this caller was never cleared for. Before the
      // fix, the from-tier `getDEK('docs#2')` inside the history-rewrap path
      // would silently MINT a fresh tier-2 DEK into this keyring. It must
      // instead throw before ever reaching that mint.
      await expect(docs.putAtTier('d1', { id: 'd1', title: 'Moved', body: 'x' }, 1))
        .rejects.toBeInstanceOf(TierNotGrantedError)

      // No bogus docs#2 DEK was minted as a side effect of the refused call.
      expect(kr.deks.has('docs#2')).toBe(false)
    })
  })

  describe('cross-tier audit', () => {
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

  describe('delegation tokens', () => {
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

  describe('sealed fields at tier > 0 (#635)', () => {
    it('getAtTier surfaces a sealed field on a tier>0 record instead of silently omitting it', async () => {
      const { db, vault } = await freshVault()
      // Sealed under the collection's tier-0 DEK (no perRecordKeys → legacy,
      // DEK-derived sealed key — the trickier of the two derivations, since
      // it is NOT the tier DEK the record's body ends up wrapped under).
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1], sensitive: ['body'] })
      await docs.put('d1', { id: 'd1', title: 'Top', body: 'classified payload' })

      const store = (db as unknown as { options: { store: NoydbStore } }).options.store
      const tier0Env = (await store.get('v1', 'docs', 'd1'))!
      expect(tier0Env._sealed?.body).toBeDefined()

      // Hand-construct the tier>0 envelope `elevate()` would produce IF it
      // carried `_sealed` forward (a separate, pre-existing gap — see the
      // task report; not exercised here so this test isolates the getAtTier
      // read-side fix under #635). Sealed slots are CEK-/tier-0-DEK-derived,
      // never tier-DEK-derived (tier writes never seal fields), so `_sealed`
      // survives a body re-wrap to a different tier's DEK unchanged.
      const getDEK = (vault as unknown as { getDEK(name: string): Promise<CryptoKey> }).getDEK
      const tier0Dek = await getDEK('docs')
      const tier1Dek = await getDEK('docs#1')
      const body = await rewrapBodyToDek(tier0Env, tier0Dek, tier1Dek)
      const tier1Env: EncryptedEnvelope = {
        ...tier0Env,
        _v: tier0Env._v + 1,
        _iv: body._iv,
        _data: body._data,
        _tier: 1,
        ...(body._cek !== undefined ? { _cek: body._cek } : {}),
        ...(tier0Env._sealed !== undefined ? { _sealed: tier0Env._sealed } : {}),
      }
      await store.put('v1', 'docs', 'd1', tier1Env)

      const out = await docs.getAtTier('d1') as Doc
      expect(out.title).toBe('Top')
      // Pre-fix this was `undefined` — a silent omission, not a crash.
      expect(out.body).toBe('classified payload')
    })
  })

  describe('elevate/demote preserve every envelope slot on a tier move (#662)', () => {
    it('elevate carries _sealed forward', async () => {
      const { db, vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1], sensitive: ['body'] })
      await docs.put('d1', { id: 'd1', title: 'Top', body: 'classified payload' })

      const store = (db as unknown as { options: { store: NoydbStore } }).options.store
      const tier0Env = (await store.get('v1', 'docs', 'd1'))!
      const sealed0 = tier0Env._sealed!.body
      expect(sealed0).toBeDefined()

      await docs.elevate('d1', 1)

      const tier1Env = (await store.get('v1', 'docs', 'd1'))!
      expect(tier1Env._tier).toBe(1)
      // Pre-fix: the field-literal rebuild dropped `_sealed` entirely.
      expect(tier1Env._sealed?.body).toBe(sealed0)

      const out = await docs.getAtTier('d1') as Doc
      expect(out.body).toBe('classified payload')
    })

    it('demote round-trips _sealed', async () => {
      const { db, vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1], sensitive: ['body'] })
      await docs.put('d1', { id: 'd1', title: 'Top', body: 'classified payload' })

      const store = (db as unknown as { options: { store: NoydbStore } }).options.store
      const tier0Env = (await store.get('v1', 'docs', 'd1'))!
      const sealed0 = tier0Env._sealed!.body

      await docs.elevate('d1', 1)
      await docs.demote('d1', 0)

      const tier0EnvAfter = (await store.get('v1', 'docs', 'd1'))!
      expect(tier0EnvAfter._tier).toBeUndefined()
      expect(tier0EnvAfter._elevatedBy).toBeUndefined()
      // Pre-fix: the field-literal rebuild dropped `_sealed` entirely.
      expect(tier0EnvAfter._sealed?.body).toBe(sealed0)

      const out = await docs.getAtTier('d1') as Doc
      expect(out.body).toBe('classified payload')
    })

    it('a sibling passenger slot (_source/_sourceTs) also survives elevate', async () => {
      // `_det` (deterministicFields) needs an extra `acknowledgeDeterministicRisk:
      // true` opt-in; provenance's `_source`/`_sourceTs` needs only
      // `{ provenance: true }` plus a `source` option on `put()`, so it's the
      // simplest sibling slot to exercise here.
      const { db, vault } = await freshVault()
      const docs = vault.collection<Doc>('docs', { tiers: [0, 1], provenance: true })
      await docs.put('d1', { id: 'd1', title: 'Top', body: 'b' }, { source: 'registry-A' })

      const store = (db as unknown as { options: { store: NoydbStore } }).options.store
      const tier0Env = (await store.get('v1', 'docs', 'd1'))!
      expect(tier0Env._source).toBe('registry-A')
      const sourceTs0 = tier0Env._sourceTs

      await docs.elevate('d1', 1)

      const tier1Env = (await store.get('v1', 'docs', 'd1'))!
      expect(tier1Env._tier).toBe(1)
      // Pre-fix: the field-literal rebuild dropped `_source`/`_sourceTs` entirely.
      expect(tier1Env._source).toBe('registry-A')
      expect(tier1Env._sourceTs).toBe(sourceTs0)
    })
  })

  it('tiers disabled by default throws on putAtTier', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('docs')
    await expect(docs.putAtTier('d1', { id: 'd1', title: 't', body: 'b' }, 1))
      .rejects.toThrow(/tiers are not enabled/)
  })
})

describe('#691 fold-ins: tier moves × record cache × tombstones', () => {
  it('elevate evicts the eager record cache — plain get() no longer serves pre-move plaintext', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    await docs.put('d1', { id: 'd1', title: 'Loose', body: 'lips' })
    expect((await docs.get('d1'))?.title).toBe('Loose') // cache warm
    await docs.elevate('d1', 1)
    // Pre-#691: the eager cache still holds the decoded record, so the plain
    // tier-0 get() serves an elevated record's plaintext with ZERO key
    // resolution. Post-fix: evicted → eager get() is cache-authoritative → null.
    expect(await docs.get('d1')).toBeNull()
    // The sanctioned surface still reads it fine in the elevating session.
    expect(((await docs.getAtTier('d1')) as Doc | null)?.title).toBe('Loose')
  })

  it('demote also evicts, and demote-to-tier-0 re-seeds the cache so plain get() stays readable', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    await docs.put('d2', { id: 'd2', title: 'Down', body: 'again' })
    await docs.elevate('d2', 1)
    await docs.demote('d2', 0)
    // After demote-to-0 the record is tier-0 again; the pre-elevate cache
    // entry must not have survived the two raw envelope rewrites in between.
    // (Eviction on both moves; a fresh getAtTier round-trips the content.)
    expect(((await docs.getAtTier('d2')) as Doc | null)?.title).toBe('Down')
    // A record demoted back to tier 0 IS a tier-0 record: it must be
    // plain-get()-readable in the same session, not just via getAtTier().
    expect((await docs.get('d2'))?.title).toBe('Down')
  })

  it('elevate/demote on a delete-marker throw not-found, not TamperedError', async () => {
    const store = memoryStore()
    const db = await createNoydb({ store, secret: 'pw', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    await docs.put('gone', { id: 'gone', title: 'x', body: 'y' })
    const live = (await store.get('v1', 'docs', 'gone'))!
    await store.put('v1', 'docs', 'gone', buildDeleteMarker(live._v, 'owner'))
    await expect(docs.elevate('gone', 1)).rejects.toThrow(/not found/)
    await expect(docs.demote('gone', 0)).rejects.toThrow(/not found/)
  })
})

describe('#702 putAtTier maintains the record cache', () => {
  it('putAtTier(tier>0) over a cached id evicts — plain get() stops serving the pre-move plaintext', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    await docs.put('p1', { id: 'p1', title: 'Old', body: 'plain' })
    expect((await docs.get('p1'))?.title).toBe('Old') // cache warm
    await docs.putAtTier('p1', { id: 'p1', title: 'New', body: 'secret' }, 1)
    // Pre-#702: the eager cache still served { title: 'Old' } — clearance-free.
    expect(await docs.get('p1')).toBeNull()
    expect(((await docs.getAtTier('p1')) as Doc | null)?.title).toBe('New')
  })

  it('putAtTier(tier 0) over a cached id re-seeds — plain get() serves the NEW content', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })
    await docs.put('p2', { id: 'p2', title: 'V1', body: 'x' })
    expect((await docs.get('p2'))?.title).toBe('V1')
    await docs.putAtTier('p2', { id: 'p2', title: 'V2', body: 'y' }, 0)
    // Pre-#702: stale 'V1' from the untouched cache.
    expect((await docs.get('p2'))?.title).toBe('V2')
  })

  it('LAZY mode: putAtTier(tier 0) over an LRU-cached id serves the NEW content (LRU evicted, adapter refetch)', async () => {
    const { vault } = await freshVault()
    const docs = vault.collection<Doc>('ldocs', { tiers: [0, 1], prefetch: false, cache: { maxRecords: 100 } })
    await docs.put('p3', { id: 'p3', title: 'L1', body: 'x' })
    expect((await docs.get('p3'))?.title).toBe('L1') // LRU warm
    await docs.putAtTier('p3', { id: 'p3', title: 'L2', body: 'y' }, 0)
    // Whole-branch review finding: syncCache's entry branch seeded only the
    // eager Map — lazy reads consult the LRU, which kept serving stale 'L1'.
    // The LRU is now evicted on every sync; the lazy miss refetches + decodes
    // the fresh tier-0 envelope via the adapter fallback.
    expect((await docs.get('p3'))?.title).toBe('L2')
    // And the tier>0 overwrite stays invisible on the lazy surface too.
    await docs.putAtTier('p3', { id: 'p3', title: 'L3', body: 'z' }, 1)
    expect(await docs.get('p3')).toBeNull()
  })
})
