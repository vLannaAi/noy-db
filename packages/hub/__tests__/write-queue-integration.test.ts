/**
 * Integration tests for hub.writeQueue (#227, M12 Slice 1) — exercised
 * through createNoydb with a gated memory adapter so we can hold a write
 * in flight and observe depth/pending/onFlush deterministically.
 */
import { describe, expect, it } from 'vitest'
import { createNoydb, type Noydb } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import type { NoydbStore } from '../src/types.js'

interface Invoice extends Record<string, unknown> {
  id: string
  amount: number
}

/**
 * Wrap a memory store so its `put` blocks on a gate the test controls.
 * memory() returns an object of closures, so spread + override is safe.
 */
function gatedMemory(): {
  store: NoydbStore
  block: () => void
  release: () => void
} {
  const base = memory()
  let gate: Promise<void> = Promise.resolve()
  let open: () => void = () => {}
  return {
    store: {
      ...base,
      async put(...args: Parameters<NoydbStore['put']>) {
        await gate
        return base.put(...args)
      },
    },
    block() {
      gate = new Promise<void>((resolve) => {
        open = resolve
      })
    },
    release() {
      open()
      gate = Promise.resolve()
    },
  }
}

async function setup(store: NoydbStore): Promise<Noydb> {
  return createNoydb({
    store,
    user: 'alice',
    secret: 'write-queue-test-passphrase-1234',
  })
}

describe('hub.writeQueue (#227)', () => {
  it('is idle on a fresh hub', async () => {
    const db = await setup(memory())
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
    // Let the put reach the gated adapter call.
    await Promise.resolve()
    await Promise.resolve()
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
    await Promise.resolve()

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
    await Promise.resolve()
    expect(db.writeQueue.depth).toBe(2)

    gated.release()
    await Promise.all([p1, p2])
    expect(db.writeQueue.depth).toBe(0)
  })
})
