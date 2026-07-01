import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) {
          out[cname] = out[cname] ?? {}
          out[cname][id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  }
}

interface Pdf extends Record<string, unknown> { id: string; body: string }

describe('vault.deriveAll', () => {
  it('re-derives every record in the source collection', async () => {
    let version = 1
    const strategy = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s: Pdf) => ({ meta: { len: s.body.length, version } }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-deriveall-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'a' })
    await v.collection<Pdf>('pdfs').put('p2', { id: 'p2', body: 'bb' })
    version = 2
    const result = await v.deriveAll('pdfs')
    expect(result.derived).toBe(2)
    expect(result.failed).toBe(0)
    const m1 = await v.collection<any>('pdf-meta').get('p1')
    const m2 = await v.collection<any>('pdf-meta').get('p2')
    expect(m1.version).toBe(2)
    expect(m2.version).toBe(2)
  })

  it('returns zero counts when no strategy targets the collection', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-deriveall-empty-passphrase-2026',
    })
    const v = await db.openVault('demo')
    const result = await v.deriveAll('absent')
    expect(result.derived).toBe(0)
    expect(result.failed).toBe(0)
  })
})
