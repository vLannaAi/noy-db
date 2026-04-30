/**
 * Showcase 22 — Passphrase unlock (always-on)
 *
 * What you'll learn
 * ─────────────────
 * The default unlock path: a user's passphrase is run through
 * PBKDF2-SHA256 (600,000 iterations) to derive a KEK that unwraps
 * the per-collection DEKs. No `on-*` package needed — passphrase
 * unlock ships with `@noy-db/hub`.
 *
 * Why it matters
 * ──────────────
 * Every other unlock method (WebAuthn, OIDC, magic-link, ...) wraps
 * a *different* secret-derivation path around the same KEK shape.
 * If you understand passphrase unlock, you understand the contract
 * every other `on-*` package implements.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 06.
 *
 * What to read next
 * ─────────────────
 *   - showcase 23-on-webauthn (passkey unlock)
 *   - docs/core/02-encryption.md (PBKDF2 + AES-KW key hierarchy)
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-passphrase
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, InvalidKeyError } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 22 — Passphrase unlock', () => {
  it('the right passphrase unwraps the keyring', async () => {
    const store = memory()

    const db1 = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct-horse-battery-staple-2026',
    })
    const v1 = await db1.openVault('demo')
    await v1.collection<Note>('notes').put('a', { id: 'a', text: 'sealed' })
    db1.close()

    // Same passphrase → same KEK → records readable.
    const db2 = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct-horse-battery-staple-2026',
    })
    const v2 = await db2.openVault('demo')
    expect(await v2.collection<Note>('notes').get('a')).toEqual({ id: 'a', text: 'sealed' })
    db2.close()
  })

  it('a wrong passphrase rejects with InvalidKeyError', async () => {
    const store = memory()

    const db1 = await createNoydb({
      store,
      user: 'alice',
      secret: 'correct-horse-battery-staple-2026',
    })
    const v1 = await db1.openVault('demo')
    // Write a record so the keyring is persisted — wrong-passphrase
    // detection runs at unwrap, which only happens when there's something
    // to unwrap.
    await v1.collection<Note>('notes').put('a', { id: 'a', text: 'sealed' })
    db1.close()

    const db2 = await createNoydb({
      store,
      user: 'alice',
      secret: 'wrong-passphrase',
    })
    await expect(db2.openVault('demo')).rejects.toBeInstanceOf(InvalidKeyError)
  })
})
