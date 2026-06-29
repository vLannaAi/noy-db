import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, DerivationCycleError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

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
        const [vname, cname, id] = key.split('/')
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
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

describe('Vault.derivationRegistry wiring', () => {
  it('createNoydb accepts derivationStrategies', async () => {
    const handle = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => ({ meta: { len: 0 } }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-vault-wiring-passphrase-2026',
      derivationStrategies: [handle],
    })
    const vault = await db.openVault('demo')
    const reg = (vault as any)._getDerivationRegistry()
    expect(reg.strategiesForSource('pdfs')).toHaveLength(1)
    expect(reg.strategiesForSource('absent')).toHaveLength(0)
  })

  it('createNoydb works without derivationStrategies (null registry)', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-vault-wiring-empty-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    // After #130: vaults that never register a derivationStrategy keep
    // the registry `null` so the DerivationRegistry class chunk stays
    // out of the floor bundle. Callers must gate on null
    // (`Collection.dispatchDerivations` does so via `if (this.derivationSource)`).
    const reg = (vault as any)._getDerivationRegistry()
    expect(reg).toBeNull()
  })

  it('refuses to open vault with a cyclic derivation graph', async () => {
    // A → B → A cycle (an undeclared a → a self-write is now a construction
    // error, #376, so use a genuine multi-collection cycle to exercise the
    // vault-open DFS).
    const a = withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const b = withDerivation({
      source: 'b',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'a' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-vault-wiring-cycle-passphrase-2026',
      derivationStrategies: [a, b],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
  })
})
