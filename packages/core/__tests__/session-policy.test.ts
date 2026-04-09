/**
 * Tests for v0.7 #114 — session policies
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { PolicyEnforcer, validateSessionPolicy } from '../src/session-policy.js'
import { SessionExpiredError, SessionPolicyError } from '../src/errors.js'
import { revokeAllSessions } from '../src/session.js'

afterEach(() => {
  vi.useRealTimers()
  revokeAllSessions()
})

describe('validateSessionPolicy', () => {
  it('accepts a valid policy with all fields', () => {
    expect(() =>
      validateSessionPolicy({
        idleTimeoutMs: 5 * 60_000,
        absoluteTimeoutMs: 8 * 60 * 60_000,
        requireReAuthFor: ['export', 'grant'],
        lockOnBackground: false,
      }),
    ).not.toThrow()
  })

  it('accepts an empty policy', () => {
    expect(() => validateSessionPolicy({})).not.toThrow()
  })

  it('throws if idleTimeoutMs is 0', () => {
    expect(() => validateSessionPolicy({ idleTimeoutMs: 0 })).toThrow()
  })

  it('throws if idleTimeoutMs is negative', () => {
    expect(() => validateSessionPolicy({ idleTimeoutMs: -1000 })).toThrow()
  })

  it('throws if idleTimeoutMs >= absoluteTimeoutMs', () => {
    expect(() =>
      validateSessionPolicy({ idleTimeoutMs: 10_000, absoluteTimeoutMs: 10_000 }),
    ).toThrow()
    expect(() =>
      validateSessionPolicy({ idleTimeoutMs: 20_000, absoluteTimeoutMs: 10_000 }),
    ).toThrow()
  })
})

describe('PolicyEnforcer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  function makeEnforcer(opts: {
    idleTimeoutMs?: number
    absoluteTimeoutMs?: number
    requireReAuthFor?: Array<'export' | 'grant' | 'revoke' | 'rotate' | 'changeSecret'>
  }): { enforcer: PolicyEnforcer; onRevoke: ReturnType<typeof vi.fn> } {
    const onRevoke = vi.fn()
    const enforcer = new PolicyEnforcer({
      policy: opts,
      sessionId: 'test-session-id',
      onRevoke,
    })
    return { enforcer, onRevoke }
  }

  // ── idle timeout ──────────────────────────────────────────────────────────

  it('calls onRevoke with "idle" after idleTimeoutMs elapses', () => {
    const { enforcer, onRevoke } = makeEnforcer({ idleTimeoutMs: 5_000 })
    expect(onRevoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_000)
    expect(onRevoke).toHaveBeenCalledWith('idle')
    enforcer.destroy()
  })

  it('resets idle timer on touch()', () => {
    const { enforcer, onRevoke } = makeEnforcer({ idleTimeoutMs: 5_000 })
    vi.advanceTimersByTime(4_000)
    enforcer.touch()
    vi.advanceTimersByTime(4_000)
    expect(onRevoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(onRevoke).toHaveBeenCalledWith('idle')
    enforcer.destroy()
  })

  // ── absolute timeout ──────────────────────────────────────────────────────

  it('calls onRevoke with "absolute" after absoluteTimeoutMs elapses', () => {
    const { enforcer, onRevoke } = makeEnforcer({
      idleTimeoutMs: 5 * 60_000,
      absoluteTimeoutMs: 10_000,
    })
    vi.advanceTimersByTime(10_000)
    expect(onRevoke).toHaveBeenCalledWith('absolute')
    enforcer.destroy()
  })

  it('absolute timeout fires even if idle timer keeps getting reset', () => {
    // idle=6s, absolute=10s
    // Touches happen every 5s — idle timer always resets before it fires.
    // At t=10s, absolute fires before idle's next scheduled fire at t=10s.
    const { enforcer, onRevoke } = makeEnforcer({
      idleTimeoutMs: 6_000,
      absoluteTimeoutMs: 10_000,
    })
    // t=5000: touch → idle resets, fires at t=11000 (after absolute at t=10000)
    vi.advanceTimersByTime(5_000); enforcer.touch()
    // t=10000: absolute fires — idle hasn't fired yet (would fire at 11000)
    vi.advanceTimersByTime(5_000)
    expect(onRevoke).toHaveBeenCalledWith('absolute')
    enforcer.destroy()
  })

  // ── requireReAuthFor ──────────────────────────────────────────────────────

  it('checkOperation passes for ops not in requireReAuthFor', () => {
    const { enforcer } = makeEnforcer({ requireReAuthFor: ['export'] })
    expect(() => enforcer.checkOperation('grant')).not.toThrow()
    expect(() => enforcer.checkOperation('revoke')).not.toThrow()
    enforcer.destroy()
  })

  it('checkOperation throws SessionPolicyError for ops in requireReAuthFor', () => {
    const { enforcer } = makeEnforcer({ requireReAuthFor: ['export', 'grant'] })
    expect(() => enforcer.checkOperation('export')).toThrow(SessionPolicyError)
    expect(() => enforcer.checkOperation('grant')).toThrow(SessionPolicyError)
    enforcer.destroy()
  })

  it('SessionPolicyError.operation matches the blocked op name', () => {
    const { enforcer } = makeEnforcer({ requireReAuthFor: ['rotate'] })
    try {
      enforcer.checkOperation('rotate')
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SessionPolicyError)
      expect((err as SessionPolicyError).operation).toBe('rotate')
    }
    enforcer.destroy()
  })

  // ── checkOperation with absolute timeout ──────────────────────────────────

  it('checkOperation throws SessionExpiredError if absolute timeout exceeded', () => {
    const { enforcer } = makeEnforcer({ absoluteTimeoutMs: 5_000 })
    vi.advanceTimersByTime(5_001)
    expect(() => enforcer.checkOperation('grant')).toThrow(SessionExpiredError)
    enforcer.destroy()
  })

  // ── destroy ───────────────────────────────────────────────────────────────

  it('destroy() prevents idle timer from firing', () => {
    const { enforcer, onRevoke } = makeEnforcer({ idleTimeoutMs: 5_000 })
    enforcer.destroy()
    vi.advanceTimersByTime(10_000)
    expect(onRevoke).not.toHaveBeenCalled()
  })

  it('destroy() prevents absolute timer from firing', () => {
    const { enforcer, onRevoke } = makeEnforcer({ absoluteTimeoutMs: 3_000 })
    enforcer.destroy()
    vi.advanceTimersByTime(10_000)
    expect(onRevoke).not.toHaveBeenCalled()
  })

  // ── idleMs / ageMs ────────────────────────────────────────────────────────

  it('idleMs reflects time since last touch', () => {
    const { enforcer } = makeEnforcer({})
    vi.advanceTimersByTime(2_000)
    expect(enforcer.idleMs).toBeGreaterThanOrEqual(2_000)
    enforcer.touch()
    expect(enforcer.idleMs).toBeLessThan(100)
    enforcer.destroy()
  })

  it('ageMs reflects time since creation', () => {
    const { enforcer } = makeEnforcer({})
    vi.advanceTimersByTime(7_000)
    expect(enforcer.ageMs).toBeGreaterThanOrEqual(7_000)
    enforcer.destroy()
  })
})
