import { describe, it, expect } from 'vitest'
import { createNoydb, withGuard } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

// Minimal in-test memory store — follows the hub convention (see __tests__/refs.test.ts etc.)
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

describe('Vault.guardRegistry wiring', () => {
  it('createNoydb accepts guardStrategies and the registry receives them', async () => {
    const handle = withGuard<{ id: string; status: string }>({
      collection: 'widgets',
      check: async () => { throw new Error('always blocks') },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-vault-wiring-passphrase-2026',
      guardStrategies: [handle],
    })
    const vault = await db.openVault('demo')
    const reg = (vault as any)._getGuardRegistry()
    expect(reg.guardsFor('widgets')).toHaveLength(1)
    expect(reg.guardsFor('absent')).toHaveLength(0)
  })

  it('createNoydb works without guardStrategies (null registry)', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-vault-wiring-empty-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    // After #130: vaults that never register a guardStrategy keep
    // the registry `null` so the GuardRegistry class chunk stays out
    // of the floor bundle. Callers must gate on null (Collection.put
    // does so via `if (this.guardSource)` — see `vault.collection()`).
    const reg = (vault as any)._getGuardRegistry()
    expect(reg).toBeNull()
  })
})
