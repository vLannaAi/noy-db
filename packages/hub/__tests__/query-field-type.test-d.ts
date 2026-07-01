import { describe, it, expectTypeOf } from 'vitest'
import type { QueryField, IndexFieldName } from '../src/kernel/types.js'

interface Person { id: string; name: string; ssn: string; age: number }

describe('QueryField<T, S>', () => {
  it('is permissive `string` when no sensitive fields (S = never)', () => {
    // The zero-churn guarantee: collections without `sensitive` keep `field: string`.
    expectTypeOf<QueryField<Person>>().toEqualTypeOf<string>()
    expectTypeOf<QueryField<Person, never>>().toEqualTypeOf<string>()
  })

  it('narrows to non-sensitive field names when S is populated', () => {
    expectTypeOf<QueryField<Person, 'ssn'>>().toEqualTypeOf<'id' | 'name' | 'age'>()
  })

  it('IndexFieldName mirrors QueryField', () => {
    expectTypeOf<IndexFieldName<Person>>().toEqualTypeOf<string>()
    expectTypeOf<IndexFieldName<Person, 'ssn'>>().toEqualTypeOf<'id' | 'name' | 'age'>()
  })
})
