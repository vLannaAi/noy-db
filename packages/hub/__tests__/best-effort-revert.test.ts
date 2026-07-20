/**
 * Focused unit test for the shared `bestEffortRevert` helper
 * (bounded #588 consolidation, milestone 22 Task 5): the common
 * reverse-order / best-effort / raw-adapter-revert shape extracted from
 * `with-shape/satellites/fanout.ts`'s `revertAndCompensate` and
 * `with-commit/tx/transaction.ts`'s `revertExecuted`.
 */
import { describe, it, expect } from 'vitest'
import { bestEffortRevert } from '../src/kernel/best-effort-revert.js'
import type { BestEffortRevertLeg, BestEffortRevertAdapter } from '../src/kernel/best-effort-revert.js'
import type { EncryptedEnvelope } from '../src/kernel/types.js'

const envelope = (tag: string): EncryptedEnvelope =>
  ({ _iv: tag, _data: tag, _v: 1 }) as unknown as EncryptedEnvelope

/** Minimal in-memory adapter with call-order tracking + one-shot failure injection. */
function fakeAdapter() {
  const calls: Array<{ op: 'put' | 'delete'; id: string }> = []
  const failIds = new Set<string>()
  const adapter: BestEffortRevertAdapter = {
    async put(_vaultName, _collectionName, id) {
      calls.push({ op: 'put', id })
      if (failIds.has(id)) { failIds.delete(id); throw new Error(`forced put failure for "${id}"`) }
    },
    async delete(_vaultName, _collectionName, id) {
      calls.push({ op: 'delete', id })
      if (failIds.has(id)) { failIds.delete(id); throw new Error(`forced delete failure for "${id}"`) }
    },
  }
  return { adapter, calls, failNext: (id: string): void => { failIds.add(id) } }
}

describe('bestEffortRevert', () => {
  it('reverts legs in reverse order', async () => {
    const { adapter, calls } = fakeAdapter()
    const legs: BestEffortRevertLeg[] = [
      { vaultName: 'v', collectionName: 'c', id: 'a', prior: envelope('a') },
      { vaultName: 'v', collectionName: 'c', id: 'b', prior: null },
      { vaultName: 'v', collectionName: 'c', id: 'c', prior: envelope('c') },
    ]
    await bestEffortRevert(legs, adapter)
    expect(calls).toEqual([
      { op: 'put', id: 'c' },
      { op: 'delete', id: 'b' },
      { op: 'put', id: 'a' },
    ])
  })

  it('put(prior) when prior exists, delete() when prior is null', async () => {
    const { adapter, calls } = fakeAdapter()
    const legs: BestEffortRevertLeg[] = [
      { vaultName: 'v', collectionName: 'c', id: 'x', prior: envelope('x') },
      { vaultName: 'v', collectionName: 'c', id: 'y', prior: null },
    ]
    await bestEffortRevert(legs, adapter)
    expect(calls).toEqual([
      { op: 'delete', id: 'y' },
      { op: 'put', id: 'x' },
    ])
  })

  it('best-effort: continues past a leg whose raw revert throws', async () => {
    const { adapter, calls, failNext } = fakeAdapter()
    const legs: BestEffortRevertLeg[] = [
      { vaultName: 'v', collectionName: 'c', id: 'a', prior: envelope('a') },
      { vaultName: 'v', collectionName: 'c', id: 'b', prior: null },
      { vaultName: 'v', collectionName: 'c', id: 'c', prior: envelope('c') },
    ]
    failNext('b') // the middle leg in reverse order (c, b, a) throws on revert
    await expect(bestEffortRevert(legs, adapter)).resolves.toBeUndefined()
    // All three legs were still attempted, in reverse order, despite b's throw.
    expect(calls).toEqual([
      { op: 'put', id: 'c' },
      { op: 'delete', id: 'b' },
      { op: 'put', id: 'a' },
    ])
  })

  it('compensation callback fires per-leg, in reverse order, only when supplied', async () => {
    const { adapter } = fakeAdapter()
    const legs: BestEffortRevertLeg[] = [
      { vaultName: 'v', collectionName: 'c', id: 'a', prior: envelope('a') },
      { vaultName: 'v', collectionName: 'c', id: 'b', prior: envelope('b') },
    ]
    const compensated: string[] = []
    await bestEffortRevert(legs, adapter, (leg) => { compensated.push(leg.id) })
    expect(compensated).toEqual(['b', 'a'])
  })

  it('no compensation callback fires when none is supplied', async () => {
    const { adapter, calls } = fakeAdapter()
    const legs: BestEffortRevertLeg[] = [
      { vaultName: 'v', collectionName: 'c', id: 'a', prior: envelope('a') },
    ]
    await expect(bestEffortRevert(legs, adapter)).resolves.toBeUndefined()
    expect(calls).toEqual([{ op: 'put', id: 'a' }])
  })

  it('a leg whose raw revert throws is NOT compensated, but later (earlier-order) legs still are', async () => {
    const { adapter, failNext } = fakeAdapter()
    const legs: BestEffortRevertLeg[] = [
      { vaultName: 'v', collectionName: 'c', id: 'a', prior: envelope('a') },
      { vaultName: 'v', collectionName: 'c', id: 'b', prior: envelope('b') }, // will throw on revert
      { vaultName: 'v', collectionName: 'c', id: 'c', prior: envelope('c') },
    ]
    failNext('b')
    const compensated: string[] = []
    await bestEffortRevert(legs, adapter, (leg) => { compensated.push(leg.id) })
    // Reverse order is c, b, a. b's raw revert throws, so its compensation
    // never fires, but c (before it) and a (after it) both still compensate.
    expect(compensated).toEqual(['c', 'a'])
  })

  it('a throwing compensation callback is swallowed and does not stop the loop', async () => {
    const { adapter, calls } = fakeAdapter()
    const legs: BestEffortRevertLeg[] = [
      { vaultName: 'v', collectionName: 'c', id: 'a', prior: envelope('a') },
      { vaultName: 'v', collectionName: 'c', id: 'b', prior: envelope('b') },
    ]
    await expect(
      bestEffortRevert(legs, adapter, (leg) => {
        if (leg.id === 'b') throw new Error('compensation blew up')
      }),
    ).resolves.toBeUndefined()
    expect(calls).toEqual([
      { op: 'put', id: 'b' },
      { op: 'put', id: 'a' },
    ])
  })
})
