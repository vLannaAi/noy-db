// #1458 fixture — the same file, plus the one-line side-effect import.
// Everything below must compile, and the alias must be typed.
import { Query } from '../../../src/kernel/query/index.js'
import '../../../src/kernel/query/relate/index.js'

interface Row { id: string; clientId: string }
interface Client { id: string; name: string }

export function withRelate(q: Query<Row>): unknown[] {
  const rows = q.where('clientId', '==', 'c1').orderBy('id').limit(5).toArray()
  const joined = q.join<'client', Client>('clientId', { as: 'client' }).toArray()
  // The alias is typed `Client | null` on a left join — read it to prove the
  // augmentation carried the GENERICS, not just the method name.
  const names = joined.map(row => row.client?.name ?? '(none)')
  return [rows, joined, names]
}
