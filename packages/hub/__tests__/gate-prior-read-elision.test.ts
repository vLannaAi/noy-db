/**
 * #267 Track A tail — lazy gate-event prior-read optimization.
 *
 * The write-path gate bus (`beforePut` / `beforeDelete`) resolves the PRIOR
 * record (store read + decrypt) to populate `existing` / `existingVersion` /
 * `existingTs` / `op` on the gate event. When every registered gate handler
 * declared `needsPrior: false` at registration, that prior-read is SKIPPED —
 * pure perf, the handler contract is that it must not rely on the
 * prior-derived fields.
 *
 * Every write already performs its own store reads unrelated to the gate
 * (a schema-fence freshness check, a ledger payload-hash read on delete,
 * etc.), so these tests measure reads RELATIVE TO a gate-free baseline
 * rather than asserting an absolute read count:
 *  (a) eliding the prior-read costs exactly the baseline (zero extra reads),
 *      and
 *  (b) needing the prior costs exactly one read over baseline — unchanged
 *      from pre-#267 behavior.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import type { NoydbStore } from '../src/kernel/types.js'
import type { GatePutEvent, GateDeleteEvent } from '../src/port/with/service-bus.js'

type Doc = { n: number }

/** Wrap a store, counting per-id `get` calls (the prior-read primitive). */
function countingStore(): { store: NoydbStore; counter: { gets: number } } {
  const inner = memoryStore()
  const counter = { gets: 0 }
  const store: NoydbStore = {
    ...inner,
    async get(vault, collection, id) {
      counter.gets++
      return inner.get(vault, collection, id)
    },
  }
  return { store, counter }
}

async function setup() {
  const { store, counter } = countingStore()
  const db = await createNoydb({ store, user: 'me', secret: 'pw-long-enough' })
  const vault = await db.openVault('G')
  const docs = vault.collection<Doc>('docs')
  await docs.put('a', { n: 1 }) // seed prior record (no gate handlers yet)
  return { db, docs, counter }
}

/** Reads a bare `put`/`delete` costs with NO gate handler registered at all — the always-on baseline (schema-fence check, ledger payload-hash read, ...) that #267 does not touch. */
async function basePutGets(value: number): Promise<number> {
  const { db, docs, counter } = await setup()
  counter.gets = 0
  await docs.put('a', { n: value })
  await db.close()
  return counter.gets
}

async function baseDeleteGets(): Promise<number> {
  const { db, docs, counter } = await setup()
  counter.gets = 0
  await docs.delete('a')
  await db.close()
  return counter.gets
}

describe('gate prior-read elision (#267)', () => {
  it('(a) beforePut: skips the prior-read when no handler declares interest', async () => {
    const base = await basePutGets(2)
    const { db, docs, counter } = await setup()
    const seen: GatePutEvent[] = []
    db._subsystemBus.registerGate('beforePut', (e) => { seen.push(e) }, { needsPrior: false })

    counter.gets = 0
    await docs.put('a', { n: 2 })

    expect(seen).toHaveLength(1)
    expect(counter.gets).toBe(base) // no extra read over the gate-free baseline — prior-read elided
    // Contract: prior-derived fields are unpopulated for opted-out handlers.
    expect(seen[0]!.existing).toBeNull()
    expect(seen[0]!.existingVersion).toBe(0)
    expect(seen[0]!.existingTs).toBeUndefined()
    // The write itself is unaffected — versioning still advances off the cache.
    expect((await docs.get('a'))?.n).toBe(2)
    await db.close()
  })

  it('(b) beforePut: unchanged behavior when a handler needs the prior (default)', async () => {
    const base = await basePutGets(3)
    const { db, docs, counter } = await setup()
    const seen: GatePutEvent[] = []
    db._subsystemBus.registerGate('beforePut', (e) => { seen.push(e) }) // default: needsPrior
    db._subsystemBus.registerGate('beforePut', () => {}, { needsPrior: false }) // mixed registration

    counter.gets = 0
    await docs.put('a', { n: 3 })

    expect(seen).toHaveLength(1)
    expect(counter.gets).toBe(base + 1) // exactly one extra read over baseline — prior-read performed
    expect(seen[0]!.op).toBe('update')
    expect((seen[0]!.existing as Doc).n).toBe(1)
    expect(seen[0]!.existingVersion).toBe(1)
    expect(seen[0]!.existingTs).toBeTruthy()
    await db.close()
  })

  it('(a) beforeDelete: skips the prior-read when no handler declares interest', async () => {
    const base = await baseDeleteGets()
    const { db, docs, counter } = await setup()
    const seen: GateDeleteEvent[] = []
    db._subsystemBus.registerGate('beforeDelete', (e) => { seen.push(e) }, { needsPrior: false })

    counter.gets = 0
    await docs.delete('a')

    expect(seen).toHaveLength(1)
    expect(counter.gets).toBe(base)
    expect(seen[0]!.existing).toBeNull()
    expect(seen[0]!.existingVersion).toBe(0)
    expect(await docs.get('a')).toBeNull()
    await db.close()
  })

  it('(b) beforeDelete: unchanged behavior when a handler needs the prior (default)', async () => {
    const base = await baseDeleteGets()
    const { db, docs, counter } = await setup()
    const seen: GateDeleteEvent[] = []
    db._subsystemBus.registerGate('beforeDelete', (e) => { seen.push(e) })

    counter.gets = 0
    await docs.delete('a')

    expect(seen).toHaveLength(1)
    expect(counter.gets).toBe(base + 1)
    expect((seen[0]!.existing as Doc).n).toBe(1)
    expect(seen[0]!.existingVersion).toBe(1)
    await db.close()
  })

  it('a throwing needsPrior:false gate still aborts the write (gate semantics intact)', async () => {
    const { db, docs } = await setup()
    db._subsystemBus.registerGate('beforePut', () => { throw new Error('blocked') }, { needsPrior: false })
    await expect(docs.put('a', { n: 9 })).rejects.toThrow('blocked')
    expect((await docs.get('a'))?.n).toBe(1) // write aborted
    await db.close()
  })

  it('unsubscribing the only prior-needing handler re-enables elision', async () => {
    const base = await basePutGets(4)
    const { db, docs, counter } = await setup()
    db._subsystemBus.registerGate('beforePut', () => {}, { needsPrior: false })
    const off = db._subsystemBus.registerGate('beforePut', () => {}) // needs prior
    expect(db._subsystemBus.gateNeedsPrior('beforePut')).toBe(true)
    off()
    expect(db._subsystemBus.gateNeedsPrior('beforePut')).toBe(false)
    counter.gets = 0
    await docs.put('a', { n: 4 })
    expect(counter.gets).toBe(base)
    await db.close()
  })
})
