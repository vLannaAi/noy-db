/**
 * Public-surface contract: the sealed-field access types (#504) are importable
 * from the package barrel `@noy-db/hub`, so consumers can annotate sealed reads
 * without reaching into internal modules. Validated by
 * `pnpm --filter @noy-db/hub typecheck:types` (tsc only). A missing barrel
 * export makes this file fail to compile.
 */
import { describe, it, expectTypeOf } from 'vitest'
// Import from the package entry (the barrel), NOT from ../src/types.js — that
// is the whole point of this test.
import { SealedHandle } from '../src/index.js'
import type { Sealed, SealedView } from '../src/index.js'

interface Person { id: string; name: string; ssn: string }

describe('sealed-field types are on the public barrel', () => {
  it('Sealed<V> is the opaque handle contract', () => {
    expectTypeOf<Sealed<string>['sealed']>().toEqualTypeOf<true>()
    expectTypeOf<Sealed<string>['reveal']>().toEqualTypeOf<() => Promise<string>>()
  })

  it('SealedView<T, S> maps sealed fields to handles, keeps the rest', () => {
    type V = SealedView<Person, 'ssn'>
    expectTypeOf<V['ssn']>().toEqualTypeOf<Sealed<string>>()
    expectTypeOf<V['name']>().toEqualTypeOf<string>()
    // Identity when nothing is sealed.
    expectTypeOf<SealedView<Person, never>>().toEqualTypeOf<Person>()
  })

  it('SealedHandle is exported as a value (for instanceof narrowing)', () => {
    // A SealedHandle instance satisfies the Sealed<V> contract.
    expectTypeOf<InstanceType<typeof SealedHandle<string>>>().toMatchTypeOf<Sealed<string>>()
  })
})
