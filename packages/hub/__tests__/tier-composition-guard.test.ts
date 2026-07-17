/**
 * Arc 7 (#724 + tier-composition guard) of the tier-invisibility campaign.
 *
 * Part 1 (#724 verification) originally proved that `collection.blob(id)`
 * leaked blob content for an elevated (`_tier > 0`) record: a caller whose
 * keyring never held the record's elevated tier DEK — someone
 * `collection.get(id)` correctly reports the record as invisible to — could
 * still fully read the record's blob attachments. Arc 10 Task 1 closed that
 * leak with an unconditional runtime read gate on `collection.blob(id)`
 * (see `tiers-blobs.test.ts`), so this reproduction now asserts the fixed
 * behavior instead.
 *
 * Part 2 was the Arc-7 refusal (`UnsupportedTierCompositionError` at
 * `vault.collection()` registration for `tiers` + `blobFields`). Arc 10
 * Task 1 removed that refusal — the composition is now allowed, and the
 * runtime read gate (not construction-time refusal) is what protects an
 * elevated record's blob content.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, withSearch } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

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

describe('#724 — blob content on an elevated record is gated (Arc 10 Task 1)', () => {
  it('a caller without the elevated tier DEK no longer reads blob content via collection.blob()', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    // No `blobFields` declared — basic blob put/get never required it, and
    // the runtime gate applies regardless of whether `blobFields` is declared.
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    const secret = new TextEncoder().encode('sensitive attachment bytes')
    await docs.blob('d1').put('receipt.pdf', secret)

    await docs.elevate('d1', 1)

    // The tier-0 read surface correctly treats the elevated record as invisible.
    await expect(docs.get('d1')).resolves.toBeNull()

    // Simulate a caller whose keyring never held the tier-1 DEK — the exact
    // clearance `collection.get()`/`getAtTier()` require to see this record.
    const kr = (vault as unknown as { keyring: { deks: Map<string, CryptoKey> } }).keyring
    kr.deks.delete('docs#1')
    expect(kr.deks.has('docs#1')).toBe(false)

    // The blob surface now mirrors `get()`'s gate: not visible.
    const got = await docs.blob('d1').get('receipt.pdf')
    expect(got).toBeNull()
  })
})

describe('tier + blobFields composition (Arc-7 refusal removed — #724)', () => {
  it('tiers + blobFields constructs fine and the blob is reachable at tier 0', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], blobFields: { receipt: {} } })

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    const bytes = new TextEncoder().encode('unelevated attachment bytes')
    await docs.blob('d1').put('receipt', bytes)

    const got = await docs.blob('d1').get('receipt')
    expect(got).not.toBeNull()
    expect(new TextDecoder().decode(got!)).toBe('unelevated attachment bytes')
  })

  it('tiers alone still constructs fine', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    expect(() => vault.collection<Doc>('docs', { tiers: [0, 1] })).not.toThrow()
  })

  it('blobFields alone (no tiers) still constructs fine', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner', blobStrategy: withBlobs() })
    const vault = await db.openVault('v1')
    expect(() => vault.collection<Doc>('docs', { blobFields: { receipt: {} } })).not.toThrow()
  })

  it('tiers + field indexes still constructs fine', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    expect(() => vault.collection<Doc>('docs', { tiers: [0, 1], indexes: [{ fields: ['title'] }] })).not.toThrow()
  })

  it('tiers + textIndexes still constructs fine', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    expect(() => vault.collection<Doc>('docs', { tiers: [0, 1], textIndexes: ['title'] })).not.toThrow()
  })

  it('tiers + embeddings still constructs fine', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), searchStrategy: withSearch(),
    })
    const vault = await db.openVault('v1')
    const encoder = {
      dim: 4, model: 'stub', source: 'text' as const,
      encode: async (t: string) => { const v = new Float32Array(4); for (let i = 0; i < t.length; i++) v[i % 4] = (v[i % 4] ?? 0) + 1; return v },
    }
    expect(() => vault.collection<Doc>('docs', { tiers: [0, 1], embeddings: encoder })).not.toThrow()
  })

  it('tiers + withHistory still constructs fine (must NOT regress — ledger is threaded by default)', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), historyStrategy: withHistory(),
    })
    const vault = await db.openVault('v1')
    expect(() => vault.collection<Doc>('docs', { tiers: [0, 1] })).not.toThrow()
  })
})
