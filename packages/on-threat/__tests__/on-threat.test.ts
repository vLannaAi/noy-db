import { describe, expect, it } from 'vitest'
import {
  initialLockoutState,
  recordFailure,
  recordSuccess,
  isLocked,
  enrollDuress,
  checkDuress,
  enrollHoneypot,
  checkHoneypot,
} from '../src/index.js'

describe('lockout policy (#196)', () => {
  it('initial state is unlocked with no failures', () => {
    const s = initialLockoutState()
    expect(s.failures).toBe(0)
    expect(s.lockedUntil).toBeNull()
    expect(isLocked(s)).toBe(false)
  })

  it('accumulates failures up to threshold without locking', () => {
    const s = initialLockoutState()
    for (let i = 0; i < 4; i++) {
      const r = recordFailure(s, { threshold: 5 })
      expect(r.locked).toBe(false)
      expect(r.remainingAttempts).toBe(4 - i)
    }
  })

  it('locks on the threshold-th failure with unlockAt', () => {
    const s = initialLockoutState()
    for (let i = 0; i < 4; i++) recordFailure(s, { threshold: 5, cooldownMs: 1000 })
    const trip = recordFailure(s, { threshold: 5, cooldownMs: 1000 })
    expect(trip.locked).toBe(true)
    expect(trip.unlockAt).toBeTruthy()
    expect(s.strikes).toBe(1)
  })

  it('isLocked returns true during cooldown', () => {
    const s = initialLockoutState()
    for (let i = 0; i < 5; i++) recordFailure(s, { threshold: 5, cooldownMs: 10_000 })
    expect(isLocked(s)).toBe(true)
  })

  it('recordSuccess resets window + failures but latches strikes', () => {
    const s = initialLockoutState()
    for (let i = 0; i < 5; i++) recordFailure(s, { threshold: 5, cooldownMs: 1 })
    // Wait past the (1ms) cooldown
    s.lockedUntil = new Date(Date.now() - 1000).toISOString()
    recordSuccess(s)
    expect(s.failures).toBe(0)
    expect(s.lockedUntil).toBeNull()
    expect(s.strikes).toBe(1) // latched
  })

  it('tripping maxStrikes signals wipe', () => {
    const s = initialLockoutState()
    const cfg = { threshold: 2, cooldownMs: 1, maxStrikes: 2 }
    // First strike
    recordFailure(s, cfg); recordFailure(s, cfg)
    // Simulate cooldown expiry + second round
    s.lockedUntil = new Date(Date.now() - 1000).toISOString()
    recordFailure(s, cfg)
    const wipe = recordFailure(s, cfg)
    expect(wipe.wipe).toBe(true)
    expect(s.wiped).toBe(true)
    expect(isLocked(s)).toBe(true) // wiped implies locked forever
  })
})

describe('duress passphrase (#197)', () => {
  it('enroll returns distinct digest + salt', async () => {
    const a = await enrollDuress('help!')
    const b = await enrollDuress('help!')
    expect(a.digest).not.toBe(b.digest) // different salts → different digests
    expect(a.salt).not.toBe(b.salt)
    expect(a.digest).toHaveLength(64)
    expect(a.salt).toHaveLength(32)
  })

  it('check returns true for the enrolled passphrase', async () => {
    const { digest, salt } = await enrollDuress('help me please')
    expect(await checkDuress('help me please', digest, salt)).toBe(true)
  })

  it('check returns false for a different passphrase', async () => {
    const { digest, salt } = await enrollDuress('help me please')
    expect(await checkDuress('wrong', digest, salt)).toBe(false)
  })

  it('check is case-sensitive', async () => {
    const { digest, salt } = await enrollDuress('SecretPhrase')
    expect(await checkDuress('secretphrase', digest, salt)).toBe(false)
  })
})

describe('honeypot passphrase (#198)', () => {
  it('shares the same detection primitives as duress', async () => {
    expect(enrollHoneypot).toBe(enrollDuress)
    expect(checkHoneypot).toBe(checkDuress)
  })

  it('detects the honeypot passphrase correctly', async () => {
    const { digest, salt } = await enrollHoneypot('the decoy key')
    expect(await checkHoneypot('the decoy key', digest, salt)).toBe(true)
    expect(await checkHoneypot('something else', digest, salt)).toBe(false)
  })
})
