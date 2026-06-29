/**
 * Type-level tests for sensitive-field refusal in the Query DSL.
 * Validated by `pnpm --filter @noy-db/hub typecheck:types` (tsc only; never executed).
 *
 * NOTE: TypeScript does not support partial type argument inference — when T is
 * explicit, S defaults to `readonly []` (not inferred from the `sensitive` array).
 * The correct form when creating a collection is to provide both T and S:
 *   vault.collection<Person, readonly ['ssn']>('people', { sensitive: ['ssn'] })
 * Or to let both be inferred from the call site. For the type-test below,
 * module-level typed constants are used to keep assertions focused.
 */
import { describe, it, expectTypeOf } from 'vitest'
import { createNoydb } from '../src/index.js'
import { memoryStore } from '../src/store/memory-store.js'
import type { Query } from '../src/query/builder.js'

interface Person { id: string; name: string; ssn: string; age: number }

// Typed constants — valid TypeScript module-level declarations used for type assertions.
// `null!` is the standard "typed never-null" pattern for type-only test files.
const qSealed = null! as Query<Person, 'ssn'>    // collection with sensitive: ['ssn']
const qPlain = null! as Query<Person>             // collection with no sensitive fields

describe('Query sensitive-field refusal', () => {
  it('refuses where() on a sensitive field, allows non-sensitive', () => {
    // @ts-expect-error — 'ssn' is sealed; refused at compile time
    qSealed.where('ssn', '==', 'x')
    qSealed.where('name', '==', 'Ada')        // ok
    qSealed.orderBy('age', 'desc')            // ok
    // @ts-expect-error — orderBy on a sealed field is refused
    qSealed.orderBy('ssn')
  })

  it('keeps where() permissive on a collection with no sensitive fields', () => {
    // No `sensitive` → S = never → field stays `string`, every existing call still compiles.
    qPlain.where('ssn', '==', 'x').orderBy('whatever-string')
    expectTypeOf(qPlain.where).parameter(0).toEqualTypeOf<string>()
  })

  it('collection().query() returns Query<T, S> — integration smoke', async () => {
    // Use both type args (required by TypeScript's partial inference rules)
    const db = await createNoydb({ store: memoryStore(), user: 'test', secret: 'x'.repeat(12) })
    const vault = await db.openVault('v')
    const people = vault.collection<Person, readonly ['ssn']>('people', { sensitive: ['ssn'] })
    const q = people.query()
    // @ts-expect-error — where on sealed field is refused
    q.where('ssn', '==', 'x')
    q.where('name', '==', 'Ada')   // ok
    // @ts-expect-error — orderBy on sealed field is refused
    q.orderBy('ssn')
  })
})
