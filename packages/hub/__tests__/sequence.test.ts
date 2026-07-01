/**
 * #303 — atomic, gap-free sequence primitive.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, SequenceOfflineError, SequenceContentionError, ReservedCollectionNameError, ValidationError } from '../src/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withSequence } from '../src/with-commit/sequence/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

function memory(casAtomic = true): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    capabilities: { casAtomic, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      // CAS: ev === 0 ⇒ must not exist; ev === N ⇒ existing must be at N.
      if (ev !== undefined) {
        if (ev === 0 && ex) throw new ConflictError(ex._v)
        if (ev !== 0 && (!ex || ex._v !== ev)) throw new ConflictError(ex?._v ?? 0)
      }
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

/**
 * Faithful-contract adapter: loadAll filters `_`-prefixed collections, exactly
 * as real adapters do. Used for dump/load round-trip tests so the regression
 * only passes when dump() explicitly re-adds _sequences to _internal (the blocker
 * fix). Without the fix, restored next() would return 1; with it, it returns 4.
 */
function memoryFaithful(casAtomic = true): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    capabilities: { casAtomic, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined) {
        if (ev === 0 && ex) throw new ConflictError(ex._v)
        if (ev !== 0 && (!ex || ex._v !== ev)) throw new ConflictError(ex?._v ?? 0)
      }
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    // Faithful: skip `_`-prefixed internal collections, mirroring real adapters.
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

async function vault(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'owner', secret: 'pw', sequenceStrategy: withSequence() })
  return db.openVault('books')
}

describe('#303 vault.sequence', () => {
  it('allocates gap-free 1,2,3,…', async () => {
    const v = await vault(memory())
    const seq = v.sequence('invoice-2026')
    expect(await seq.next()).toBe(1)
    expect(await seq.next()).toBe(2)
    expect(await seq.next()).toBe(3)
  })

  it('peek reads the current value without allocating', async () => {
    const v = await vault(memory())
    const seq = v.sequence('ddt')
    expect(await seq.peek()).toBe(0)
    await seq.next()
    expect(await seq.peek()).toBe(1)
    await seq.next()
    expect(await seq.peek()).toBe(2)
  })

  it('independent per-name sequences', async () => {
    const v = await vault(memory())
    expect(await v.sequence('a').next()).toBe(1)
    expect(await v.sequence('b').next()).toBe(1)
    expect(await v.sequence('a').next()).toBe(2)
    expect(await v.sequence('b').next()).toBe(2)
  })

  it('exactly-once + gap-free under concurrency (no duplicates, no gaps)', async () => {
    const v = await vault(memory())
    const seq = v.sequence('concurrent')
    const N = 12 // moderate concurrency; extreme bursts surface SequenceContentionError
    const results = await Promise.all(Array.from({ length: N }, () => seq.next()))
    const sorted = [...results].sort((x, y) => x - y)
    expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i + 1)) // exactly 1..N, no dupes/gaps
  })

  it('online-only: throws SequenceOfflineError on a non-CAS store', async () => {
    const v = await vault(memory(false))
    await expect(v.sequence('x').next()).rejects.toBeInstanceOf(SequenceOfflineError)
  })

  it('SequenceContentionError is exported for callers to handle', () => {
    expect(new SequenceContentionError('s', 8)).toBeInstanceOf(Error)
  })

  // ── Blocker fix: _sequences must survive dump()/load() round-trip ──────────────
  it('dump()/load() round-trip: next() continues at 4 (not 1) after restore', async () => {
    // Source vault: allocate 1, 2, 3 then dump. dump() works without
    // history (the backup just omits the integrity head), but we opt into
    // withHistory() so the backup also carries a verifiable ledger head —
    // exercising the full dump()/load() round-trip end to end.
    const srcStore = memoryFaithful()
    const srcDb = await createNoydb({ store: srcStore, user: 'owner', secret: 'passphrase', historyStrategy: withHistory(), sequenceStrategy: withSequence() })
    const srcVault = await srcDb.openVault('acme')
    const seq = srcVault.sequence('invoice-2026')
    expect(await seq.next()).toBe(1)
    expect(await seq.next()).toBe(2)
    expect(await seq.next()).toBe(3)
    const backupJson = await srcVault.dump()

    // Target vault: restore from backup, then next() must continue at 4.
    const tgtStore = memoryFaithful()
    const tgtDb = await createNoydb({ store: tgtStore, user: 'owner', secret: 'passphrase', historyStrategy: withHistory(), sequenceStrategy: withSequence() })
    const tgtVault = await tgtDb.openVault('acme')
    await tgtVault.load(backupJson)
    // Counter must resume from 3, not reset to 0.
    expect(await tgtVault.sequence('invoice-2026').peek()).toBe(3)
    expect(await tgtVault.sequence('invoice-2026').next()).toBe(4)
  })

  // ── Contention: put on _sequences always conflicts → SequenceContentionError ──
  it('throws SequenceContentionError when the store always conflicts on _sequences', async () => {
    // Use a normal CAS adapter for vault setup, then wrap its `put` to throw
    // ConflictError for any write targeting the _sequences collection.
    const base = memory()
    const conflicting: NoydbStore = {
      ...base,
      async put(v, c, id, env, ev) {
        if (c === '_sequences') throw new ConflictError(0)
        return base.put(v, c, id, env, ev)
      },
    }
    const db = await createNoydb({ store: conflicting, user: 'owner', secret: 'pw', sequenceStrategy: withSequence() })
    const v = await db.openVault('books')
    await expect(v.sequence('x').next()).rejects.toBeInstanceOf(SequenceContentionError)
  })

  // ── Name guard: collection('_sequences') must be blocked ──────────────────────
  it('collection("_sequences") throws ReservedCollectionNameError', async () => {
    const v = await vault(memory())
    expect(() => v.collection('_sequences')).toThrow(ReservedCollectionNameError)
  })
})

