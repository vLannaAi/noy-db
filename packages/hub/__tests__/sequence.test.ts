/**
 * #303 — atomic, gap-free sequence primitive.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, SequenceOfflineError, SequenceContentionError } from '../src/index.js'
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
    capabilities: { casAtomic, auth: { kind: 'none' } },
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

async function vault(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'owner', secret: 'pw' })
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
})
