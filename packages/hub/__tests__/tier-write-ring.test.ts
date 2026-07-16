/**
 * #715/#716 — the write ring. A tier-0 put()/delete() targeting an elevated
 * record is refused uniformly (spec: docs/superpowers/specs/2026-07-16-write-ring-refusal-design.md).
 * Holders are refused too: put()/delete() are the tier-0 APIs; putAtTier/
 * elevate/demote are the sanctioned tier-aware paths.
 *
 * Task 1 scope: the error-contract test only. Task 2 wires assertTierWritable
 * into collection.ts's choke points and appends the integration tests.
 */
import { describe, it, expect } from 'vitest'
import { TierWriteRefusedError } from '../src/index.js'

describe('#715 TierWriteRefusedError', () => {
  it('names the collection, the tier, and the remedy', () => {
    const e = new TierWriteRefusedError('docs', 2)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('TierWriteRefusedError')
    expect(e.collection).toBe('docs')
    expect(e.tier).toBe(2)
    expect(e.message).toMatch(/putAtTier/) // actionable remedy named
  })
})