describe('#345 vault.sequence — partition + seedTo', () => {
  // ── Partitioning ──────────────────────────────────────────────────────────────
  it('a partitioned sequence is independent from the unpartitioned series', async () => {
    const v = await vault(memory())
    expect(await v.sequence('invoice').next()).toBe(1)
    expect(await v.sequence('invoice').next()).toBe(2)
    // Partitioned counter starts fresh — disjoint key.
    expect(await v.sequence('invoice', { partition: [2026] }).next()).toBe(1)
    expect(await v.sequence('invoice', { partition: [2026] }).next()).toBe(2)
    // Unpartitioned counter is untouched by the partitioned allocations.
    expect(await v.sequence('invoice').next()).toBe(3)
  })

  it('two partition values are independent of each other', async () => {
    const v = await vault(memory())
    expect(await v.sequence('invoice', { partition: ['EU'] }).next()).toBe(1)
    expect(await v.sequence('invoice', { partition: ['US'] }).next()).toBe(1)
    expect(await v.sequence('invoice', { partition: ['EU'] }).next()).toBe(2)
    expect(await v.sequence('invoice', { partition: ['US'] }).next()).toBe(2)
    expect(await v.sequence('invoice', { partition: ['EU'] }).next()).toBe(3)
  })

  it('two partition components compose into one independent counter', async () => {
    const v = await vault(memory())
    const eu2026 = () => v.sequence('invoice', { partition: [2026, 'EU'] })
    const us2026 = () => v.sequence('invoice', { partition: [2026, 'US'] })
    expect(await eu2026().next()).toBe(1)
    expect(await eu2026().next()).toBe(2)
    expect(await us2026().next()).toBe(1)
    // Distinct second component ⇒ distinct counter.
    expect(await eu2026().next()).toBe(3)
  })

  it('a numeric partition component coerces to the same key as its string form', async () => {
    const v = await vault(memory())
    expect(await v.sequence('invoice', { partition: [2026] }).next()).toBe(1)
    // String '2026' must resolve to the SAME counter as numeric 2026.
    expect(await v.sequence('invoice', { partition: ['2026'] }).next()).toBe(2)
    expect(await v.sequence('invoice', { partition: [2026] }).next()).toBe(3)
  })

  it("a '/'-containing value is URI-encoded distinct from a 2-element partition", async () => {
    const v = await vault(memory())
    // Single component 'a/b' encodes to 'a%2Fb'; a 2-element ['a','b'] joins to 'a/b'.
    // The two keys must NOT collide.
    expect(await v.sequence('s', { partition: ['a/b'] }).next()).toBe(1)
    expect(await v.sequence('s', { partition: ['a', 'b'] }).next()).toBe(1)
    expect(await v.sequence('s', { partition: ['a/b'] }).next()).toBe(2)
    expect(await v.sequence('s', { partition: ['a', 'b'] }).next()).toBe(2)
  })

  it('a series name containing a null byte throws ValidationError', async () => {
    // NOTE: enforced in vault.sequence() (integration); this case may not pass
    // until the vault.ts guard lands. Written here for completeness.
    const v = await vault(memory())
    expect(() => v.sequence('bad\x00series')).toThrow(ValidationError)
  })

  it('peek works on a partitioned sequence', async () => {
    const v = await vault(memory())
    const seq = () => v.sequence('invoice', { partition: [2026, 'EU'] })
    expect(await seq().peek()).toBe(0)
    await seq().next()
    await seq().next()
    expect(await seq().peek()).toBe(2)
    // The unpartitioned series remains at 0.
    expect(await v.sequence('invoice').peek()).toBe(0)
  })

  // ── seedTo (set-if-greater) ───────────────────────────────────────────────────
  it('seedTo advances the counter so next() continues above n', async () => {
    const v = await vault(memory())
    const seq = v.sequence('invoice')
    await seq.seedTo(50)
    expect(await seq.peek()).toBe(50)
    expect(await seq.next()).toBe(51)
    expect(await seq.next()).toBe(52)
  })

  it('seedTo is a no-op when the counter is already higher (set-if-greater)', async () => {
    const v = await vault(memory())
    const seq = v.sequence('invoice')
    await seq.next() // 1
    await seq.next() // 2
    await seq.next() // 3
    await seq.seedTo(2) // below current — must not rewind
    expect(await seq.peek()).toBe(3)
    expect(await seq.next()).toBe(4)
  })

  it('seedTo(0) is a no-op', async () => {
    const v = await vault(memory())
    const seq = v.sequence('invoice')
    await seq.seedTo(0)
    expect(await seq.peek()).toBe(0)
    expect(await seq.next()).toBe(1)
  })

  it('seedTo is idempotent', async () => {
    const v = await vault(memory())
    const seq = v.sequence('invoice')
    await seq.seedTo(50)
    await seq.seedTo(50)
    await seq.seedTo(50)
    expect(await seq.peek()).toBe(50)
    expect(await seq.next()).toBe(51)
  })

  it('seedTo works on a partitioned sequence', async () => {
    const v = await vault(memory())
    const seq = v.sequence('invoice', { partition: [2026, 'EU'] })
    await seq.seedTo(100)
    expect(await seq.peek()).toBe(100)
    expect(await seq.next()).toBe(101)
    // A different partition is unaffected.
    expect(await v.sequence('invoice', { partition: [2026, 'US'] }).peek()).toBe(0)
  })

  it('seedTo on a non-CAS store throws SequenceOfflineError', async () => {
    const v = await vault(memory(false))
    await expect(v.sequence('x').seedTo(50)).rejects.toBeInstanceOf(SequenceOfflineError)
  })

  // ── Regression: bundle import must not restart serials at 0 ───────────────────
  it('bundle-import "restart at 0" regression: seedTo(50) then next()==51', async () => {
    const v = await vault(memory())
    const seq = v.sequence('invoice')
    // Fresh sequence after an import — counter is at 0 but records up to 50 exist.
    expect(await seq.peek()).toBe(0)
    await seq.seedTo(50)
    // next() must skip past the imported serials, not collide with serial 1.
    expect(await seq.next()).toBe(51)
  })
})

