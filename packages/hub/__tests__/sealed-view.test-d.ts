/**
 * Type-level tests for the `Sealed<V>` / `SealedView<T,S>` access surface (#504).
 *
 * These assertions are the ones the "`.test.ts` files are never typechecked"
 * gap hid: #504 introduced the `Sealed<V>` access gate so a public read of a
 * `sensitive` field returns an opaque handle, but the only coverage lived in a
 * `.test.ts` (run by vitest's esbuild, which strips types without checking) and
 * was full of `as Sealed<string>` casts — so the compiler never verified that
 * `get()` actually types a sealed field as a handle. This file pins that down
 * under `tsc`. Validated by `pnpm --filter @noy-db/hub typecheck:types`
 * (tsc only; never executed).
 */
import { describe, it, expectTypeOf } from 'vitest'
import { createNoydb } from '../src/index.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import type { Sealed, SealedView } from '../src/kernel/types.js'

interface Person { id: string; name: string; ssn: string; age: number }

async function typedVault() {
  const db = await createNoydb({ store: memoryStore(), user: 'test', secret: 'x'.repeat(12) })
  return db.openVault('v')
}

describe('Sealed<V> handle shape', () => {
  it('is a `{ sealed: true; reveal(): Promise<V> }` opaque handle', () => {
    expectTypeOf<Sealed<string>['sealed']>().toEqualTypeOf<true>()
    expectTypeOf<Sealed<string>['reveal']>().toEqualTypeOf<() => Promise<string>>()
    // It is NOT assignable from / to the bare value — a handle is not a `string`.
    expectTypeOf<Sealed<string>>().not.toEqualTypeOf<string>()
  })
})

describe('SealedView<T, S> mapping', () => {
  it('replaces each sealed field with a Sealed handle, leaves the rest', () => {
    type V = SealedView<Person, 'ssn'>
    expectTypeOf<V['ssn']>().toEqualTypeOf<Sealed<string>>()
    expectTypeOf<V['name']>().toEqualTypeOf<string>()
    expectTypeOf<V['age']>().toEqualTypeOf<number>()
  })

  it('collapses to exactly T when no fields are sealed (S = never)', () => {
    expectTypeOf<SealedView<Person, never>>().toEqualTypeOf<Person>()
  })
})

describe('get() handle typing — the surface #504 added but never compile-checked', () => {
  it('types a sensitive field as Sealed<V> when opted in via the 2nd generic', async () => {
    const vault = await typedVault()
    const people = vault.collection<Person, { sensitive: 'ssn' }>('people', { sensitive: ['ssn'] })
    const r = await people.get('id')
    // r is SealedView<Person,'ssn'> | null
    expectTypeOf<NonNullable<typeof r>['ssn']>().toEqualTypeOf<Sealed<string>>()
    expectTypeOf<NonNullable<typeof r>['name']>().toEqualTypeOf<string>()
    // reveal() decrypts to the underlying value on demand.
    expectTypeOf(r!.ssn.reveal()).toEqualTypeOf<Promise<string>>()
  })

  it('single-generic get() returns the plain value (runtime-seal only, no handle type)', async () => {
    const vault = await typedVault()
    // No 2nd generic → S = never → SealedView<Person, never> = Person.
    // This documents the #504 inference gap: the handle TYPE only appears with
    // the opt-in 2nd generic; the field is still sealed at runtime here.
    const people = vault.collection<Person>('people', { sensitive: ['ssn'] })
    const r = await people.get('id')
    expectTypeOf<NonNullable<typeof r>['ssn']>().toEqualTypeOf<string>()
  })
})
