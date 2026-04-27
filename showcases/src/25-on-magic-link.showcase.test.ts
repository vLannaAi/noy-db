/**
 * Showcase 25 — Magic-link delegated access
 *
 * What you'll learn
 * ─────────────────
 * `createMagicLinkToken(vault, { ttlMs })` mints a one-shot, viewer-only
 * delegation: a ULID `token` bound to a vault with a fixed
 * `expiresAt`. `isMagicLinkValid()` is the cheap pre-flight every
 * unlock path runs before touching the store. Once redeemed, a
 * server-secret + the link token deterministically derive the KEK that
 * unwraps the delegated keyring.
 *
 * Why it matters
 * ──────────────
 * Read-only client portals, single-document review flows, "send my
 * accountant a link" — all of these need a delegation primitive that
 * doesn't require the recipient to set up an account. The `viewer` role
 * pin keeps the blast radius bounded.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase.
 *
 * What to read next
 * ─────────────────
 *   - showcase 26-on-recovery (printable recovery codes)
 *   - docs/subsystems/auth-magic-link.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-magic-link
 */

import { describe, it, expect } from 'vitest'
import { createMagicLinkToken, isMagicLinkValid, deriveMagicLinkKEK } from '@noy-db/on-magic-link'

describe('Showcase 25 — Magic-link delegation', () => {
  it('a fresh token is valid; an expired one is not', () => {
    const fresh = createMagicLinkToken('demo', { ttlMs: 60_000 })
    expect(fresh.vault).toBe('demo')
    expect(fresh.role).toBe('viewer')
    expect(typeof fresh.token).toBe('string')
    expect(isMagicLinkValid(fresh)).toBe(true)

    const expired = createMagicLinkToken('demo', { ttlMs: -1 })
    expect(isMagicLinkValid(expired)).toBe(false)
  })

  it('deriveMagicLinkKEK is deterministic given (serverSecret, token, vault)', async () => {
    const link = createMagicLinkToken('demo', { ttlMs: 60_000 })
    const serverSecret = 'kept-on-the-server-only'

    // The derived key is an AES-KW wrapping key — the same shape used to
    // wrap the per-collection DEKs in a magic-link viewer keyring. Two
    // independent derivations of the same (serverSecret, token, vault)
    // triple must wrap+unwrap interchangeably.
    const k1 = await deriveMagicLinkKEK(serverSecret, link.token, link.vault)
    const k2 = await deriveMagicLinkKEK(serverSecret, link.token, link.vault)

    // Generate a target DEK; wrap it with k1; unwrap it with k2.
    const targetDek = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
    )
    const wrapped = await crypto.subtle.wrapKey('raw', targetDek, k1, { name: 'AES-KW' })
    const recovered = await crypto.subtle.unwrapKey(
      'raw', wrapped, k2, { name: 'AES-KW' },
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
    )

    // The recovered DEK round-trips a payload — proves k1 ≡ k2.
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, recovered, new TextEncoder().encode('hi'))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, targetDek, ct)
    expect(new TextDecoder().decode(pt)).toBe('hi')

    // A different server secret yields a different key — unwrap fails.
    const k3 = await deriveMagicLinkKEK('different-secret', link.token, link.vault)
    await expect(
      crypto.subtle.unwrapKey(
        'raw', wrapped, k3, { name: 'AES-KW' },
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
      ),
    ).rejects.toThrow()
  })
})
