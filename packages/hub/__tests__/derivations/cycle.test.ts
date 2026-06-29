import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, DerivationCycleError, ValidationError } from '../../src/index.js'
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
        if (vname === v && cname !== undefined && id !== undefined) {
          out[cname] = out[cname] ?? {}
          out[cname]![id] = env
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

describe('Derivation cycle detection at vault open', () => {
  it('rejects a self-write output without denorm at construction (#376 — was a self-cycle)', () => {
    // A record output back to its own source is now a self-write
    // reverse-denorm (#376) and MUST declare `denorm`. An undeclared
    // self-write — the old "self-cycle" — is rejected earlier, at
    // withDerivation() construction, rather than by vault-open DFS.
    expect(() =>
      withDerivation({
        source: 'a',
        deterministic: true,
        outputs: { o: { shape: 'record', collection: 'a' } },
        derive: () => ({ o: {} }),
        lifecycle: 'eager',
      }),
    ).toThrow(ValidationError)
  })

  it('refuses A -> B -> A', async () => {
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
      secret: 'derivation-cycle-ab-passphrase-2026',
      derivationStrategies: [a, b],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
  })

  it('refuses A -> B -> C -> A', async () => {
    const make = (source: string, output: string) => withDerivation({
      source,
      deterministic: true,
      outputs: { o: { shape: 'record', collection: output } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-cycle-abc-passphrase-2026',
      derivationStrategies: [make('a', 'b'), make('b', 'c'), make('c', 'a')],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
  })

  it('accepts an acyclic graph (A -> B -> C)', async () => {
    const make = (source: string, output: string) => withDerivation({
      source,
      deterministic: true,
      outputs: { o: { shape: 'record', collection: output } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-cycle-acyclic-passphrase-2026',
      derivationStrategies: [make('a', 'b'), make('b', 'c')],
    })
    await expect(db.openVault('demo')).resolves.toBeDefined()
  })

  it('cycle error carries the path', async () => {
    const make = (source: string, output: string) => withDerivation({
      source,
      deterministic: true,
      outputs: { o: { shape: 'record', collection: output } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-cycle-path-passphrase-2026',
      derivationStrategies: [make('a', 'b'), make('b', 'a')],
    })
    try {
      await db.openVault('demo')
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(DerivationCycleError)
      const cycle = (e as DerivationCycleError).path
      // path should include 'a' and 'b' and end where it started
      expect(cycle.length).toBeGreaterThanOrEqual(2)
      expect(cycle).toContain('a')
      expect(cycle).toContain('b')
    }
  })
})
