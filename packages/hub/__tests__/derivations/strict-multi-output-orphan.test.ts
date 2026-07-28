import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { withDerivation } from '../../src/with-formula/derivations/index.js'
import { withTransactions } from '../../src/with-commit/tx/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function toMemory(): NoydbStore {
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

interface Src extends Record<string, unknown> { id: string; payload: string }
interface Good extends Record<string, unknown> { value: number }
interface Bad extends Record<string, unknown> { value: number }

describe('Strict-mode derivation multi-output orphan (#133)', () => {
  it('rolls back early-written outputs when a later strategy throws (strict)', async () => {
    // Two strategies on the same source. Strategy A succeeds and writes
    // its output via Collection.put — that write recurses through the
    // adapter and (pre-fix) is invisible to the transaction's revert
    // plan. Strategy B then throws in strict mode, propagating out of
    // dispatchDerivations. The outer tx revert rolls back the source op
    // but leaves Strategy A's output orphaned.
    const stratGood = withDerivation<Src, { good: Good }>({
      source: 'src',
      deterministic: true,
      outputs: { good: { shape: 'record', collection: 'good' } },
      derive: () => ({ good: { value: 1 } }),
      strict: true,
      lifecycle: 'eager',
    })
    const stratBad = withDerivation<Src, { bad: Bad }>({
      source: 'src',
      deterministic: true,
      outputs: { bad: { shape: 'record', collection: 'bad' } },
      derive: () => { throw new Error('strategy-B-fail') },
      strict: true,
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'derivation-orphan-133-secret-2026',
      derivationStrategies: [stratGood, stratBad],
      transactionsStrategy: withTransactions(),
    })
    const v = await db.openVault('demo')

    await expect(
      db.transaction(async (tx) => {
        tx.vault('demo').collection<Src>('src').put('id1', { id: 'id1', payload: 'data' })
      }),
    ).rejects.toThrow('strategy-B-fail')

    // Source must be absent (rolled back).
    expect(await v.collection<Src>('src').get('id1')).toBeNull()
    // The early-written 'good' output must also be absent (this is the
    // orphan the fix addresses — pre-fix this assertion fails).
    expect(await v.collection<Good>('good').get('id1')).toBeNull()
    // 'bad' was never produced.
    expect(await v.collection<Bad>('bad').get('id1')).toBeNull()
  })

  it('non-strict mode commits source AND successful outputs even when a later strategy fails', async () => {
    const stratGood = withDerivation<Src, { good: Good }>({
      source: 'src',
      deterministic: true,
      outputs: { good: { shape: 'record', collection: 'good' } },
      derive: () => ({ good: { value: 1 } }),
      // strict: false (default)
      lifecycle: 'eager',
    })
    const stratBad = withDerivation<Src, { bad: Bad }>({
      source: 'src',
      deterministic: true,
      outputs: { bad: { shape: 'record', collection: 'bad' } },
      derive: () => { throw new Error('soft-fail') },
      // strict: false (default)
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'derivation-orphan-133-nonstrict-secret-2026',
      derivationStrategies: [stratGood, stratBad],
      transactionsStrategy: withTransactions(),
    })
    const v = await db.openVault('demo')

    await db.transaction(async (tx) => {
      tx.vault('demo').collection<Src>('src').put('id1', { id: 'id1', payload: 'data' })
    })

    // Source committed.
    expect(await v.collection<Src>('src').get('id1')).not.toBeNull()
    // Strategy A's output is present.
    expect(await v.collection<Good>('good').get('id1')).not.toBeNull()
    // Strategy B's output is absent — its derive threw and was logged.
    expect(await v.collection<Bad>('bad').get('id1')).toBeNull()
  })

  it('rolls back early-written outputs when putMany({ atomic: true }) hits a strict failure mid-batch (#133)', async () => {
    // Two strategies on the same source — strategy A succeeds, strategy B's derive throws.
    // The bulk-atomic path runs its own Phase 2 loop (NOT runTransaction);
    // pre-fix it never published an _activeTxContext, so derived outputs
    // written for id1 by Strategy A before Strategy B threw were
    // orphaned. The fix wraps Phase 2 with the same set/clear pattern.
    const stratGood = withDerivation<Src, { good: Good }>({
      source: 'src',
      deterministic: true,
      outputs: { good: { shape: 'record', collection: 'good' } },
      derive: (s) => ({ good: { value: s.payload.length } }),
      strict: true,
      lifecycle: 'eager',
    })
    const stratBad = withDerivation<Src, { bad: Bad }>({
      source: 'src',
      deterministic: true,
      outputs: { bad: { shape: 'record', collection: 'bad' } },
      derive: () => { throw new Error('always-fails') },
      strict: true,
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'derivation-orphan-133-putmany-secret-2026',
      derivationStrategies: [stratGood, stratBad],
    })
    const v = await db.openVault('demo')

    await expect(
      v.collection<Src>('src').putMany(
        [
          ['id1', { id: 'id1', payload: 'data' }],
          ['id2', { id: 'id2', payload: 'data2' }],
        ],
        { atomic: true },
      ),
    ).rejects.toThrow()

    // After atomic failure: source should NOT have either id1 or id2.
    expect(await v.collection<Src>('src').get('id1')).toBeNull()
    expect(await v.collection<Src>('src').get('id2')).toBeNull()
    // Derived 'good' outputs that were written for id1 BEFORE id2's
    // strategyBad threw must also be absent (the orphan-window fix).
    expect(await v.collection<Good>('good').get('id1')).toBeNull()
    expect(await v.collection<Good>('good').get('id2')).toBeNull()
  })
})
