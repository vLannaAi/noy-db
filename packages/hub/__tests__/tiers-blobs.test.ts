/**
 * #724 — an elevated record's blob content must be invisible to a tier-0
 * caller. Task 1: the runtime read gate. collection.blob(id) consults the
 * owning record's _tier before returning bytes, exactly as get() does.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withBlobs } from '../src/via/blob/index.js'
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

describe('#724 blob read gate', () => {
  it('a tiered collection with blobFields constructs (Arc-7 refusal removed)', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    expect(() => vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })).not.toThrow()
  })

  it('elevating a blob-owning record hides its blob from a tier-0 caller', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('sensitive attachment bytes'))

    await docs.putAtTier('d2', { id: 'd2', title: 'Memo', body: 'y' }, 0)
    await docs.blob('d2').put('attachment', new TextEncoder().encode('sibling attachment bytes'))

    // Both readable before elevation.
    expect(await docs.blob('d1').get('attachment')).not.toBeNull()
    expect(await docs.blob('d2').get('attachment')).not.toBeNull()

    await docs.elevate('d1', 1)

    // The tier-0 read surface correctly treats the elevated record as invisible.
    await expect(docs.get('d1')).resolves.toBeNull()

    // The blob surface now mirrors that gate.
    expect(await docs.blob('d1').get('attachment')).toBeNull()

    // A sibling tier-0 record's blob is unaffected.
    const stillThere = await docs.blob('d2').get('attachment')
    expect(stillThere).not.toBeNull()
    expect(new TextDecoder().decode(stillThere!)).toBe('sibling attachment bytes')
  })
})

describe('#724 blob metadata gate', () => {
  it('list/blobInfo/listVersions on an elevated record are invisible to a tier-0 caller', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('sensitive attachment bytes'))

    await docs.putAtTier('d2', { id: 'd2', title: 'Memo', body: 'y' }, 0)
    await docs.blob('d2').put('attachment', new TextEncoder().encode('sibling attachment bytes'))

    // Metadata visible before elevation.
    expect(await docs.blob('d1').list()).not.toHaveLength(0)
    expect(await docs.blob('d1').blobInfo('attachment')).not.toBeNull()

    await docs.elevate('d1', 1)

    // The metadata accessors now mirror the content gate: invisible.
    expect(await docs.blob('d1').list()).toEqual([])
    expect(await docs.blob('d1').blobInfo('attachment')).toBeNull()
    expect(await docs.blob('d1').listVersions('attachment')).toEqual([])

    // A sibling tier-0 record's metadata is unaffected — the gate is
    // targeted, not global.
    expect(await docs.blob('d2').list()).not.toHaveLength(0)
    expect(await docs.blob('d2').blobInfo('attachment')).not.toBeNull()
  })
})
