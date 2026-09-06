// #1458 fixture — Find alone. `.join()` must NOT compile here.
// Driven by `__tests__/1458-query-tiers-types.test.ts`; not part of any
// normal typecheck program (see that file for why it cannot be).
import { Query } from '../../../src/kernel/query/index.js'

interface Row { id: string; clientId: string }

export function findOnly(q: Query<Row>): unknown[] {
  // Find compiles.
  const rows = q.where('clientId', '==', 'c1').orderBy('id').limit(5).toArray()
  // Relate does not: the method's type arrives with '@noy-db/hub/query/relate'.
  const joined = q.join<'client', { id: string }>('clientId', { as: 'client' }).toArray()
  return [rows, joined]
}
