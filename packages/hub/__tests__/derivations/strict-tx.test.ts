import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { withDerivation } from '../../src/derivations/index.js'
import { withTransactions } from '../../src/tx/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
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
        const [vname, cname, id] = key.split('/')
        if (vname === v) {
          out[cname] = out[cname] ?? {}
          out[cname][id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c])) {
          data.set(k(v, c, i), payload[c][i])
        }
      }
    },
  }
}

interface Pdf extends Record<string, unknown> { id: string; body: string }

describe('Derivation strict mode + withTransactions', () => {
  it('rolls back source write if derive throws', async () => {
    const strategy = withDerivation<Pdf, { meta: { len: number } }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => { throw new Error('always-fails') },
      lifecycle: 'eager',
      strict: true,
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-strict-passphrase-2026',
      derivationStrategies: [strategy],
      txStrategy: withTransactions(),
    })
    const v = await db.openVault('demo')
    await expect(
      db.transaction(async (tx) => {
        tx.vault('demo').collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'x' })
      }),
    ).rejects.toThrow('always-fails')
    const pdf = await v.collection<Pdf>('pdfs').get('p1')
    expect(pdf).toBeNull()  // rolled back
  })

  it('non-strict mode commits source even if derive fails', async () => {
    const strategy = withDerivation<Pdf, { meta: { len: number } }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => { throw new Error('soft-fail') },
      lifecycle: 'eager',
      // strict: false (default)
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-nonstrict-passphrase-2026',
      derivationStrategies: [strategy],
      txStrategy: withTransactions(),
    })
    const v = await db.openVault('demo')
    await db.transaction(async (tx) => {
      tx.vault('demo').collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'x' })
    })
    const pdf = await v.collection<Pdf>('pdfs').get('p1')
    expect(pdf).not.toBeNull()  // committed
    const meta = await v.collection('pdf-meta').get('p1')
    expect(meta).toBeNull()  // derive failed, output absent
  })
})
