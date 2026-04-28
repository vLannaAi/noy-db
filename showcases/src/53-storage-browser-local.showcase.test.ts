/**
 * Showcase 53 — Storage: localStorage (browser fallback)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-browser-local` keeps the entire vault in `localStorage`
 * under keys of the form `{prefix}:{vault}:{collection}:{id}`. Single-
 * threaded JavaScript gives it `casAtomic: true` for free — no
 * IndexedDB transaction needed.
 *
 * Why it matters
 * ──────────────
 * `to-browser-idb` is the right default for browser apps, but
 * IndexedDB is occasionally unavailable: private-mode Safari, certain
 * embedded webviews, or test harnesses without a polyfill. This store
 * is the fallback that keeps the same NoydbStore contract working in
 * those environments. It is also the only store whose contents are
 * inspectable from the DevTools "Application" tab without extra
 * tooling — useful for early-development debugging.
 *
 * The package supports an `obfuscate: true` mode that hashes the key
 * components so neither the vault names, collection names, nor record
 * IDs leak into the keyspace. This is *not* a substitute for
 * encryption — `_data` stays AES-GCM ciphertext either way — but it
 * does prevent a casual observer from learning the schema.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 03 (`to-browser-idb` — the canonical browser store).
 * - happy-dom provides `localStorage` natively in the showcase
 *   runtime; in a real browser the global is identical.
 *
 * What to read next
 * ─────────────────
 *   - showcase 03-storage-browser-idb (preferred browser default)
 *   - docs/packages/stores.md (full storage destination catalog)
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-browser-local
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { browserLocalStore } from '@noy-db/to-browser-local'

interface Note { id: string; text: string }

describe('Showcase 53 — Storage: localStorage (browser fallback)', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('round-trips records through localStorage', async () => {
    const store = browserLocalStore({ prefix: 'showcase-53' })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-local-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in localStorage' })
    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in localStorage' })
    db.close()
  })

  it('writes are visible in the localStorage keyspace under the configured prefix', async () => {
    const store = browserLocalStore({ prefix: 'showcase-53-keys' })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-local-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    await vault.collection<Note>('notes').put('a', { id: 'a', text: 'visible' })
    db.close()

    const ourKeys = Object.keys(localStorage).filter((k) => k.startsWith('showcase-53-keys:'))
    expect(ourKeys.length).toBeGreaterThan(0)
    expect(ourKeys.some((k) => k.includes('demo') && k.includes('notes'))).toBe(true)
  })

  it('obfuscate mode hides vault / collection / id from the keyspace', async () => {
    const plainStore = browserLocalStore({ prefix: 'showcase-53-plain' })
    const obfStore = browserLocalStore({ prefix: 'showcase-53-obf', obfuscate: true })

    for (const store of [plainStore, obfStore]) {
      const db = await createNoydb({
        store,
        user: 'alice',
        secret: 'storage-local-obfuscate-2026',
      })
      const vault = await db.openVault('finance')
      await vault.collection<Note>('invoices').put('inv-001', { id: 'inv-001', text: 'sensitive' })
      db.close()
    }

    const plainKeys = Object.keys(localStorage).filter((k) => k.startsWith('showcase-53-plain:'))
    const obfKeys = Object.keys(localStorage).filter((k) => k.startsWith('showcase-53-obf:'))

    // Plain mode leaks logical structure: vault, collection, and id are visible.
    expect(plainKeys.some((k) => k.includes('finance'))).toBe(true)
    expect(plainKeys.some((k) => k.includes('invoices'))).toBe(true)

    // Obfuscate mode does not — only the configured prefix survives in plaintext.
    expect(obfKeys.some((k) => k.includes('finance'))).toBe(false)
    expect(obfKeys.some((k) => k.includes('invoices'))).toBe(false)
    expect(obfKeys.some((k) => k.includes('inv-001'))).toBe(false)
  })
})
