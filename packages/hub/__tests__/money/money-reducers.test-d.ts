/**
 * Type contract for the money-typed reducer constructors (`moneySum` /
 * `moneyMin` / `moneyMax`). These exist so aggregations over a declared money
 * field carry the correct `MoneyString` result type instead of the `number`
 * that `wrapMoneyReducers` makes a lie at runtime — see `moneySum`'s doc.
 * Validated by `pnpm --filter @noy-db/hub typecheck:types` (tsc only).
 */
import { describe, it, expectTypeOf } from 'vitest'
import { moneySum, moneyMin, moneyMax, sum } from '../../src/with-lookup/reduce/index.js'
import { Reducer } from '../../src/with-lookup/reduce/index.js'
import type { MoneyString } from '../../src/via/money/branded.js'

describe('money reducer constructors — type contract', () => {
  it('moneySum is Reducer<MoneyString> (not number)', () => {
    expectTypeOf(moneySum('paid')).toEqualTypeOf<Reducer<MoneyString>>()
    // The whole point: distinct from sum()'s Reducer<number>.
    expectTypeOf(moneySum('paid')).not.toEqualTypeOf(sum('paid'))
  })

  it('moneyMin / moneyMax are Reducer<MoneyString | null> (null on empty, like min/max)', () => {
    expectTypeOf(moneyMin('paid')).toEqualTypeOf<Reducer<MoneyString | null>>()
    expectTypeOf(moneyMax('paid')).toEqualTypeOf<Reducer<MoneyString | null>>()
  })

  it('a MoneyString result is usable as a string with no cast', () => {
    type Result = ReturnType<ReturnType<typeof moneySum>['finalize']>
    expectTypeOf<Result>().toEqualTypeOf<MoneyString>()
    // MoneyString is a branded string — assignable to string at the boundary.
    expectTypeOf<Result>().toMatchTypeOf<string>()
  })
})
