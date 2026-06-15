/**
 * Showcase 112 — debug-plaintext store mode (#413)
 *
 * What you'll learn
 * ─────────────────
 * `createNoydb({ encrypt: false, debugPlaintext: true })` — a DEV-ONLY mode
 * that lays plaintext data out so native store tooling (jq, the S3 console, a
 * DB browser) reads it DIRECTLY, without unwrapping `_data`:
 *   1. Records are written with their fields inlined beside the envelope
 *      metadata (`_debug: 1`, empty `_data`) — `jq '.total'` just works.
 *   2. Blobs are written as a single un-gzipped object — the chunk's base64
 *      `_data` decodes straight to the original bytes (`base64 -d`).
 *   3. `readPlaintextRecord(envelope)` is the programmatic unwrap helper
 *      (the core of a `noydb cat`), handling both the inlined and the classic
 *      plaintext layouts.
 *   4. It is rejected if combined with encryption — debug-plaintext is an
 *      unencrypted-only inspection mode.
 *
 * Why it matters
 * ──────────────
 * Zero-knowledge encryption is the default and the point — but during local
 * development you often want to point your store's native tools straight at the
 * data. This mode makes the store legible WITHOUT a decrypt step, while a CI
 * guard (`no-debug-plaintext-in-source`) ensures it never ships on in library
 * code. NEVER use it for production or client data.
 *
 * What to read next
 * ─────────────────
 *   - docs/core/02-encryption.md (§ Debug-plaintext mode)
 *   - docs/superpowers/specs/2026-06-15-plaintext-debug-store-mode-design.md
 *
 * Spec mapping
 * ────────────
 *   #413 — plaintext/debug store mode
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, readPlaintextRecord, DebugPlaintextError } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { memory } from '@noy-db/to-memory'

describe('showcase 112 — debug-plaintext store mode', () => {
  it('records are directly readable; blobs are a single un-gzipped object', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'dev', encrypt: false, debugPlaintext: true, blobStrategy: withBlobs() })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<{ id: string; total: string }>('invoices', { blobFields: { scan: {} } })

    await invoices.put('inv-1', { id: 'inv-1', total: '120.00' })

    // (1) The raw stored envelope has the record's fields at the top level.
    const raw = (await store.get('acme', 'invoices', 'inv-1'))! as Record<string, unknown>
    expect(raw._debug).toBe(1)
    expect(raw.total).toBe('120.00')

    // (3) readPlaintextRecord unwraps it (the `noydb cat` core).
    expect(readPlaintextRecord(raw as never)).toEqual({ id: 'inv-1', total: '120.00' })

    // (2) Blob → one un-gzipped object whose base64 decodes to the bytes.
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    await invoices.blob('inv-1').put('scan', bytes)
    const chunkKeys = await store.list('acme', '_blob_chunks')
    expect(chunkKeys.length).toBe(1)
    const chunk = (await store.get('acme', '_blob_chunks', chunkKeys[0]))!
    expect(Buffer.from(chunk._data, 'base64').equals(Buffer.from(bytes))).toBe(true)
    expect(Buffer.from((await invoices.blob('inv-1').get('scan'))!).equals(Buffer.from(bytes))).toBe(true)
  })

  it('(4) debugPlaintext + encryption is rejected', async () => {
    await expect(
      createNoydb({ store: memory(), user: 'dev', secret: 'pw-112-long-enough', debugPlaintext: true }),
    ).rejects.toBeInstanceOf(DebugPlaintextError)
  })
})
