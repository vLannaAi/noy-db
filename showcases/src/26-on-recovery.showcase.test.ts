/**
 * Showcase 26 — Printable recovery codes
 *
 * What you'll learn
 * ─────────────────
 * `generateRecoveryCodeSet({ kek, count })` produces N high-entropy,
 * human-readable codes (groups of 4 chars separated by `-`) plus a
 * matching `entries` array — each entry holds the code's salt and
 * wrapped-KEK ciphertext (safe to persist). Hand the codes to the user;
 * keep the entries with the vault. Any code + its matching entry
 * unwraps the KEK via `unwrapKEKFromRecovery()`.
 *
 * Why it matters
 * ──────────────
 * The "I lost my phone" recovery path. PBKDF2 (600K iterations) over the
 * typed code keeps brute-force cost high even if the wrapped blob leaks.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase (the keyring + KEK shape).
 *
 * What to read next
 * ─────────────────
 *   - showcase 27-on-shamir (k-of-n secret sharing — beats single recovery codes)
 *   - docs/subsystems/auth-recovery.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-recovery
 */

import { describe, it, expect } from 'vitest'
import { generateRecoveryCodeSet, parseRecoveryCode, unwrapKEKFromRecovery } from '@noy-db/on-recovery'

describe('Showcase 26 — Recovery codes', () => {
  it('generates N codes; every one parses cleanly', async () => {
    const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const set = await generateRecoveryCodeSet({ kek, count: 5 })
    expect(set.codes).toHaveLength(5)
    expect(set.entries).toHaveLength(5)

    for (const code of set.codes) {
      const parsed = parseRecoveryCode(code)
      expect(parsed.status).toBe('valid')
    }
  })

  it('any code from the set unwraps the same KEK that was wrapped at enrollment', async () => {
    const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    const set = await generateRecoveryCodeSet({ kek, count: 3 })

    // The user types the first code on the recovery sheet; we look up the
    // matching entry by index (in production the entries are persisted
    // alongside the vault and located by codeId).
    const formatted = set.codes[0]!
    const parsed = parseRecoveryCode(formatted)
    if (parsed.status !== 'valid') throw new Error('parse failed')

    const entry = set.entries[0]!
    const unwrapped = await unwrapKEKFromRecovery(parsed.code, entry)

    // Round-trip a payload through both the original and the recovered
    // KEK — proves the unwrap reproduced the exact same key bytes.
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, new TextEncoder().encode('survived'))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, unwrapped, ct)
    expect(new TextDecoder().decode(pt)).toBe('survived')
  })
})
