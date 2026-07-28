/**
 * Unique-index enforcement — #293
 *
 * Coverage:
 *  1. Eager single-field: duplicate value → UniqueConstraintError with correct fields + conflictingId.
 *  2. Null tolerance (single): two records with null taxId → both succeed.
 *  3. Update no-false-positive: same id same value OK; update to new value OK.
 *  4. Update-to-collide: put a (X), put b (Y), update b to X → rejects.
 *  5. Delete frees value: put a (X), delete a, put b (X) → OK.
 *  6. Eager composite: duplicate pair rejects; same workerId + different employerEntityId → OK;
 *     partial null → duplicates allowed.
 *  7. putMany intra-batch dup: two entries sharing unique value → second rejects.
 *  8. Lazy fail-loud: prefetch:false + unique index → throws at registration.
 *  9. Unique index still queryable: declared unique index serves where('==') queries.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, UniqueConstraintError, UnsupportedIndexOptionError } from '../src/kernel/errors.js'

// ── inline memory adapter ────────────────────────────────────────────────────
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

// ── shared vault setup ───────────────────────────────────────────────────────
let db: Noydb

beforeEach(async () => {
  db = await createNoydb({ store: toMemory(), indexingStrategy: withIndexing(), secret: 'unique-index-test-pass', user: 'owner' })
})

// ── helpers ──────────────────────────────────────────────────────────────────
async function openVault(vaultName = 'v1') {
  return db.openVault(vaultName)
}

// ── 1. Eager single-field unique — duplicate value → UniqueConstraintError ──
describe('unique single-field index', () => {
  it('rejects a duplicate value on a different id', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId: string | null }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001' })
    await expect(col.put('b', { taxId: 'TX-001' })).rejects.toThrow(UniqueConstraintError)
  })

  it('error carries fields and conflictingId', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId: string | null }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001' })
    let caught: UniqueConstraintError | undefined
    try {
      await col.put('b', { taxId: 'TX-001' })
    } catch (e) {
      caught = e as UniqueConstraintError
    }

    expect(caught).toBeInstanceOf(UniqueConstraintError)
    expect(caught!.fields).toEqual(['taxId'])
    expect(caught!.conflictingId).toBe('a')
    expect(caught!.recordId).toBe('b')
    expect(caught!.collection).toBe('employees')
    expect(caught!.code).toBe('UNIQUE_CONSTRAINT')
  })
})

// ── 2. Null tolerance ────────────────────────────────────────────────────────
describe('null tolerance', () => {
  it('allows multiple records with null for the constrained field', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId: string | null }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: null })
    await expect(col.put('b', { taxId: null })).resolves.toBeUndefined()
  })

  it('allows multiple records with undefined for the constrained field', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId?: string }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', {})
    await expect(col.put('b', {})).resolves.toBeUndefined()
  })
})

// ── 3. Update no-false-positive ──────────────────────────────────────────────
describe('update no-false-positive', () => {
  it('allows re-putting the same id with the same value', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId: string }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001' })
    await expect(col.put('a', { taxId: 'TX-001' })).resolves.toBeUndefined()
  })

  it('allows updating a record to a new unique value', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId: string }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001' })
    await expect(col.put('a', { taxId: 'TX-002' })).resolves.toBeUndefined()
    // the freed old value must be claimable by a different record
    await expect(col.put('b', { taxId: 'TX-001' })).resolves.toBeUndefined()
  })
})

// ── 4. Update-to-collide ─────────────────────────────────────────────────────
describe('update-to-collide', () => {
  it('rejects updating a record to a value already held by another id', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId: string }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001' })
    await col.put('b', { taxId: 'TX-002' })
    await expect(col.put('b', { taxId: 'TX-001' })).rejects.toThrow(UniqueConstraintError)
  })
})

// ── 5. Delete frees value ────────────────────────────────────────────────────
describe('delete frees value', () => {
  it('allows a different id to claim the value after the original holder is deleted', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId: string }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001' })
    await col.delete('a')
    await expect(col.put('b', { taxId: 'TX-001' })).resolves.toBeUndefined()
  })
})

// ── 6. Eager composite ───────────────────────────────────────────────────────
describe('composite unique index', () => {
  it('rejects a duplicate (workerId, employerEntityId) pair', async () => {
    const vault = await openVault()
    const col = vault.collection<{ workerId: string; employerEntityId: string }>('assignments', {
      indexes: [{ fields: ['workerId', 'employerEntityId'], unique: true }],
    })

    await col.put('x1', { workerId: 'W1', employerEntityId: 'E1' })
    await expect(col.put('x2', { workerId: 'W1', employerEntityId: 'E1' })).rejects.toThrow(UniqueConstraintError)
  })

  it('allows same workerId with a different employerEntityId', async () => {
    const vault = await openVault()
    const col = vault.collection<{ workerId: string; employerEntityId: string }>('assignments', {
      indexes: [{ fields: ['workerId', 'employerEntityId'], unique: true }],
    })

    await col.put('x1', { workerId: 'W1', employerEntityId: 'E1' })
    await expect(col.put('x2', { workerId: 'W1', employerEntityId: 'E2' })).resolves.toBeUndefined()
  })

  it('allows partial null: one field null → both records exempt', async () => {
    const vault = await openVault()
    const col = vault.collection<{ workerId: string | null; employerEntityId: string | null }>('assignments', {
      indexes: [{ fields: ['workerId', 'employerEntityId'], unique: true }],
    })

    await col.put('x1', { workerId: 'W1', employerEntityId: null })
    // Same workerId but one field is null → exempt
    await expect(col.put('x2', { workerId: 'W1', employerEntityId: null })).resolves.toBeUndefined()
  })
})

// ── 7. putMany intra-batch dup ───────────────────────────────────────────────
describe('putMany intra-batch duplicate', () => {
  it('rejects the second entry when two entries share the unique value', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId: string }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    const result = await col.putMany([
      ['a', { taxId: 'TX-001' }],
      ['b', { taxId: 'TX-001' }],
    ])
    expect(result.ok).toBe(false)
    expect(result.success).toContain('a')
    expect(result.failures.some(f => f.id === 'b' && f.error instanceof UniqueConstraintError)).toBe(true)
  })
})

// ── 8. Lazy fail-loud ────────────────────────────────────────────────────────
describe('lazy mode fail-loud', () => {
  it('throws UnsupportedIndexOptionError at collection registration when unique index declared with prefetch:false', async () => {
    const vault = await openVault()
    expect(() =>
      vault.collection<{ k: string }>('lazy-unique', {
        prefetch: false,
        cache: { maxRecords: 100 },
        indexes: [{ fields: ['k'], unique: true }],
      }),
    ).toThrow(UnsupportedIndexOptionError)
  })
})

// ── 9. putManyAtomic rollback: no ghost entries ──────────────────────────────
describe('putManyAtomic rollback ghost-record regression', () => {
  it('allows a fresh insert of a value after an atomic batch rolled it back', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId: string }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    // Phase 1: atomic batch — entry 'b' collides with 'a' → whole batch fails
    // but 'a' was already written to store (putManyAtomic writes then reverts)
    await expect(
      col.putMany([
        ['a', { taxId: 'TX-001' }],
        ['b', { taxId: 'TX-001' }],
      ], { atomic: true }),
    ).rejects.toThrow(UniqueConstraintError)

    // After rollback both 'a' and 'b' should be absent.
    // TX-001 must be claimable again — no ghost entry in the unique map.
    await expect(col.put('c', { taxId: 'TX-001' })).resolves.toBeUndefined()
  })
})

// ── 10. Unique index still queryable ─────────────────────────────────────────
describe('unique index queryable', () => {
  it('a unique index serves where == queries', async () => {
    const vault = await openVault()
    const col = vault.collection<{ taxId: string; name: string }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await col.put('a', { taxId: 'TX-001', name: 'Alice' })
    await col.put('b', { taxId: 'TX-002', name: 'Bob' })

    const results = await col.query().where('taxId', '==', 'TX-001').toArray()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ taxId: 'TX-001', name: 'Alice' })
  })
})

// ── 11. Hydration/rebuild regression — two-session path ──────────────────────
describe('hydration rebuild (two-session path)', () => {
  it('enforces unique constraint against records written in a prior session', async () => {
    // One shared store so both instances see the same persisted data.
    const sharedStore = toMemory()

    // Session 1: write a record.
    const db1 = await createNoydb({
      store: sharedStore,
      indexingStrategy: withIndexing(),
      secret: 'unique-index-test-pass',
      user: 'owner',
    })
    const vault1 = await db1.openVault('shared-v')
    const col1 = vault1.collection<{ taxId: string }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })
    await col1.put('a', { taxId: 'TX-001' })

    // Session 2: open the same vault + same collection on the same store.
    // The unique-constraint map must be rebuilt from the hydrated cache so
    // that 'b' with the same taxId is rejected.
    const db2 = await createNoydb({
      store: sharedStore,
      indexingStrategy: withIndexing(),
      secret: 'unique-index-test-pass',
      user: 'owner',
    })
    const vault2 = await db2.openVault('shared-v')
    const col2 = vault2.collection<{ taxId: string }>('employees', {
      indexes: [{ fields: ['taxId'], unique: true }],
    })

    await expect(col2.put('b', { taxId: 'TX-001' })).rejects.toThrow(UniqueConstraintError)
  })
})

// ── 12. CRDT + unique guard ───────────────────────────────────────────────────
describe('CRDT mode fail-loud', () => {
  it('throws UnsupportedIndexOptionError at registration when unique index declared on a CRDT collection', async () => {
    const vault = await openVault()
    expect(() =>
      vault.collection<{ taxId: string }>('crdt-unique', {
        crdt: 'lww-map',
        indexes: [{ fields: ['taxId'], unique: true }],
      }),
    ).toThrow(UnsupportedIndexOptionError)
  })
})

// ── 13. Tiered collection + unique guard (C1) ─────────────────────────────────
describe('tiered collection fail-loud', () => {
  it('throws UnsupportedIndexOptionError at registration when unique index declared on a tiered collection', async () => {
    const vault = await openVault()
    expect(() =>
      vault.collection<{ taxId: string }>('tiered-unique', {
        tiers: [0, 1],
        indexes: [{ fields: ['taxId'], unique: true }],
      }),
    ).toThrow(UnsupportedIndexOptionError)
  })
})
