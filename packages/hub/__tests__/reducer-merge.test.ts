import { describe, it, expect } from 'vitest'
import { sum, count, avg, min, max } from '../src/with-lookup/aggregate/reducers.js'

function stateOf(r: any, records: unknown[]) { let s = r.init(); for (const rec of records) s = r.step(s, rec); return s }

describe('Reducer.merge', () => {
  const A = [{ v: 10 }, { v: 20 }]
  const B = [{ v: 30 }]
  const cases: [string, () => any][] = [
    ['sum', () => sum('v')], ['count', () => count()], ['avg', () => avg('v')], ['min', () => min('v')], ['max', () => max('v')],
  ]
  for (const [name, make] of cases) {
    it(`${name}: merge is present, commutative, identity, and merge-then-finalize == reduce(A∪B)`, () => {
      const r = make()
      expect(typeof r.merge).toBe('function')
      const sA = stateOf(r, A), sB = stateOf(r, B)
      const whole = r.finalize(stateOf(r, [...A, ...B]))
      expect(r.finalize(r.merge(sA, sB))).toEqual(whole)              // merge-then-finalize == reduce over concatenation
      expect(r.finalize(r.merge(sB, sA))).toEqual(whole)              // commutative
      expect(r.finalize(r.merge(r.init(), sA))).toEqual(r.finalize(sA)) // identity (init is neutral)
    })
  }
  it('associativity (sum)', () => {
    const r = sum('v')
    const a = stateOf(r, [{v:1}]), b = stateOf(r, [{v:2}]), c = stateOf(r, [{v:3}])
    expect(r.finalize(r.merge!(r.merge!(a, b), c))).toEqual(r.finalize(r.merge!(a, r.merge!(b, c))))
  })
})
