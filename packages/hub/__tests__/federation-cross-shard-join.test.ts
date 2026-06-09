/**
 * crossShardJoin — co-partitioned + broadcast dimension join.
 * Spec: docs/superpowers/specs/2026-06-09-cross-shard-join-design.md
 * Plan: docs/superpowers/plans/2026-06-09-cross-shard-join.md
 */
import { describe, it, expect } from 'vitest'
import { CrossShardJoinError, NoydbError } from '../src/errors.js'
import {
  applyBroadcastLegs,
  resetBroadcastWarnings,
  type BroadcastLeg,
  type BroadcastSource,
} from '../src/federation/cross-shard-join.js'

describe('CrossShardJoinError', () => {
  it('is a NoydbError with the CROSS_SHARD_JOIN code', () => {
    const e = new CrossShardJoinError('nope')
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('CROSS_SHARD_JOIN')
    expect(e.message).toBe('nope')
  })
})

function fakeSource(rows: Record<string, unknown>[]): BroadcastSource & { snapCalls: number } {
  let snapCalls = 0
  return {
    get snapCalls() { return snapCalls },
    snapshot() { snapCalls++; return rows },
  } as BroadcastSource & { snapCalls: number }
}

describe('applyBroadcastLegs', () => {
  it('attaches the matching dimension record by default on:id', async () => {
    const src = fakeSource([{ id: 'usd', symbol: '$' }, { id: 'eur', symbol: '€' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'id', mode: 'warn' }
    const out = await applyBroadcastLegs(
      [{ id: 'i1', currencyCode: 'usd' }, { id: 'i2', currencyCode: 'eur' }],
      [leg],
    )
    expect((out[0] as Record<string, unknown>).fx).toEqual({ id: 'usd', symbol: '$' })
    expect((out[1] as Record<string, unknown>).fx).toEqual({ id: 'eur', symbol: '€' })
  })

  it('matches on a custom key', async () => {
    const src = fakeSource([{ code: 'usd', symbol: '$' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'code', mode: 'warn' }
    const out = await applyBroadcastLegs([{ id: 'i1', currencyCode: 'usd' }], [leg])
    expect((out[0] as Record<string, unknown>).fx).toEqual({ code: 'usd', symbol: '$' })
  })

  it('attaches null on a miss', async () => {
    const src = fakeSource([{ id: 'usd' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'id', mode: 'cascade' }
    const out = await applyBroadcastLegs([{ id: 'i1', currencyCode: 'gbp' }], [leg])
    expect((out[0] as Record<string, unknown>).fx).toBeNull()
  })

  it('loads the source snapshot exactly once regardless of row count', async () => {
    const src = fakeSource([{ id: 'usd' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'id', mode: 'cascade' }
    await applyBroadcastLegs(
      Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, currencyCode: 'usd' })),
      [leg],
    )
    expect(src.snapCalls).toBe(1)
  })

  it('applies multiple legs independently', async () => {
    const fx = fakeSource([{ id: 'usd', symbol: '$' }])
    const adv = fakeSource([{ id: 'a1', name: 'Dana' }])
    const out = await applyBroadcastLegs(
      [{ id: 'i1', currencyCode: 'usd', advisorId: 'a1' }],
      [
        { field: 'currencyCode', as: 'fx', from: fx, on: 'id', mode: 'cascade' },
        { field: 'advisorId', as: 'advisor', from: adv, on: 'id', mode: 'cascade' },
      ],
    )
    expect((out[0] as Record<string, unknown>).fx).toEqual({ id: 'usd', symbol: '$' })
    expect((out[0] as Record<string, unknown>).advisor).toEqual({ id: 'a1', name: 'Dana' })
  })

  it('returns rows unchanged when there are no legs', async () => {
    resetBroadcastWarnings()
    const rows = [{ id: 'i1' }]
    const out = await applyBroadcastLegs(rows, [])
    expect(out).toEqual(rows)
  })
})
