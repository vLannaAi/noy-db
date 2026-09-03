/**
 * Money variants of the #1353 statistical reducers.
 *
 * The whole point is that a money median comes off the EXACT BigInt path, not
 * a float round-trip: `wrapMoneyReducers` rewrites `median` / `percentile` over
 * a declared money field into scaled-integer reducers, and the interpolation
 * between the two middle values is done in BigInt with half-even rounding —
 * the same rounding the rest of the money module uses.
 *
 * The reducers that CANNOT be exact over money (`avg` already, plus `variance`,
 * `stddev`, `mode`, and the t-digest `approx` percentile) refuse loudly rather
 * than reading a scaled-integer string through `readNumber` and returning 0.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import {
  median,
  percentile,
  variance,
  stddev,
  mode,
  moneyMedian,
  moneyPercentile,
  withReduce,
} from '../../src/with-lookup/reduce/index.js'
import { z } from 'zod'
import { money } from '../../src/via/money/descriptor.js'
import { MoneyUnsupportedError } from '../../src/via/money/descriptor.js'
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
        if (vname === v) { out[cname!] = out[cname!] ?? {}; out[cname!]![id!] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) { data.set(k(v, c, i), payload[c]![i]!) }
      }
    },
  }
}

interface Line extends Record<string, unknown> { id: string; total: number | string }

async function linesWith(totals: readonly string[]) {
  const db = await createNoydb({
    store: toMemory(),
    user: 'alice',
    secret: 'money-stat-reducers-secret-2026-exact-path',
    reduceStrategy: withReduce(),
  })
  const vault = await db.openVault('books')
  const lines = vault.collection<Line>('lines', {
    schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
    moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
  })
  let i = 0
  for (const total of totals) await lines.put(`r${i++}`, { id: `r${i}`, total })
  return lines
}

describe('money median / percentile — exact BigInt path', () => {
  it('median of an odd count is the middle money value', async () => {
    const lines = await linesWith(['0.10', '0.20', '0.30'])
    const r = await lines.query().aggregate({ m: moneyMedian('total') }).run()
    expect(r.m).toBe('0.20')
  })

  it('median of an even count interpolates in scaled space (percentile_cont)', async () => {
    const lines = await linesWith(['0.10', '0.20', '0.30', '0.45'])
    const r = await lines.query().aggregate({ m: moneyMedian('total') }).run()
    expect(r.m).toBe('0.25')
  })

  it('a half-unit midpoint rounds HALF-EVEN, in both directions', async () => {
    // (10 + 15) / 2 = 12.5 scaled units → 12 (12 is even)
    expect((await (await linesWith(['0.10', '0.15'])).query().aggregate({ m: moneyMedian('total') }).run()).m).toBe('0.12')
    // (10 + 25) / 2 = 17.5 scaled units → 18 (17 is odd)
    expect((await (await linesWith(['0.10', '0.25'])).query().aggregate({ m: moneyMedian('total') }).run()).m).toBe('0.18')
  })

  it('stays exact past Number.MAX_SAFE_INTEGER', async () => {
    const lines = await linesWith(['90000000000000000.01', '90000000000000000.03'])
    const r = await lines.query().aggregate({ m: moneyMedian('total') }).run()
    expect(r.m).toBe('90000000000000000.02')
    // A float round-trip cannot even hold the inputs apart:
    expect(Number('90000000000000000.01')).toBe(Number('90000000000000000.03'))
  })

  it('percentile p=0 / p=1 are the exact extremes, p=0.9 interpolates exactly', async () => {
    const lines = await linesWith(['1.00', '2.00', '3.00', '4.00', '5.00'])
    const r = await lines.query().aggregate({
      lo: moneyPercentile('total', 0),
      hi: moneyPercentile('total', 1),
      p90: moneyPercentile('total', 0.9),
    }).run()
    expect(r.lo).toBe('1.00')
    expect(r.hi).toBe('5.00')
    // x = 0.9*(5-1) = 3.6 → 4.00 + 0.6*(5.00-4.00) = 4.60
    expect(r.p90).toBe('4.60')
  })

  it('an empty money result set is null', async () => {
    const lines = await linesWith([])
    const r = await lines.query().aggregate({ m: moneyMedian('total') }).run()
    expect(r.m).toBeNull()
  })

  it('the plain median()/percentile() factories get the same rewrite', async () => {
    const lines = await linesWith(['0.10', '0.20', '0.30', '0.45'])
    const r = await lines.query().aggregate({ m: median('total'), p: percentile('total', 1) }).run()
    expect(r.m as unknown).toBe('0.25')
    expect(r.p as unknown).toBe('0.45')
  })
})

describe('money — the reducers that refuse', () => {
  const cases = [
    ['variance', () => variance('total')],
    ['stddev', () => stddev('total')],
    ['mode', () => mode('total')],
    ['approx percentile', () => percentile('total', 0.5, { approx: true })],
  ] as const

  for (const [name, make] of cases) {
    it(`${name}() over a money field throws MoneyUnsupportedError`, async () => {
      const lines = await linesWith(['0.10', '0.20'])
      expect(
        () => lines.query().aggregate({ x: make() as never }).run(),
      ).toThrow(MoneyUnsupportedError)
    })
  }
})
