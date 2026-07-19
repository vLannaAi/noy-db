/**
 * #764 — stuck search-index compensation ergonomics (a follow-up to #725's
 * re-review). Two asks:
 *
 * (a) A permanently stuck `PersistedIndexStore` compensation (a compensating
 *     `remove()` of a stale `_ftindex` blob, or `removePersisted()`'s own
 *     purge, that keeps failing) must be a DISTINGUISHABLE typed error
 *     (`PersistedIndexCompensationError`, cause = the raw adapter error) —
 *     not an indistinguishable raw adapter error rethrown forever. Callers
 *     that still don't opt into resilience (`retrieve()`/`warmIndex()`/
 *     `flushIndex()`) keep throwing, but now throw the typed error.
 *
 * (b) `elevate()`/`demote()` must NOT abort mid-flight when the search
 *     compensation is stuck — the record's tier-move `put` has already
 *     landed by the time `syncTierSearch` runs, so an uncaught throw there
 *     would strand `syncLedger`/`syncDerived`/`syncHistory`/`syncBlobs`
 *     behind an already-moved record (a partial-completion hazard recurring
 *     on every future tier move for the collection). The move must complete;
 *     only the search-index purge is deferred/residual — surfaced via
 *     `searchResidue: true` on the result, mirroring `forget()`'s
 *     `indexResidue` posture.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withSearch, ConflictError, PersistedIndexCompensationError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, CrossTierAccessEvent } from '../src/index.js'

interface Doc { id: string; body: string }

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

/** Wrap a store so `delete(vault, '_ftindex', collection)` ALWAYS throws — a
 *  genuinely permanent failure (store read-only), the #764 scenario. */
function readOnlyFtindexDelete(store: NoydbStore): NoydbStore {
  return {
    ...store,
    async delete(v, c, id) {
      if (c === '_ftindex') throw new Error('simulated permanent store read-only failure')
      return store.delete(v, c, id)
    },
  }
}

const SECRET = 'search-compensation-residue-passphrase-764'

describe('#764 (a) a stuck compensation is a distinguishable typed error', () => {
  it('flushIndex() throws PersistedIndexCompensationError — not the raw adapter error — once the compensation is permanently stuck; the cause is the original error', async () => {
    const store = readOnlyFtindexDelete(memoryStore())
    const db = await createNoydb({
      store, user: 'owner', secret: SECRET,
      searchStrategy: withSearch(), tiersStrategy: withTiers(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, textIndexes: ['body'], textIndexPersist: true,
    })

    await docs.put('e1', { id: 'e1', body: 'topsecret-alpha' })
    await docs.flushIndex() // initial persist is a PUT, not a delete — uninterrupted

    // elevate() drives removePersisted() — its own purge fails against the
    // read-only store. elevate() itself is resilient to this (part b) and
    // resolves, but the failure is sticky (pendingCompensation) and retried
    // by the NEXT store entrypoint.
    const result = await docs.elevate('e1', 1)
    expect(result).toEqual({ searchResidue: true })

    // flushIndex() has NOT been given the same resilience — it still throws —
    // but now throws the DISTINGUISHABLE typed error, catchable deliberately,
    // with the raw adapter error preserved as `cause`.
    let caught: unknown
    try { await docs.flushIndex() } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(PersistedIndexCompensationError)
    expect((caught as PersistedIndexCompensationError).cause).toBeInstanceOf(Error)
    expect(((caught as PersistedIndexCompensationError).cause as Error).message)
      .toBe('simulated permanent store read-only failure')
  })
})

describe('#764 (b) elevate()/demote() surface a stuck compensation as residue, not an abort', () => {
  it('elevate() completes the tier move (put lands, cross-tier event fires past syncLedger/syncDerived) and returns searchResidue: true instead of throwing', async () => {
    const store = readOnlyFtindexDelete(memoryStore())
    const db = await createNoydb({
      store, user: 'owner', secret: SECRET,
      searchStrategy: withSearch(), tiersStrategy: withTiers(),
    })
    const vault = await db.openVault('v1')
    const events: CrossTierAccessEvent[] = []
    vault.onCrossTierAccess((e) => events.push(e))
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, textIndexes: ['body'], textIndexPersist: true,
    })

    await docs.put('e1', { id: 'e1', body: 'topsecret-alpha' })
    await docs.flushIndex()

    // Pre-#764 this threw the raw adapter error out of elevate(), mid-flight —
    // after the record put but before syncLedger/syncDerived/emitCrossTierEvent/
    // syncHistory/syncBlobs. It must now resolve, with the move fully completed.
    await expect(docs.elevate('e1', 1)).resolves.toEqual({ searchResidue: true })

    // The record actually moved: the raw envelope carries the new tier.
    const env = await store.get('v1', 'docs', 'e1')
    expect(env?._tier).toBe(1)

    // emitCrossTierEvent (which runs AFTER syncLedger/syncDerived, BEFORE
    // syncHistory/syncBlobs) fired — proves the function ran past the search
    // catch to (at least) that point rather than aborting at syncSearch.
    const elev = events.find((e) => e.op === 'elevate')
    expect(elev).toMatchObject({ id: 'e1', tier: 1, authorization: 'elevation' })

    // getAtTier still resolves the record's content at the new tier — proves
    // syncHistory/syncBlobs (which run LAST) didn't themselves throw either.
    expect(await docs.getAtTier('e1')).toEqual({ id: 'e1', body: 'topsecret-alpha' })
  })

  it('demote() has the same resilience', async () => {
    const store = readOnlyFtindexDelete(memoryStore())
    const db = await createNoydb({
      store, user: 'owner', secret: SECRET,
      searchStrategy: withSearch(), tiersStrategy: withTiers(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, textIndexes: ['body'], textIndexPersist: true,
    })

    // Plain put() (tier 0) never calls removePersisted() — only markDirty() —
    // so this lands fine even against the read-only-for-_ftindex-delete store.
    await docs.put('e1', { id: 'e1', body: 'topsecret-beta' })
    // elevate() to tier 1 (resilient, part b above) — sets up a tier-1 record
    // to demote back down, without going through putAtTier's own unwrapped
    // syncSearch call (out of this issue's scope).
    await docs.elevate('e1', 1)

    const events: CrossTierAccessEvent[] = []
    vault.onCrossTierAccess((e) => events.push(e))

    await expect(docs.demote('e1', 0)).resolves.toEqual({ searchResidue: true })

    const env = await store.get('v1', 'docs', 'e1')
    expect(env?._tier).toBeUndefined() // tier 0 omits `_tier`

    const dem = events.find((e) => e.op === 'demote')
    expect(dem).toMatchObject({ id: 'e1', tier: 1 })

    // Landed back at tier 0 — plain get() must work (proves syncCache/
    // syncIndexes/syncHistory/syncBlobs all ran, not just the put).
    expect(await docs.get('e1')).toEqual({ id: 'e1', body: 'topsecret-beta' })
  })
})

