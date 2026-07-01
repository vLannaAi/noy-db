/**
 * M-3 (security): the derivations fanout sidecar must be encrypted under the
 * collection DEK, not written as plaintext JSON. A ciphertext-only store must
 * not be able to read the derivation graph / `keys[]` / `emittedAt`.
 *
 * Back-compat: legacy plaintext sidecars (`_iv === ''`) must still read.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation } from '../../src/index.js'
import { generateDEK } from '../../src/kernel/enclave/crypto.js'
import { NOYDB_FORMAT_VERSION } from '../../src/kernel/types.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'
import {
  saveFanoutSidecar,
  loadFanoutSidecar,
} from '../../src/with-formula/derivations/fanout-sidecar.js'

function memoryWithData(): { store: NoydbStore; data: Map<string, EncryptedEnvelope> } {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  const store = {
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
    async get(v: string, c: string, i: string) { return data.get(k(v, c, i)) ?? null },
    async put(v: string, c: string, i: string, env: EncryptedEnvelope) { data.set(k(v, c, i), env) },
    async delete(v: string, c: string, i: string) { data.delete(k(v, c, i)) },
    async list(v: string, c: string) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v: string) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/')
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
        }
      }
      return out
    },
    async saveAll(v: string, payload: Record<string, Record<string, EncryptedEnvelope>>) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  } as unknown as NoydbStore
  return { store, data }
}

interface Tagged extends Record<string, unknown> {
  id: string
  tags: string[]
}

interface TagRow extends Record<string, unknown> {
  id: string
  sourceId: string
  tag: string
}

async function buildDb(store: NoydbStore) {
  const strategy = withDerivation<Tagged, { tagRows: TagRow[] }>({
    source: 'docs',
    deterministic: true,
    outputs: {
      tagRows: {
        shape: 'array',
        collection: 'docTags',
        key: (o) => `${o.sourceId as string}|${o.tag as string}`,
        maxFanout: 36,
      },
    },
    derive: (doc) => ({
      tagRows: doc.tags.map(tag => ({ id: `${doc.id}|${tag}`, sourceId: doc.id, tag })),
    }),
    lifecycle: 'eager',
  })
  const db = await createNoydb({
    store,
    user: 'alice',
    secret: 'correct horse battery staple printer toaster',
    derivationStrategies: [strategy],
  })
  const vault = await db.openVault('acme')
  return { db, vault }
}

describe('M-3 — fanout sidecar encryption', () => {
  it('writes the sidecar as ciphertext (not plaintext JSON) in an encrypted vault', async () => {
    const { store, data } = memoryWithData()
    const { vault } = await buildDb(store)
    const docs = vault.collection<Tagged>('docs')
    await docs.put('d1', { id: 'd1', tags: ['alpha', 'beta'] })

    // Locate the sidecar envelope in the raw store.
    const sidecarKey = [...data.keys()].find(key => key.includes('/_meta/derivations-fanout/'))
    expect(sidecarKey).toBeDefined()
    const env = data.get(sidecarKey!)!
    // Encrypted: a real IV, and the body is NOT plaintext JSON.
    expect(env._iv).not.toBe('')
    let leaked = false
    try {
      const parsed = JSON.parse(env._data) as { _noydb_fanout?: number }
      leaked = parsed._noydb_fanout === 1
    } catch { /* ciphertext is not JSON — good */ }
    expect(leaked).toBe(false)
  })

  it('the array derivation diff still works end-to-end (shrink removes orphans)', async () => {
    const { store } = memoryWithData()
    const { vault } = await buildDb(store)
    const docs = vault.collection<Tagged>('docs')
    const tagRows = vault.collection<TagRow>('docTags')

    await docs.put('d1', { id: 'd1', tags: ['alpha', 'beta'] })
    expect(await tagRows.get('d1|alpha')).toBeDefined()
    expect(await tagRows.get('d1|beta')).toBeDefined()

    // Shrink: drop 'beta'.
    await docs.put('d1', { id: 'd1', tags: ['alpha'] })
    expect(await tagRows.get('d1|alpha')).toBeDefined()
    expect(await tagRows.get('d1|beta')).toBeNull()
  })

  it('unit: encrypt round-trips through load', async () => {
    const { store } = memoryWithData()
    const dek = await generateDEK()
    const getDEK = async () => dek
    await saveFanoutSidecar(store, 'v', { source: 'docs', sourceId: 'd1', outputKey: 'tagRows', outputCollection: 'docTags', keys: ['a', 'b'] }, getDEK, true)
    const loaded = await loadFanoutSidecar(store, 'v', 'docs', 'd1', 'tagRows', getDEK, true)
    expect(loaded?.keys).toEqual(['a', 'b'])
  })

  it('unit: legacy plaintext sidecar (_iv==="") still reads', async () => {
    const { store } = memoryWithData()
    const dek = await generateDEK()
    const getDEK = async () => dek
    // Hand-write a legacy plaintext sidecar.
    const legacyDoc = {
      _noydb_fanout: 1, source: 'docs', sourceId: 'd1', outputKey: 'tagRows',
      outputCollection: 'docTags', keys: ['x', 'y'], emittedAt: new Date().toISOString(),
    }
    await store.put('v', '_meta', 'derivations-fanout/docs/d1/tagRows', {
      _noydb: NOYDB_FORMAT_VERSION, _v: 1, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify(legacyDoc),
    } as EncryptedEnvelope)
    const loaded = await loadFanoutSidecar(store, 'v', 'docs', 'd1', 'tagRows', getDEK, true)
    expect(loaded?.keys).toEqual(['x', 'y'])
  })
})
