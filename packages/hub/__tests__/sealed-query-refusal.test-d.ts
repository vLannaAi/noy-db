/**
 * Type-level tests for sensitive-field refusal in the Query DSL.
 * Validated by `pnpm --filter @noy-db/hub typecheck:types` (tsc only; never executed).
 */
import { describe, it, expectTypeOf } from 'vitest'
import { createNoydb, sum } from '../src/index.js'
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

describe('index-declaration sensitive-field refusal', () => {
  it('refuses indexing / det-encrypting / text-indexing a sensitive field', async () => {
    const vault = await typedVault()
    vault.collection<Person, 'ssn'>('a', {
      sensitive: ['ssn'],
      // @ts-expect-error — cannot put a sealed field in a plaintext index
      indexes: ['ssn'],
    })
    vault.collection<Person, 'ssn'>('b', {
      sensitive: ['ssn'],
      // @ts-expect-error — cannot put a sealed field in a composite index
      indexes: [{ fields: ['name', 'ssn'] }],
    })
    vault.collection<Person, 'ssn'>('c', {
      sensitive: ['ssn'],
      // @ts-expect-error — sealed field cannot be deterministically encrypted here
      deterministicFields: ['ssn'],
    })
    vault.collection<Person, 'ssn'>('ct', {
      sensitive: ['ssn'],
      // @ts-expect-error — sealed field cannot be lexically (text-)indexed here
      textIndexes: ['ssn'],
    })
    // Non-sensitive fields index fine on the same collection:
    vault.collection<Person, 'ssn'>('d', { sensitive: ['ssn'], indexes: ['name', 'age'] })
  })

  it('keeps index options permissive without sensitive fields', async () => {
    const vault = await typedVault()
    vault.collection<Person>('e', { indexes: ['anything', { fields: ['x', 'y'] }] })
  })
})

describe('groupBy sensitive-field refusal', () => {
  it('refuses groupBy on a sensitive field; allows non-sensitive', async () => {
    const vault = await typedVault()
    const people = vault.collection<Person, 'ssn'>('people', { sensitive: ['ssn'] })
    const q = people.query()
    // @ts-expect-error — grouping BY a sealed field leaks its values as group keys
    q.groupBy('ssn')
    q.groupBy('name')              // ok
    // @ts-expect-error — multi-field groupBy also refuses a sealed field
    q.groupBy('name', 'ssn')
    q.groupBy('name', 'age')       // ok
  })

  it('keeps groupBy permissive without sensitive fields', async () => {
    const vault = await typedVault()
    const plain = vault.collection<Person>('plain')
    plain.query().groupBy('ssn')           // S = never -> any field
    plain.query().groupBy('name', 'age')
  })
})

describe('Q = indexed-only where() refusal (opt-in 3rd generic)', () => {
  interface Rec { id: string; name: string; ssn: string; status: string }
  it('restricts where() to indexed fields; orderBy stays free', async () => {
    const vault = await typedVault()
    const c = vault.collection<Rec, never, 'status'>('c', { indexes: ['status'] })
    c.query().where('status', '==', 'x')          // ok — indexed
    // @ts-expect-error — 'name' is not indexed; use .scan()
    c.query().where('name', '==', 'x')
    c.query().orderBy('name')                      // ok — orderBy NOT Q-restricted
  })
  it('single-generic / no-Q stays permissive (zero churn)', async () => {
    const vault = await typedVault()
    const c = vault.collection<Rec>('c2', { indexes: ['status'] })
    c.query().where('anything', '==', 'x')         // Q = never -> string
  })
  it('Q composes with S: where = indexed minus sensitive', async () => {
    const vault = await typedVault()
    const c = vault.collection<Rec, 'ssn', 'status' | 'ssn'>('c3', { sensitive: ['ssn'], indexes: ['status'] })
    c.query().where('status', '==', 'x')           // ok
    // @ts-expect-error — ssn is indexed-declared but sensitive -> still refused
    c.query().where('ssn', '==', 'x')
  })
  it('ties the indexes array to Q (no drift)', async () => {
    const vault = await typedVault()
    // @ts-expect-error — 'region' not in declared Q 'status'
    vault.collection<Rec, never, 'status'>('c4', { indexes: ['region'] })
  })
})

describe('aggregate() builder-form sensitive refusal', () => {
  it('refuses a sensitive field in the builder form; bare-spec form unchanged', async () => {
    const vault = await typedVault()
    const people = vault.collection<Person, 'ssn'>('people', { sensitive: ['ssn'] })
    const q = people.query()
    q.aggregate(b => ({ total: b.sum('age'), n: b.count() }))   // ok
    // @ts-expect-error — sensitive field refused in the typed builder form
    q.aggregate(b => ({ bad: b.sum('ssn') }))
    // bare-spec form still compiles (unrefused, back-compat):
    q.aggregate({ total: sum('age') })
  })
})

describe('scan().aggregate() builder-form sensitive refusal', () => {
  it('refuses a sensitive field in the scan builder form; bare-spec unchanged', async () => {
    const vault = await typedVault()
    const people = vault.collection<Person, 'ssn'>('people', { sensitive: ['ssn'] })
    const s = people.scan()
    s.aggregate(b => ({ total: b.sum('age'), n: b.count() }))   // ok
    // @ts-expect-error — sensitive field refused in the typed scan builder form
    s.aggregate(b => ({ bad: b.sum('ssn') }))
    s.aggregate({ total: sum('age') })   // bare-spec still compiles
  })
})