describe('#774 putAtTier() has the same resilience as elevate()/demote()', () => {
  it('putAtTier(tier>0) completes the write (put lands, cross-tier event fires) and returns searchResidue: true instead of throwing', async () => {
    const store = readOnlyFtindexDelete(memoryStore())
    const db = await createNoydb({
      store, user: 'owner', secret: SECRET,
      searchStrategy: withSearch(), tiersStrategy: withTiers(),
    })
    const vault = await db.openVault('v1')
    const events: CrossTierAccessEvent[] = []
    vault.onCrossTierAccess((e) => events.push(e))
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, textIndexes: ['body'], textIndexPersist: true,
    })

    await docs.put('e1', { id: 'e1', body: 'topsecret-alpha' })
    await docs.flushIndex()

    // Pre-#774 putAtTier's own unwrapped `ctx.syncSearch` call threw the raw
    // adapter error mid-flight — after the record put but before the
    // cross-tier emit / syncHistory / syncBlobs. It must now resolve, with
    // the write fully completed, mirroring elevate()/demote()'s #764 fix.
    await expect(docs.putAtTier('e1', { id: 'e1', body: 'topsecret-alpha-v2' }, 1))
      .resolves.toEqual({ searchResidue: true })

    // The record actually moved: the raw envelope carries the new tier.
    const env = await store.get('v1', 'docs', 'e1')
    expect(env?._tier).toBe(1)

    // The cross-tier `put` event (emitted AFTER syncSearch, BEFORE
    // syncHistory/syncBlobs) fired — proves execution ran past the search
    // catch instead of aborting at syncSearch.
    const putEv = events.find((e) => e.op === 'put')
    expect(putEv).toMatchObject({ id: 'e1', tier: 1, authorization: 'inherent' })

    // getAtTier still resolves the record's content at the new tier — proves
    // syncHistory/syncBlobs (which run LAST) didn't themselves throw either.
    expect(await docs.getAtTier('e1')).toEqual({ id: 'e1', body: 'topsecret-alpha-v2' })
  })
})
