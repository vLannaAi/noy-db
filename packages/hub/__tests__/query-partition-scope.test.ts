/**
 * `JoinLeg.partitionScope` — the dormant partition seam, and the one trap
 * that makes populating it dangerous (#1342).
 *
 * `partitionScope` is documented as plumbing for partition-aware execution:
 * always `'all'`, never read by an executor.
 *
 * ⚠️⚠️ **CORRECTED 2026-09-04.** This header, and the third test's name,
 * previously claimed the field is inside *every stored MV `queryHash`*. It is
 * not, and the file's own shape is what made the claim look measured:
 *
 *   - a **registered MV** hashes `summarizeQueryPlan()`
 *     (`materialized-views/registry.ts:201,243`), which has never emitted
 *     `partitionScope`. Its hash does not contain the field and never did.
 *   - a **hand-composed** `computeQueryHash(name, deps,
 *     canonicalizeQueryPlan(serializePlan(q)))` does contain it, because
 *     `serializePlan()` emits `plan.joins` verbatim.
 *
 * The third test builds the second composition itself and then asserts a
 * property of it — so it proved something true about a pipeline it had just
 * assembled, and said something false about the pipeline the product uses.
 * ⭐ A test that constructs the path it claims to observe cannot witness which
 * path the system actually takes. The fourth test below is the missing half:
 * it pins the REGISTRY's input, which is the one that governs stored rows.
 *
 * What this means for #1342: populating `partitionScope` does **not**
 * invalidate registered MVs. The reason to leave it alone is smaller and
 * still sufficient — it is a derived value, so storing it buys nothing, and
 * it is the one leg key emitted UNCONDITIONALLY rather than
 * omitted-at-default, so summarising it later (per #1389's rule) would move
 * every joined MV's hash at once for zero gain. Derive it in the EXECUTOR.
 *
 * ⭐ **SCOPING LANDED (#1342, 2026-09-04) AND THIS FIELD IS STILL `'all'`.**
 * ADR 0007 ruled partition-as-collection, so the scope is derived in the
 * EXECUTOR by `kernel/query/relate/partition.ts`'s `resolvePartitionScope()` from
 * the plan's top-level clause list — nothing writes it onto a leg. So these
 * tests did NOT need editing: they still pin the dormancy, and the reason
 * they pass is the reason the design is right rather than an accident.
 * Delete them only if `partitionScope` itself goes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { ref } from '../src/kernel/refs.js'
import type { JoinLeg } from '../src/kernel/query/relate/join.js'
import {
  canonicalizeQueryPlan,
  computeQueryHash,
} from '../src/with-formula/materialized-views/query-hash.js'
import { summarizeQueryPlan } from '../src/with-formula/materialized-views/dependency-analyzer.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../src/kernel/query/relate/index.js'

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

  it('partitionScope reaches a hand-composed queryHash — narrowing it, or omitting it, moves that hash', async () => {
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

  it('a REGISTERED MV never sees partitionScope — the registry hashes summarizeQueryPlan(), not serializePlan()', async () => {
    const { invoices } = await seed()
    const q = (invoices.query() as unknown as {
      join(f: string, o: { as: string }): {
        _plan(): { joins: JoinLeg[] }
        _joinContext(): unknown
      }
    }).join('clientId', { as: 'client' })

    // This is the exact input `MaterializedViewRegistry` hands to
    // `computeQueryHash` (registry.ts:201 → 243). Nothing else reaches a
    // stored `_materializedFrom.queryHash` for a Query-shaped MV.
    const summary = summarizeQueryPlan(q as never)
    expect(summary).not.toContain('partitionScope')

    // And it is INSENSITIVE to the field, which is the property that makes
    // the correction load-bearing: whoever populates the leg does not
    // invalidate a single stored MV row by doing so. `summarizeQueryPlan`
    // reads the query through `_plan()` / `_joinContext()`, so the narrowed
    // leg is injected there rather than onto the query object.
    const plan = q._plan()
    expect(plan.joins[0]!.partitionScope).toBe('all')
    const narrowed = {
      _plan: () => ({
        ...plan,
        joins: [{ ...plan.joins[0]!, partitionScope: ['FY2026-Q1'] as readonly string[] }],
      }),
      _joinContext: () => q._joinContext(),
    }
    expect(summarizeQueryPlan(narrowed as never)).toBe(summary)
  })
})
