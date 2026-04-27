/**
 * Showcase 31 — Lockout, duress, honeypot
 *
 * What you'll learn
 * ─────────────────
 * The threat triad on a single state object. `recordFailure()` increments
 * an attempt counter and arms an exponential-backoff timer; `isLocked()`
 * is the gate the unlock path checks. `enrollDuress()` registers a
 * secondary passphrase that, when typed, looks like success but signals
 * the calling app to enter a degraded "safe" mode.
 *
 * Why it matters
 * ──────────────
 * Brute-force protection (lockout) and coercion protection (duress) are
 * orthogonal but share the same surface. The package keeps both small
 * and stateless so consumers can persist the lockout state in IndexedDB,
 * Postgres, or wherever fits their model.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase.
 *
 * What to read next
 * ─────────────────
 *   - showcase 32-as-csv (export starts here)
 *   - docs/subsystems/auth-threat.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-threat
 */

import { describe, it, expect } from 'vitest'
import {
  initialLockoutState,
  recordFailure,
  recordSuccess,
  isLocked,
  enrollDuress,
  checkDuress,
} from '@noy-db/on-threat'

describe('Showcase 31 — Threat protection', () => {
  it('lockout arms after the configured attempts', () => {
    const state = initialLockoutState()
    const config = { threshold: 3, windowMs: 60_000, cooldownMs: 60_000 }

    recordFailure(state, config)
    recordFailure(state, config)
    expect(isLocked(state)).toBe(false)

    const last = recordFailure(state, config)
    expect(last.locked).toBe(true)
    expect(isLocked(state)).toBe(true)

    // A successful unlock clears the counter.
    recordSuccess(state)
    expect(isLocked(state)).toBe(false)
  })

  it('duress passphrase verifies separately from the real one', async () => {
    const { digest, salt } = await enrollDuress('911-help-me')

    expect(await checkDuress('911-help-me', digest, salt)).toBe(true)
    expect(await checkDuress('correct-horse-battery-staple', digest, salt)).toBe(false)
  })
})
