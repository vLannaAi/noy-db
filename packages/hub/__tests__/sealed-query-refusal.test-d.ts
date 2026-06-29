/**
 * Type-level tests for sensitive-field refusal in the Query DSL.
 * Validated by `pnpm --filter @noy-db/hub typecheck:types` (tsc only; never executed).
 */
import { describe, it, expectTypeOf } from 'vitest'
import { createNoydb } from '../src/index.js'
import { memoryStore } from '../src/store/memory-store.js'

interface Person { id: string; name: string; ssn: string; age: number }

async function typedVault() {
  const db = await createNoydb({ store: memoryStore(), user: 'test', secret: 'x'.repeat(12) })
  return db.openVault('v')
}

describe('Query sensitive-field refusal (real vault.collection API)', () => {
  it('refuses where()/orderBy() on a sensitive field when opted in via the 2nd generic', async () => {
    const vault = await typedVault()
    const people = vault.collection<Person, 'ssn'>('people', { sensitive: ['ssn'] })
    const q = people.query()
    // @ts-expect-error — 'ssn' is sealed; refused at compile time
    q.where('ssn', '==', 'x')
    q.where('name', '==', 'Ada')        // ok
    q.orderBy('age', 'desc')            // ok
    // @ts-expect-error — orderBy on a sealed field is refused
    q.orderBy('ssn')
  })

  it('single-generic + sensitive still compiles (runtime-only, no refusal) — non-breaking', async () => {
    const vault = await typedVault()
    // No 2nd generic → S = never → field stays `string`, sensitive array still accepted.
    const people = vault.collection<Person>('people', { sensitive: ['ssn'] })
    people.query().where('ssn', '==', 'x').orderBy('whatever-string')
  })

  it('ties the runtime sensitive array to the 2nd generic (no drift)', async () => {
    const vault = await typedVault()
    // @ts-expect-error — declared sensitive 'ssn' but runtime array lists a different field
    vault.collection<Person, 'ssn'>('people', { sensitive: ['name'] })
  })

  it('plain collection (no sensitive) keeps where() permissive', async () => {
    const vault = await typedVault()
    const plain = vault.collection<Person>('plain')
    plain.query().where('anything', '==', 1).orderBy('whatever')
    expectTypeOf(plain.query().where).parameter(0).toEqualTypeOf<string>()
  })
})

describe('ScanBuilder sensitive-field refusal', () => {
  it('refuses scan().where() on a sensitive field', async () => {
    const vault = await typedVault()
    const people = vault.collection<Person, 'ssn'>('people', { sensitive: ['ssn'] })
    const s = people.scan()
    // @ts-expect-error — sealed field refused in scan
    s.where('ssn', '==', 'x')
    s.where('age', '>', 18)  // ok
  })

  it('keeps scan().where() permissive without sensitive fields', async () => {
    const vault = await typedVault()
    const plain = vault.collection<Person>('plain')
    plain.scan().where('any-string', '==', 1)  // still `string`
  })
})

describe('LazyQuery sensitive-field refusal', () => {
  it('refuses lazyQuery().where()/orderBy() on a sensitive field', async () => {
    const vault = await typedVault()
    // lazyQuery requires lazy mode (prefetch: false)
    const people = vault.collection<Person, 'ssn'>('people', { sensitive: ['ssn'], prefetch: false })
    const lq = people.lazyQuery()
    // @ts-expect-error — sealed field refused in lazy where
    lq.where('ssn', '==', 'x')
    lq.where('name', '==', 'Ada')   // ok
    // @ts-expect-error — sealed field refused in lazy orderBy
    lq.orderBy('ssn')
  })
})
