/**
 * #893/#906-prep — `canCommitAtomically` (Task 4): the eligibility gate
 * `runTransaction` (Task 5) will consult before folding a whole
 * `db.transaction()` batch into ONE `store.tx(ops)` call instead of the
 * per-op abortable path.
 *
 * Every "false" case here guards a correctness hazard the atomic path
 * would otherwise walk into:
 *   - store capability pairing mirrors `bestEffortRevert`'s rule
 *     (kernel/best-effort-revert.ts) — an undeclared `tx()` is never used.
 *   - amendment mode needs the guard-registry change-set machinery, which
 *     the atomic path skips entirely.
 *   - a duplicate `(vault, collection, id)` can't be expressed as a single
 *     write-set the way the abortable path's Phase 1 snapshot + in-order
 *     replay can.
 *   - derivation/MV sources, CRDT collections, unique constraints and refs
 *     all run recursive/enforcement side effects during the Collection-layer
 *     prepare/commit that a bare `store.tx(ops)` batch cannot reproduce.
 */
import { describe, it, expect } from 'vitest'
import { toMemory } from '../../../to-memory/src/index.js'
import { createNoydb, withDerivation } from '../../src/index.js'
import { withIndexing } from '../../src/with-lookup/indexing/index.js'
import { ref } from '../../src/kernel/refs.js'
import { lookup } from '../../src/via/lookup/descriptor.js'
import { canCommitAtomically } from '../../src/with-commit/tx/atomic-eligibility.js'
import { TxContext } from '../../src/with-commit/tx/transaction.js'
import type { NoydbStore } from '../../src/kernel/types.js'

const SECRET = 'atomic-eligibility-test-secret-2026'

async function open(store: NoydbStore = toMemory(), extra: Record<string, unknown> = {}) {
  const db = await createNoydb({ store, user: 'owner', secret: SECRET, ...extra })
  const vault = await db.openVault('v')
  return { db, vault }
}

