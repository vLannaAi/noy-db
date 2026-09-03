/**
 * Unique-constraint conformance across the three modes that used to refuse
 * the option outright — #1358.
 *
 * The point of this file is that NO mode passes silently. Each mode asserts
 * the SPECIFIC outcome the design promises for it:
 *
 *  1. LAZY (`prefetch: false`) — genuine PREVENTION. A duplicate `put()` is
 *     refused with `UniqueConstraintError`, resolved by a point lookup
 *     through the persisted `_idx/` mirror. Compound unique included.
 *  2. CRDT — NO prevention (it is unavailable across concurrent replicas)
 *     and DETECTION instead: the duplicate write SUCCEEDS, and a
 *     `unique:violation` event carrying a `UniqueConstraintError` names both
 *     ids — including on a later session that only meets the two records
 *     when it opens the store.
 *  3. TIERED — prevention across every tier whose DEK the writer holds, in
 *     BOTH directions (a tier-0 `put()` sees an elevated duplicate, and
 *     `putAtTier()` sees a tier-0 one). A tier the writer cannot read is
 *     outside the guarantee, and that is asserted too, not assumed.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import { withCrdt } from '../src/with-commit/crdt/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { ConflictError, UniqueConstraintError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

// ── inline memory adapter (same shape as unique-index.test.ts) ───────────────
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string): Map<string, EncryptedEnvelope> {
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
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

const SECRET = 'unique-modes-conformance-pass'

function open(store: NoydbStore, user = 'owner'): Promise<Noydb> {
  return createNoydb({
    store,
    user,
    secret: SECRET,
    indexingStrategy: withIndexing(),
    crdtStrategy: withCrdt(),
    tiersStrategy: withTiers(),
    teamStrategy: withTeam(),
  })
}

// ── 1. LAZY — genuine enforcement ────────────────────────────────────────────
describe('#1358 lazy mode: unique is ENFORCED, not refused', () => {
  it('accepts the declaration and rejects a duplicate single-field value', async () => {
    const db = await open(toMemory())
    const vault = await db.openVault('v')
    const col = vault.collection<{ taxId: string | null }>('employees', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001' })
    await expect(col.put('b', { taxId: 'TX-001' })).rejects.toThrow(UniqueConstraintError)

    // Same id re-writing its own value is not a violation.
    await expect(col.put('a', { taxId: 'TX-001' })).resolves.toBeUndefined()
    // Null-distinct: two nulls coexist.
    await col.put('n1', { taxId: null })
    await expect(col.put('n2', { taxId: null })).resolves.toBeUndefined()
  })

  it('enforces a COMPOUND unique over the field tuple, not over each field', async () => {
    const db = await open(toMemory())
    const vault = await db.openVault('v')
    const col = vault.collection<{ workerId: string; employerId: string }>('assignments', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: [{ fields: ['workerId', 'employerId'], unique: true }],
    })

    await col.put('x1', { workerId: 'W1', employerId: 'E1' })
    // Same worker, different employer — the TUPLE differs, so this is allowed.
    await expect(col.put('x2', { workerId: 'W1', employerId: 'E2' })).resolves.toBeUndefined()
    // The full tuple repeats — refused.
    await expect(col.put('x3', { workerId: 'W1', employerId: 'E1' })).rejects.toThrow(UniqueConstraintError)
  })

  it('enforces against records written in a PRIOR session (side-cars, not memory)', async () => {
    const store = toMemory()
    const db1 = await open(store)
    const v1 = await db1.openVault('v')
    await v1.collection<{ taxId: string }>('employees', {
      prefetch: false, cache: { maxRecords: 100 },
      indexes: [{ fields: ['taxId'], unique: true }],
    }).put('a', { taxId: 'TX-001' })

    const db2 = await open(store)
    const v2 = await db2.openVault('v')
    const col2 = v2.collection<{ taxId: string }>('employees', {
      prefetch: false, cache: { maxRecords: 100 },
      indexes: [{ fields: ['taxId'], unique: true }],
    })
    await expect(col2.put('b', { taxId: 'TX-001' })).rejects.toThrow(UniqueConstraintError)
  })
})

// ── 2. CRDT — no prevention, detection at merge ──────────────────────────────
describe('#1358 CRDT mode: unique is DETECTED at merge, never prevented', () => {
  it('does NOT refuse the duplicate write, and reports it on unique:violation', async () => {
    const db = await open(toMemory())
    const seen: Array<{ id: string; conflictingId: string; error: Error }> = []
    db.on('unique:violation', e => { seen.push({ id: e.id, conflictingId: e.conflictingId, error: e.error }) })

    const vault = await db.openVault('v')
    const col = vault.collection<{ taxId: string }>('replicated', {
      crdt: 'lww-map',
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001' })
    // The whole point: a CRDT replica CANNOT refuse this — it must succeed.
    await expect(col.put('b', { taxId: 'TX-001' })).resolves.toBeUndefined()

    // …but the duplicate IS detected and reported, ConflictError-shaped.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.error).toBeInstanceOf(UniqueConstraintError)
    expect(seen[0]!.id).toBe('b')
    expect(seen[0]!.conflictingId).toBe('a')

    // Both records survive. Uniqueness was not silently "enforced" by dropping one.
    expect(await col.get('a')).toMatchObject({ taxId: 'TX-001' })
    expect(await col.get('b')).toMatchObject({ taxId: 'TX-001' })
  })

  it('detects a duplicate that only becomes visible when the replicas MEET', async () => {
    // Both records are already in the store; this session never wrote either
    // of them, so the only place it can notice is the hydration merge.
    const store = toMemory()
    const db1 = await open(store)
    const v1 = await db1.openVault('v')
    const c1 = v1.collection<{ taxId: string }>('replicated', {
      crdt: 'lww-map',
      indexes: [{ fields: ['taxId'], unique: true }],
    })
    await c1.put('a', { taxId: 'TX-001' })
    await c1.put('b', { taxId: 'TX-001' })

    const db2 = await open(store)
    const seen: UniqueConstraintError[] = []
    db2.on('unique:violation', e => { seen.push(e.error as UniqueConstraintError) })
    const v2 = await db2.openVault('v')
    const c2 = v2.collection<{ taxId: string }>('replicated', {
      crdt: 'lww-map',
      indexes: [{ fields: ['taxId'], unique: true }],
    })
    // Any read forces hydration — the merge point.
    await c2.get('a')

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(UniqueConstraintError)
    expect(seen[0]!.fields).toEqual(['taxId'])
    expect(new Set([seen[0]!.recordId, seen[0]!.conflictingId])).toEqual(new Set(['a', 'b']))
  })
})

// ── 3. TIERED — enforced across every readable tier ──────────────────────────
describe('#1358 tiered collections: unique is ENFORCED across readable tiers', () => {
  it('a tier-0 put sees an ELEVATED duplicate the writer can read', async () => {
    const db = await open(toMemory())
    const vault = await db.openVault('v')
    const col = vault.collection<{ taxId: string }>('employees', {
      tiers: [0, 1],
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001' })
    await col.elevate('a', 1)
    // 'a' is invisible on the tier-0 surface, and its index entries were purged…
    expect(await col.get('a')).toBeNull()
    // …but the owner holds tier 1's DEK, so the value is still taken.
    await expect(col.put('b', { taxId: 'TX-001' })).rejects.toThrow(UniqueConstraintError)
  })

  it('putAtTier is enforced against a tier-0 holder', async () => {
    const db = await open(toMemory())
    const vault = await db.openVault('v')
    const col = vault.collection<{ taxId: string }>('employees', {
      tiers: [0, 1],
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001' })
    await expect(col.putAtTier('b', { taxId: 'TX-001' }, 1)).rejects.toThrow(UniqueConstraintError)
    // A distinct value at tier 1 is fine.
    await expect(col.putAtTier('c', { taxId: 'TX-002' }, 1)).resolves.toBeTruthy()
    // And a second tier-1 record duplicating the first is refused too.
    await expect(col.putAtTier('d', { taxId: 'TX-002' }, 1)).rejects.toThrow(UniqueConstraintError)
  })

  it('a tier the writer CANNOT read is outside the guarantee — stated, not silent', async () => {
    const store = toMemory()
    const db = await open(store)
    const vault = await db.openVault('v')
    const col = vault.collection<{ taxId: string }>('employees', {
      tiers: [0, 1],
      indexes: [{ fields: ['taxId'], unique: true }],
    })
    await col.put('a', { taxId: 'TX-001' })
    await col.elevate('a', 1)
    await db.grant('v', { userId: 'clerk', displayName: 'Clerk', role: 'operator', secret: 'clerk-pass', permissions: { employees: 'rw' } })

    // A second member with no tier-1 grant cannot see 'a' at all — so the
    // duplicate is ACCEPTED. This is the documented boundary of the
    // guarantee, asserted so it can never quietly change.
    const db2 = await createNoydb({
      store, user: 'clerk', secret: 'clerk-pass',
      indexingStrategy: withIndexing(), tiersStrategy: withTiers(), teamStrategy: withTeam(),
    })
    const v2 = await db2.openVault('v')
    const col2 = v2.collection<{ taxId: string }>('employees', {
      tiers: [0, 1],
      indexes: [{ fields: ['taxId'], unique: true }],
    })
    await expect(col2.put('b', { taxId: 'TX-001' })).resolves.toBeUndefined()
  })
})