describe('#375 vault.sequence — format', () => {
  it('next() returns { serial, formatted } when format is set', async () => {
    const v = await vault(memory())
    const seq = v.sequence('fatture', { partition: [2026], format: '{partition.0}/{seq:04}' })
    expect(await seq.next()).toEqual({ serial: 1, formatted: '2026/0001' })
    expect(await seq.next()).toEqual({ serial: 2, formatted: '2026/0002' })
  })

  it('per-partition reset is inherent — a new partition starts at 0001', async () => {
    const v = await vault(memory())
    const y2026 = v.sequence('fatture', { partition: [2026], format: '{partition.0}/{seq:04}' })
    const y2027 = v.sequence('fatture', { partition: [2027], format: '{partition.0}/{seq:04}' })
    expect((await y2026.next()).formatted).toBe('2026/0001')
    expect((await y2026.next()).formatted).toBe('2026/0002')
    expect((await y2027.next()).formatted).toBe('2027/0001') // independent counter
    expect((await y2026.next()).formatted).toBe('2026/0003')
  })

  it('renders {seq} unpadded and {seq:0N} zero-padded', async () => {
    const v = await vault(memory())
    const bare = v.sequence('a', { format: 'INV-{seq}' })
    expect((await bare.next()).formatted).toBe('INV-1')
    const padded = v.sequence('b', { format: 'INV-{seq:03}' })
    expect((await padded.next()).formatted).toBe('INV-001')
  })

  it('renders multiple partition components', async () => {
    const v = await vault(memory())
    const seq = v.sequence('inv', { partition: [2026, 'EU'], format: '{partition.1}-{partition.0}-{seq:05}' })
    expect((await seq.next()).formatted).toBe('EU-2026-00001')
  })

  it('peek() and seedTo() still operate on the underlying integer', async () => {
    const v = await vault(memory())
    const seq = v.sequence('fatture', { partition: [2026], format: '{partition.0}/{seq:04}' })
    expect(await seq.peek()).toBe(0)
    await seq.seedTo(41)
    expect(await seq.peek()).toBe(41)
    expect(await seq.next()).toEqual({ serial: 42, formatted: '2026/0042' })
  })

  it('throws ValidationError at construction on an unknown token', () => {
    return vault(memory()).then((v) => {
      expect(() => v.sequence('x', { format: '{year}/{seq}' })).toThrow(ValidationError)
    })
  })

  it('throws ValidationError at construction when {partition.i} exceeds the partition', () => {
    return vault(memory()).then((v) => {
      expect(() => v.sequence('x', { partition: [2026], format: '{partition.2}/{seq}' })).toThrow(ValidationError)
    })
  })

  it('unformatted sequences still return a bare number (back-compat)', async () => {
    const v = await vault(memory())
    const seq = v.sequence('plain')
    const n = await seq.next()
    expect(typeof n).toBe('number')
    expect(n).toBe(1)
  })

  it('rejects format on a deferred-numbering series', async () => {
    const { withDeferredNumbering } = await import('../src/with-commit/numbering/descriptor.js')
    const db = await createNoydb({
      store: memory(), user: 'owner', secret: 'pw',
      numbering: [withDeferredNumbering({ series: 'def', collection: 'docs', field: 'serial' })],
    })
    const v = await db.openVault('books')
    expect(() => v.sequence('def', { format: '{seq:04}' })).toThrow(ValidationError)
  })
})
