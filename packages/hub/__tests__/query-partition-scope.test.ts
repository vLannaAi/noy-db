/**
 * `JoinLeg.partitionScope` — the dormant partition seam, and the one trap
 * that makes populating it dangerous (#1342).
 *
 * `partitionScope` is documented as plumbing for partition-aware execution:
 * always `'all'`, never read by an executor. What that documentation does NOT
 * say — and what this file pins — is that the field is inside every stored
 * materialized-view `queryHash`. `QueryPlan.joins` is serialized VERBATIM by
 * `serializePlan()`, and `computeQueryHash()` hashes the canonicalized plan
 * whole, so `partitionScope` is a hash input on every joined MV written to
 * date.
 *
 * ⛔ THE CONSEQUENCE, for whoever implements partition scoping: populating
 * this field at plan-build time SILENTLY INVALIDATES every stored MV whose
 * query narrows — a stale-row rebuild with no error and no warning. #1289 hit
 * the near-miss version of this and dodged it by omitting `direction` from
 * the leg when it holds its default (`builder.ts`, `directionField`). That
 * escape is NOT available here: `partitionScope: 'all'` is not omitted, it is
 * baked into every join plan hashed so far. So an implementation must
 *
 *   (a) keep emitting `partitionScope: 'all'` verbatim for an unnarrowed leg
 *       — "cleaning it up" by omission moves every existing hash — and
 *   (b) treat the one-time invalidation of narrowing MVs as a release note,
 *       not a discovery.
 *
 * ⭐ The cheaper route, and the recommendation on #1342: derive the scope in
 * the EXECUTOR from clauses already in the plan and leave the leg alone. It
 * is a derived value; storing it buys nothing and costs the hash.
 *
 * These tests are expected to be EDITED, not deleted, when scoping lands —
 * the third one is the one that will fail, and its failure is the notice.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { ref } from '../src/kernel/refs.js'
import type { JoinLeg } from '../src/kernel/query/join.js'
import {
  canonicalizeQueryPlan,
  computeQueryHash,
} from '../src/with-formula/materialized-views/query-hash.js'

/** Inline memory adapter — same shape as `query-join.test.ts`. */
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) {
      const coll = store.get(c)?.get(col)
      return coll ? [...coll.keys()] : []
    },
    async loadAll(c) {
      const comp = store.get(c)
      const snapshot: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          snapshot[n] = r
        }
      }
      return snapshot
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [name, coll] of existing) {
        if (name.startsWith('_')) comp.set(name, coll)
      }
      store.set(c, comp)
    },
  }
}

interface Client { id: string; name: string; period: string }
interface Invoice { id: string; amount: number; period: string; clientId: string | null }

describe('JoinLeg.partitionScope (#1342)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({ store: toMemory(), user: 'owner', secret: 'partition-scope-2026' })
  })

  async function seed(): Promise<{
    invoices: ReturnType<Awaited<ReturnType<Noydb['openVault']>>['collection']>
  }> {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', { refs: { clientId: ref('clients') } })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', period: 'FY2026-Q1' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, period: 'FY2026-Q1', clientId: 'cli-A' })
    return { invoices: invoices as unknown as ReturnType<typeof c.collection> }
  }

  /** The plan's join legs, read back through the public `toPlan()`. */
  function legsOf(plan: unknown): readonly JoinLeg[] {
    return (plan as { joins: readonly JoinLeg[] }).joins
  }

  it('every eager join direction plans a leg scoped to all partitions', async () => {
    const { invoices } = await seed()
    const q = invoices.query() as unknown as {
      join(f: string, o: { as: string }): typeof q
      rightJoin(f: string, o: { as: string }): typeof q
      fullOuterJoin(f: string, o: { as: string }): typeof q
      where(f: string, op: string, v: unknown): typeof q
      toPlan(): unknown
    }

    // A `where()` on a field that WOULD be a plausible partition key changes
    // nothing today — that is the dormancy this pins.
    for (const built of [
      q.join('clientId', { as: 'client' }).toPlan(),
      q.rightJoin('clientId', { as: 'client' }).toPlan(),
      q.fullOuterJoin('clientId', { as: 'client' }).toPlan(),
      q.where('period', '==', 'FY2026-Q1').join('clientId', { as: 'client' }).toPlan(),
    ]) {
      const legs = legsOf(built)
      expect(legs).toHaveLength(1)
      expect(legs[0]!.partitionScope).toBe('all')
    }
  })

  it('a streaming scan join plans the same all-partitions leg', async () => {
    const { invoices } = await seed()
    // ScanBuilder keeps its legs private and exposes no `toPlan()`; the cast
    // is deliberate — the invariant is about the leg the planner BUILDS, and
    // this is the only site that builds one outside `builder.ts`.
    const sb = (invoices as unknown as {
      scan(): { join(f: string, o: { as: string }): { joins: readonly JoinLeg[] } }
    }).scan().join('clientId', { as: 'client' })
    expect(sb.joins).toHaveLength(1)
    expect(sb.joins[0]!.partitionScope).toBe('all')
  })

  it('partitionScope is a queryHash input — narrowing it, or omitting it, moves the hash', async () => {
    const { invoices } = await seed()
    const plan = (invoices.query() as unknown as {
      join(f: string, o: { as: string }): { toPlan(): unknown }
    }).join('clientId', { as: 'client' }).toPlan() as { joins: JoinLeg[] }

    // It really is in the bytes that get hashed.
    expect(canonicalizeQueryPlan(plan)).toContain('"partitionScope":"all"')

    const deps = new Set(['invoices', 'clients'])
    const hashOf = async (p: unknown): Promise<string> =>
      computeQueryHash('mv', deps, canonicalizeQueryPlan(p))

    const today = await hashOf(plan)

    // (a) Populating the scope moves the hash — every stored MV whose query
    //     narrows is invalidated the day scoping ships.
    const narrowed = { ...plan, joins: [{ ...plan.joins[0]!, partitionScope: ['FY2026-Q1'] }] }
    expect(await hashOf(narrowed)).not.toBe(today)

    // (b) And "tidying up" by omitting the default moves the hash for EVERY
    //     joined MV, narrowing or not. That is the escape #1289 used for
    //     `direction`, and it is not available here.
    const { partitionScope: _dropped, ...withoutScope } = plan.joins[0]!
    expect(await hashOf({ ...plan, joins: [withoutScope] })).not.toBe(today)
  })
})
