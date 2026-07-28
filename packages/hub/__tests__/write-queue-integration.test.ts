/**
 * Integration tests for hub.writeQueue (#227, M12 Slice 1) — exercised
 * through createNoydb with a gated memory adapter so we can hold a write
 * in flight and observe depth/pending/onFlush deterministically.
 */
import { describe, expect, it } from 'vitest'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import { toMemory } from '../../to-memory/src/index.js'
import type { NoydbStore } from '../src/kernel/types.js'

interface Invoice extends Record<string, unknown> {
  id: string
  amount: number
}

/**
 * Wrap a memory store so its `put` blocks on a gate the test controls.
 * toMemory() returns an object of closures, so spread + override is safe.
 */
function gatedMemory(): {
  store: NoydbStore
  block: () => void
  release: () => void
  whenEntered: (n: number) => Promise<void>
} {
  const base = toMemory()
  let gate: Promise<void> = Promise.resolve()
  let open: () => void = () => {}
  let entered = 0
  const waiters: Array<{ n: number; resolve: () => void }> = []
  const notify = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (entered >= waiters[i]!.n) { waiters[i]!.resolve(); waiters.splice(i, 1) }
    }
  }
  return {
    store: {
      ...base,
      async put(...args: Parameters<NoydbStore['put']>) {
        entered++
        notify()
        await gate
        return base.put(...args)
      },
    },
    block() {
      entered = 0 // count only writes since this block() (ignore setup writes)
      waiters.length = 0
      gate = new Promise<void>((resolve) => {
        open = resolve
      })
    },
    release() {
      open()
      gate = Promise.resolve()
    },
    // Resolves once at least `n` record writes have entered the gated put.
    // By the time a record put is entered, the write-queue `begin()` has
    // already run — so `depth` is a reliable observation at that point.
    whenEntered(n: number) {
      return new Promise<void>((resolve) => {
        if (entered >= n) resolve()
        else waiters.push({ n, resolve })
      })
    },
  }
}

async function setup(store: NoydbStore): Promise<Noydb> {
  return createNoydb({
    store,
    user: 'alice',
    secret: 'write-queue-test-secret-1234',
  })
}

describe('hub.writeQueue (#227)', () => {
  it('is idle on a fresh hub', async () => {
    const db = await setup(toMemory())
    expect(db.writeQueue.pending).toBe(false)
    expect(db.writeQueue.depth).toBe(0)
  })

  it('reports pending while a write is in flight and clears after', async () => {
    const gated = gatedMemory()
    const db = await setup(gated.store)
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')

    gated.block()
    const writePromise = invoices.put('i1', { id: 'i1', amount: 100 })
    // Wait until the record write has entered the gated adapter — by then
    // the write-queue begin() has run (deterministic, no microtask guessing).
    await gated.whenEntered(1)
    expect(db.writeQueue.pending).toBe(true)
    expect(db.writeQueue.depth).toBe(1)

    gated.release()
    await writePromise
    expect(db.writeQueue.pending).toBe(false)
    expect(db.writeQueue.depth).toBe(0)
  })

  it('onChange fires as writes start and finish', async () => {
    const gated = gatedMemory()
    const db = await setup(gated.store)
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')

    const depths: number[] = []
    db.writeQueue.onChange(() => depths.push(db.writeQueue.depth))

    gated.block()
    const p = invoices.put('i1', { id: 'i1', amount: 1 })
    await Promise.resolve()
    gated.release()
    await p

    expect(depths).toContain(1) // saw the rise
    expect(depths[depths.length - 1]).toBe(0) // ended idle
  })

  it('onFlush() resolves once the in-flight write commits', async () => {
    const gated = gatedMemory()
    const db = await setup(gated.store)
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')

    gated.block()
    const writePromise = invoices.put('i1', { id: 'i1', amount: 100 })
    await gated.whenEntered(1)

    let flushed = false
    const flush = db.writeQueue.onFlush().then(() => { flushed = true })
    expect(flushed).toBe(false)

    gated.release()
    await writePromise
    await flush
    expect(flushed).toBe(true)
  })

  it('aggregates concurrent writes across collections', async () => {
    const gated = gatedMemory()
    const db = await setup(gated.store)
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')
    const payments = vault.collection<Invoice>('payments')

    gated.block()
    const p1 = invoices.put('i1', { id: 'i1', amount: 1 })
    const p2 = payments.put('p1', { id: 'p1', amount: 2 })
    await gated.whenEntered(2)
    expect(db.writeQueue.depth).toBe(2)

    gated.release()
    await Promise.all([p1, p2])
    expect(db.writeQueue.depth).toBe(0)
  })
})
