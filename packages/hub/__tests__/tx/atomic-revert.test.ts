/**
 * #886 (partial) — the revert pass uses `store.tx()` when the store declares
 * `txAtomic`, so a crash mid-revert cannot leave the vault half-unwound.
 *
 * This is the safe slice of that issue. Delegating the FORWARD write path is a
 * much larger job — `runTransaction`'s Phase 2 deliberately runs through the
 * Collection layer so history, ledger entries and change events fire, while
 * `store.tx()` needs already-encrypted envelopes, which would require splitting
 * `Collection._putInternal` into prepare/commit halves.
 *
 * The revert pass has no such problem: its legs already carry RAW prior
 * envelopes captured before the write, which is exactly what `tx()` wants.
 */
import { describe, it, expect } from 'vitest'
import { bestEffortRevert } from '../../src/kernel/best-effort-revert.js'
import type { EncryptedEnvelope } from '../../src/kernel/types.js'

const env = (v: number): EncryptedEnvelope =>
  ({ _noydb: 1, _v: v, _ts: new Date().toISOString(), _iv: 'aXY=', _data: 'ZA==' }) as EncryptedEnvelope

function fakeStore(opts: { txAtomic?: boolean; txThrows?: boolean } = {}) {
  const calls: string[] = []
  const store = {
    capabilities: opts.txAtomic ? { txAtomic: true } : {},
    async put() { calls.push('put') },
    async delete() { calls.push('delete') },
    ...(opts.txAtomic
      ? {
          async tx(ops: readonly unknown[]) {
            if (opts.txThrows) { calls.push('tx:throw'); throw new Error('batch rejected') }
            calls.push(`tx:${ops.length}`)
          },
        }
      : {}),
  }
  return { store, calls }
}

const legs = [
  { vaultName: 'v', collectionName: 'c', id: 'a', prior: env(1) },
  { vaultName: 'v', collectionName: 'c', id: 'b', prior: null },
]

describe('#886 — atomic revert when the store declares txAtomic', () => {
  it('submits the whole revert as ONE tx when txAtomic is declared', async () => {
    const { store, calls } = fakeStore({ txAtomic: true })
    await bestEffortRevert(legs, store as never)

    expect(calls).toEqual(['tx:2'])
    // no per-leg writes at all
    expect(calls).not.toContain('put')
    expect(calls).not.toContain('delete')
  })

  it('falls back to the per-leg loop when the store cannot do tx', async () => {
    const { store, calls } = fakeStore({ txAtomic: false })
    await bestEffortRevert(legs, store as never)

    // reverse order: the null-prior leg deletes, the other restores
    expect(calls).toEqual(['delete', 'put'])
  })

  it('falls back — not throws — when the batch is rejected', async () => {
    const { store, calls } = fakeStore({ txAtomic: true, txThrows: true })
    await expect(bestEffortRevert(legs, store as never)).resolves.toBeUndefined()

    // tried the batch, then unwound leg by leg
    expect(calls).toEqual(['tx:throw', 'delete', 'put'])
  })

  it('still runs the compensate hook once per leg on the atomic path', async () => {
    const { store } = fakeStore({ txAtomic: true })
    const seen: string[] = []
    await bestEffortRevert(legs, store as never, (leg) => { seen.push(leg.id) })

    expect(seen).toEqual(['b', 'a']) // reverse order, same as the loop path
  })

  it('a throwing compensate never surfaces — revert stays best-effort', async () => {
    const { store } = fakeStore({ txAtomic: true })
    await expect(
      bestEffortRevert(legs, store as never, () => { throw new Error('cache sync failed') }),
    ).resolves.toBeUndefined()
  })

  it('ignores tx() when the capability is not declared, even if present', async () => {
    // Guards the pairing rule from #884 in the other direction: an
    // undeclared tx() must not be used.
    const calls: string[] = []
    const store = {
      capabilities: {},
      async put() { calls.push('put') },
      async delete() { calls.push('delete') },
      async tx() { calls.push('tx') },
    }
    await bestEffortRevert(legs, store as never)

    expect(calls).not.toContain('tx')
    expect(calls).toEqual(['delete', 'put'])
  })
})
