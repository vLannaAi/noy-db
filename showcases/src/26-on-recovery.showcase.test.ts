/**
 * Showcase 26 — Printable recovery codes
 *
 * What you'll learn
 * ─────────────────
 * `generateRecoveryCodeSet({ deks, count })` produces N high-entropy,
 * human-readable codes (groups of 4 chars separated by `-`) plus a
 * matching `entries` array — each entry holds the code's salt + IV +
 * wrapped-DEKs ciphertext (safe to persist). Hand the codes to the
 * user; the entries go to the vault via
 * `db.enrollRecovery({ profile: 'paper', entries })`. Any code + its
 * matching entry round-trips through `unwrapDeksFromPaperEntry()` to
 * recover the same DEK set.
 *
 * Why it matters
 * ──────────────
 * The "I lost my phone" recovery path. PBKDF2 (600K iterations) over the
 * typed code keeps brute-force cost high even if the wrapped blob leaks.
 *
 * Format note (post pre.8 — #38 Option A)
 * ───────────────────────────────────────
 * Recovery now wraps the DEK set (not the KEK), matching the hub's
 * unified wrap-DEKs primitive used by tier-0 (paper recovery), tier-2
 * (`@noy-db/on-password`), and tier-3 (`@noy-db/on-pin`). The pre.7
 * wrap-KEK shape is gone.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase (the keyring + KEK shape).
 *
 * What to read next
 * ─────────────────
 *   - showcase 27-on-shamir (k-of-n secret sharing — beats single recovery codes)
 *   - docs/services/auth-recovery.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-recovery
 */

import { describe, it, expect } from 'vitest'
import { generateRecoveryCodeSet, parseRecoveryCode } from '@noy-db/on-recovery'
import { unwrapDeksFromPaperEntry } from '@noy-db/hub'

async function freshDeks(): Promise<Map<string, CryptoKey>> {
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  return new Map([['invoices', dek]])
}

describe('Showcase 26 — Recovery codes', () => {
  it('generates N codes; every one parses cleanly', async () => {
    const deks = await freshDeks()
    const set = await generateRecoveryCodeSet({ deks, count: 5 })
    expect(set.codes).toHaveLength(5)
    expect(set.entries).toHaveLength(5)

    for (const code of set.codes) {
      const parsed = parseRecoveryCode(code)
      expect(parsed.status).toBe('valid')
    }
  })

  it('any code from the set recovers the same DEKs that were wrapped at enrollment', async () => {
    const deks = await freshDeks()
    const set = await generateRecoveryCodeSet({ deks, count: 3 })

    // The user types the first code on the recovery sheet; we look up the
    // matching entry by index (in production the entries are persisted
    // alongside the vault and located by codeId).
    const formatted = set.codes[0]!
    const parsed = parseRecoveryCode(formatted)
    if (parsed.status !== 'valid') throw new Error('parse failed')

    const entry = set.entries[0]!
    const recovered = await unwrapDeksFromPaperEntry(entry, parsed.code)

    // Round-trip a payload through both the original and the recovered
    // DEK — proves the unwrap reproduced the exact same key bytes.
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deks.get('invoices')!, new TextEncoder().encode('survived'))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, recovered.get('invoices')!, ct)
    expect(new TextDecoder().decode(pt)).toBe('survived')
  })
})
