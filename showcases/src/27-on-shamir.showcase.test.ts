/**
 * Showcase 27 — Shamir secret sharing for KEK recovery
 *
 * What you'll learn
 * ─────────────────
 * `splitKEK(kek, { n: 5, k: 3 })` splits a KEK into `n` shares such that
 * any `k` of them can reconstruct the original via `combineKEK()`. Fewer
 * than `k` shares yield no information about the KEK (the security
 * property of Shamir over GF(2^8)).
 *
 * Why it matters
 * ──────────────
 * The "trusted-board" recovery model: split the KEK into 5 shares given
 * to 5 people, require any 3 to reconstruct. No single person holds the
 * key, no single loss breaks recovery. Pairs naturally with on-recovery
 * for the high-trust escrow tier.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 26-on-recovery.
 *
 * What to read next
 * ─────────────────
 *   - showcase 28-on-totp (second-factor enrolment)
 *   - docs/subsystems/auth-shamir.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-shamir
 */

import { describe, it, expect } from 'vitest'
import { splitKEK, combineKEK } from '@noy-db/on-shamir'

describe('Showcase 27 — Shamir secret sharing', () => {
  it('any k of n shares reconstruct the KEK', async () => {
    const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const shares = await splitKEK(kek, { n: 5, k: 3 })
    expect(shares).toHaveLength(5)

    // Use any 3 of the 5 (board members 0, 2, 4 show up).
    const subset = [shares[0]!, shares[2]!, shares[4]!]
    const recovered = await combineKEK(subset)

    // Round-trip a payload through both keys to confirm exact byte match.
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, new TextEncoder().encode('quorum'))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, recovered, ct)
    expect(new TextDecoder().decode(pt)).toBe('quorum')
  })
})
