/**
 * Type-level tests for `.crossJoin({ outer })` — #1130.
 *
 * The runtime half of `outer` is three lines; the typing is the part with real
 * blast radius, because the alias widens to `TTarget | null` ONLY under
 * `outer: true`. Getting that wrong in either direction is silent:
 *
 *   - too narrow (`TTarget` under `outer: true`) hands the caller a `null` the
 *     compiler swears cannot happen — the original bug with extra steps;
 *   - too wide (`TTarget | null` by default) forces every existing inner-mode
 *     consumer to null-check something that never occurs.
 *
 * Neither shows up in a runtime test, which is why these assertions exist.
 * Validated by `pnpm --filter @noy-db/hub run typecheck`.
 */
import { describe, it, expectTypeOf } from 'vitest'
import { Query } from '../src/kernel/query/index.js'
import type { QuerySource, JoinContext } from '../src/kernel/query/index.js'

interface Bill { id: string; entityId: string }
interface Client { id: string; entityId: string; name: string }

declare const source: QuerySource<Bill>
declare const jc: JoinContext
const base = (): Query<Bill> =>
  new Query(source, { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] }, jc)

describe('crossJoin outer typing', () => {
  it('defaults to a NON-null alias', () => {
    const rows = base()
      .crossJoin<Client, 'client'>('clients', { as: 'client', on: () => [] })
      .toArray()
    expectTypeOf(rows[0]!.client).toEqualTypeOf<Client>()
  })

  it('outer: true widens the alias to TTarget | null', () => {
    const rows = base()
      .crossJoin<Client, 'client', true>('clients', { as: 'client', outer: true, on: () => [] })
      .toArray()
    expectTypeOf(rows[0]!.client).toEqualTypeOf<Client | null>()
  })

  it('an explicit outer: false stays non-null', () => {
    const rows = base()
      .crossJoin<Client, 'client', false>('clients', { as: 'client', outer: false, on: () => [] })
      .toArray()
    expectTypeOf(rows[0]!.client).toEqualTypeOf<Client>()
  })

  it('the left fields survive either mode', () => {
    const rows = base()
      .crossJoin<Client, 'client', true>('clients', { as: 'client', outer: true, on: () => [] })
      .toArray()
    expectTypeOf(rows[0]!.id).toEqualTypeOf<string>()
    expectTypeOf(rows[0]!.entityId).toEqualTypeOf<string>()
  })
})
