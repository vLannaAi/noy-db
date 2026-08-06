/**
 * Type-level tests for the retired strategy option keys (#993).
 * Validated by `pnpm --filter @noy-db/hub typecheck:types` (tsc only; never executed).
 *
 * `#873` renamed four `NoydbOptions` keys. Because the old keys were simply
 * absent from the interface, TypeScript's excess-property check answered them
 * with the nearest known key by edit distance — `txStrategy` was reported as
 * "Did you mean to write `crdtStrategy`?", a suggestion that, if trusted,
 * silently enables a CRDT strategy while the caller believes they fixed the
 * rename.
 *
 * Declaring the old keys as `never` makes the excess-property check match OUR
 * key and surface OUR `@deprecated` message instead of guessing.
 */
import { describe, it, expectTypeOf } from 'vitest'
import type { NoydbOptions } from '../src/kernel/types.js'

describe('retired strategy option keys are declared, not absent', () => {
  it('carries the four renamed keys so the compiler names the right replacement', () => {
    expectTypeOf<NoydbOptions>().toHaveProperty('blobStrategy')
    expectTypeOf<NoydbOptions>().toHaveProperty('indexStrategy')
    expectTypeOf<NoydbOptions>().toHaveProperty('txStrategy')
    expectTypeOf<NoydbOptions>().toHaveProperty('aggregateStrategy')
  })

  it('types them as unusable — optional `never`, so nothing can be assigned', () => {
    expectTypeOf<NoydbOptions['txStrategy']>().toEqualTypeOf<undefined>()
    expectTypeOf<NoydbOptions['blobStrategy']>().toEqualTypeOf<undefined>()
    expectTypeOf<NoydbOptions['indexStrategy']>().toEqualTypeOf<undefined>()
    expectTypeOf<NoydbOptions['aggregateStrategy']>().toEqualTypeOf<undefined>()
  })

  it('keeps the replacement keys assignable', () => {
    expectTypeOf<NoydbOptions>().toHaveProperty('blobsStrategy')
    expectTypeOf<NoydbOptions>().toHaveProperty('indexingStrategy')
    expectTypeOf<NoydbOptions>().toHaveProperty('transactionsStrategy')
    expectTypeOf<NoydbOptions>().toHaveProperty('reduceStrategy')
  })
})
