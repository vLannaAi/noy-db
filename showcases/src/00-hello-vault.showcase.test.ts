/**
 * Showcase 00 — Hello, vault
 *
 * What you'll learn
 * ─────────────────
 * The smallest working example: open a vault, put one record, get it
 * back. No subsystems opted in, no cloud adapters, no framework. Just
 * the always-on core + the in-memory test store.
 *
 * Why it matters
 * ──────────────
 * Every later showcase builds on this floor. If you can run this one,
 * encryption + keyring + envelope round-trip work on your machine.
 * If you cannot, fix that before reading anything else — every other
 * showcase will fail for the same reason.
 *
 * Prerequisites
 * ─────────────
 * - Node >= 18 or any runtime with `crypto.subtle` (Web Crypto API).
 * - `pnpm install` from the repo root.
 *
 * What to read next
 * ─────────────────
 *   - showcase 01-storage-memory (more on `@noy-db/to-memory`)
 *   - showcase 02-storage-file (persist to disk via `@noy-db/to-file`)
 *   - docs/core/01-vault-and-collections.md (full reference)
 *   - docs/core/02-encryption.md (how the envelope is built)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → vault-and-collections (and → encryption)
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Note {
  id: string
  text: string
}

describe('Showcase 00 — Hello, vault', () => {
  it('opens a vault, puts a record, gets it back', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'hello-vault-passphrase-2026',
    })

    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    await notes.put('n1', { id: 'n1', text: 'hello world' })
    const out = await notes.get('n1')

    expect(out).toEqual({ id: 'n1', text: 'hello world' })
    db.close()
  })

  it('confirms the store sees only ciphertext (the trust boundary)', async () => {
    // Hold a reference to the store so we can read the envelope back
    // out and inspect it.
    const store = memory()
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'hello-vault-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    const SECRET_PHRASE = 'a-secret-string-no-store-should-ever-see'
    await notes.put('n1', { id: 'n1', text: SECRET_PHRASE })

    // Read the envelope directly from the store. `_data` is the
    // base64-encoded AES-GCM ciphertext; the original plaintext must
    // not appear in any envelope field.
    const envelope = await store.get('demo', 'notes', 'n1')
    expect(envelope).not.toBeNull()
    expect(envelope!._noydb).toBe(1)
    expect(typeof envelope!._iv).toBe('string')
    expect(envelope!._iv.length).toBeGreaterThan(0)
    expect(envelope!._data).not.toContain(SECRET_PHRASE)

    db.close()
  })
})