describe('canCommitAtomically — #893/#906-prep gate', () => {
  it('true for a plain multi-collection batch on to-memory', async () => {
    const { db, vault } = await open()
    vault.collection('a')
    vault.collection('b')
    const ctx = new TxContext(db)
    ctx._ops.push(
      { type: 'put', vaultName: 'v', collectionName: 'a', id: '1', record: { n: 1 } },
      { type: 'put', vaultName: 'v', collectionName: 'b', id: '2', record: { n: 2 } },
    )
    expect(canCommitAtomically(db, ctx)).toBe(true)
  })

  it('false when the store lacks txAtomic', async () => {
    const memory = toMemory()
    const store: NoydbStore = {
      ...memory,
      capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' }, txAtomic: false },
    }
    const { db, vault } = await open(store)
    vault.collection('a')
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'put', vaultName: 'v', collectionName: 'a', id: '1', record: { n: 1 } })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  it('false when txAtomic is declared but tx() is missing (out-of-tree store)', async () => {
    const memory = toMemory()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { tx, ...rest } = memory as any
    const store = { ...rest, capabilities: { ...memory.capabilities, txAtomic: true } } as NoydbStore
    expect(store.tx).toBeUndefined()
    const { db, vault } = await open(store)
    vault.collection('a')
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'put', vaultName: 'v', collectionName: 'a', id: '1', record: { n: 1 } })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  it('false in amendment mode', async () => {
    const { db, vault } = await open()
    vault.collection('a')
    const ctx = new TxContext(db, true)
    ctx._ops.push({ type: 'put', vaultName: 'v', collectionName: 'a', id: '1', record: { n: 1 } })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  it('false when the batch touches the same (vault,collection,id) twice', async () => {
    const { db, vault } = await open()
    vault.collection('a')
    const ctx = new TxContext(db)
    ctx._ops.push(
      { type: 'put', vaultName: 'v', collectionName: 'a', id: '1', record: { n: 1 } },
      { type: 'put', vaultName: 'v', collectionName: 'a', id: '1', record: { n: 2 } },
    )
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  it('false when a touched collection has an EAGER derivation registered', async () => {
    const derivation = withDerivation({
      source: 'orders',
      deterministic: true,
      outputs: { total: { shape: 'record', collection: 'totals' } },
      derive: () => ({ total: {} }),
      lifecycle: 'eager',
    })
    const { db, vault } = await open(toMemory(), { derivationStrategies: [derivation] })
    vault.collection('orders')
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'put', vaultName: 'v', collectionName: 'orders', id: '1', record: { n: 1 } })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  it('false when a touched collection has a LAZY derivation registered', async () => {
    const derivation = withDerivation({
      source: 'orders',
      deterministic: true,
      outputs: { total: { shape: 'record', collection: 'totals' } },
      derive: () => ({ total: {} }),
      lifecycle: 'lazy',
    })
    const { db, vault } = await open(toMemory(), { derivationStrategies: [derivation] })
    vault.collection('orders')
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'put', vaultName: 'v', collectionName: 'orders', id: '1', record: { n: 1 } })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  it('false for a CRDT collection', async () => {
    const { db, vault } = await open()
    vault.collection('docs', { crdt: 'lww-map' })
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'put', vaultName: 'v', collectionName: 'docs', id: '1', record: { n: 1 } })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  it('false when a touched collection declares unique constraints', async () => {
    const { db, vault } = await open(toMemory(), { indexingStrategy: withIndexing() })
    vault.collection('employees', { indexes: [{ fields: ['taxId'], unique: true }] })
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'put', vaultName: 'v', collectionName: 'employees', id: '1', record: { taxId: 'x' } })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  it('false when a put touches a collection with refs declared', async () => {
    const { db, vault } = await open()
    vault.collection('clients')
    vault.collection('invoices', { refs: { clientId: ref('clients') } })
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'put', vaultName: 'v', collectionName: 'invoices', id: '1', record: { clientId: 'c1' } })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  it('false when a delete touches a collection with inbound refs', async () => {
    const { db, vault } = await open()
    vault.collection('clients')
    vault.collection('invoices', { refs: { clientId: ref('clients') } })
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'delete', vaultName: 'v', collectionName: 'clients', id: 'c1' })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  // #922 — the tripwire flipped, deliberately. The blanket
  // `refEnforcer !== undefined` check is replaced by Vault's
  // `_deleteCascadesPossible(name)`, which unions ALL THREE cascade
  // sources `enforceRefsOnDelete` fires from (lookup-ref edges, classic
  // inbound refs, managed links) — so a PLAIN collection, with none of the
  // three anywhere near it, is now delete-eligible. The three tests after
  // this one each pin one source refusing on its own, because a narrowing
  // that misses any of them re-opens the prepare-is-not-abortable hazard.
  it('true for a delete on a collection with no inbound refs, no lookup edges, no link endpoints (#922)', async () => {
    const { db, vault } = await open()
    vault.collection('plain')
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'delete', vaultName: 'v', collectionName: 'plain', id: '1' })
    expect(canCommitAtomically(db, ctx)).toBe(true)
  })

  it('false for a delete on a lookup dimension with a referencing edge (#922)', async () => {
    const { db, vault } = await open()
    vault.collection('countries')
    vault.collection('suppliers', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'restrict' }) },
    })
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'delete', vaultName: 'v', collectionName: 'countries', id: 'th' })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })

  it('false for a delete on a managed-link endpoint (#922)', async () => {
    const { db, vault } = await open()
    vault.collection('students')
    vault.collection('courses')
    vault.link('enrollment', { a: 'students', b: 'courses' })
    const ctx = new TxContext(db)
    ctx._ops.push({ type: 'delete', vaultName: 'v', collectionName: 'students', id: 's1' })
    expect(canCommitAtomically(db, ctx)).toBe(false)
  })
})
