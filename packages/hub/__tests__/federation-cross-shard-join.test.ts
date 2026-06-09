/**
 * crossShardJoin — co-partitioned + broadcast dimension join.
 * Spec: docs/superpowers/specs/2026-06-09-cross-shard-join-design.md
 * Plan: docs/superpowers/plans/2026-06-09-cross-shard-join.md
 */
import { describe, it, expect } from 'vitest'
import { CrossShardJoinError, NoydbError } from '../src/errors.js'

describe('CrossShardJoinError', () => {
  it('is a NoydbError with the CROSS_SHARD_JOIN code', () => {
    const e = new CrossShardJoinError('nope')
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('CROSS_SHARD_JOIN')
    expect(e.message).toBe('nope')
  })
})
