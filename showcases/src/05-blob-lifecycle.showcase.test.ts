/**
 * Showcase 05 — Blob Lifecycle (v0.12 #105)
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/170
 *
 * Framework: Node.js (pure hub, no framework glue)
 * Store:     `memory()`
 * Pattern:   Document-store attachments with amendment versioning
 * Dimension: Document store, blob attachments, versioning
 *
 * What this proves:
 *   1. `collection.blob(recordId)` returns a `BlobSet` handle. `.put()`
 *      uploads bytes with an auto-detected MIME type (PDF magic here),
 *      `.get()` round-trips them byte-for-byte, `.list()` enumerates slots.
 *   2. `.response()` produces a native `Response` with the correct
 *      `Content-Type` from magic-byte detection — the blob layer plays
 *      well with HTTP serving frameworks out of the box.
 *   3. `.publish(slot, label)` takes a snapshot of the current slot
 *      bytes. Overwriting the slot afterwards does NOT disturb the
 *      published version — `.getVersion(slot, label)` still returns the
 *      original bytes. This is amendment-safe versioning (UC-3).
 *   4. `.listVersions(slot)` enumerates all published labels.
 *   5. Chunks never leak plaintext to the backing store. Like every
 *      other NOYDB record, `_blob_chunks` holds AES-GCM ciphertext only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createNoydb,
  type Noydb,
  type NoydbStore,
} from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

import {
  type Invoice,
  sampleClients,
  fakePdfBytes,
  SHOWCASE_PASSPHRASE,
} from './_fixtures.js'

const VAULT = 'firm-demo'
const INVOICE_ID = 'inv-001'

describe('Showcase 05 — Blob Lifecycle', () => {
  let rawStore: NoydbStore
  let db: Noydb

  beforeEach(async () => {
    // Keep a handle to the raw memory store so step 6 can peek at
    // ciphertext chunks and prove the zero-knowledge boundary holds
    // for binary payloads too.
    rawStore = memory()

    db = await createNoydb({
      store: rawStore,
      user: 'owner',
      secret: SHOWCASE_PASSPHRASE,
    })
    await db.openVault(VAULT)

    // Create the parent invoice record — blobs attach to a real record.
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')
    await invoices.put(INVOICE_ID, {
      id: INVOICE_ID,
      clientId: sampleClients[0].id,
      amount: 12_500,
      currency: 'THB',
      status: 'draft',
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      month: '2026-04',
    })
  })

  afterEach(async () => {
    await db.close()
  })

  it('step 1 — put + get round-trips bytes exactly', async () => {
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')
    const blobs = invoices.blob(INVOICE_ID)

    const pdf = fakePdfBytes(4096)
    await blobs.put('receipt', pdf)

    const got = await blobs.get('receipt')
    expect(got).toBeTruthy()
    expect(got!.byteLength).toBe(pdf.byteLength)
    // Byte-for-byte equality — the compression + AES-GCM + chunk
    // round-trip is fully lossless.
    expect(Array.from(got!)).toEqual(Array.from(pdf))
  })

  it('step 2 — list() enumerates slots with metadata', async () => {
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')
    const blobs = invoices.blob(INVOICE_ID)

    await blobs.put('receipt', fakePdfBytes(2048))
    await blobs.put('signed-copy', fakePdfBytes(3072))

    const slots = await blobs.list()
    const names = slots.map(s => s.name).sort()
    expect(names).toEqual(['receipt', 'signed-copy'])

    const receipt = slots.find(s => s.name === 'receipt')!
    expect(receipt.size).toBe(2048)
    // MIME was auto-detected from the %PDF magic bytes in fakePdfBytes().
    expect(receipt.mimeType).toBe('application/pdf')
  })

  it('step 3 — response() returns a Response with Content-Type and original bytes', async () => {
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')
    const blobs = invoices.blob(INVOICE_ID)

    const pdf = fakePdfBytes(2048)
    await blobs.put('receipt', pdf)

    const res = await blobs.response('receipt')
    expect(res).toBeTruthy()
    expect(res!.headers.get('Content-Type')).toBe('application/pdf')
    // ETag and Content-Length are set too — BlobSet returns a
    // proper HTTP-ready Response, not just a raw body.
    expect(res!.headers.get('Content-Length')).toBe(String(pdf.byteLength))
    expect(res!.headers.get('ETag')).toBeTruthy()

    const buf = await res!.arrayBuffer()
    const bytes = new Uint8Array(buf)
    expect(bytes.byteLength).toBe(pdf.byteLength)
    expect(Array.from(bytes)).toEqual(Array.from(pdf))
  })

  it('step 4 — publish v1, mutate slot, publish v2; both versions survive', async () => {
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')
    const blobs = invoices.blob(INVOICE_ID)

    // v1 — initial draft of the receipt.
    const v1Bytes = fakePdfBytes(2048)
    await blobs.put('receipt', v1Bytes)
    await blobs.publish('receipt', 'v1')

    // Accountant amends the receipt — slot now holds different bytes.
    // Sized differently from v1 so a plain-length check is enough to
    // detect a version mix-up.
    const v2Bytes = fakePdfBytes(3072)
    await blobs.put('receipt', v2Bytes)
    await blobs.publish('receipt', 'v2')

    // The live slot matches v2 (latest write wins).
    const live = await blobs.get('receipt')
    expect(live!.byteLength).toBe(3072)

    // v1 is immutable — overwriting the slot did not clobber it.
    const gotV1 = await blobs.getVersion('receipt', 'v1')
    expect(gotV1).toBeTruthy()
    expect(gotV1!.byteLength).toBe(2048)
    expect(Array.from(gotV1!)).toEqual(Array.from(v1Bytes))

    // v2 matches the current live slot.
    const gotV2 = await blobs.getVersion('receipt', 'v2')
    expect(gotV2).toBeTruthy()
    expect(gotV2!.byteLength).toBe(3072)
    expect(Array.from(gotV2!)).toEqual(Array.from(v2Bytes))

    // And they really are different bytes — no silent aliasing.
    expect(gotV1!.byteLength).not.toBe(gotV2!.byteLength)
  })

  it('step 5 — listVersions() enumerates all published labels', async () => {
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')
    const blobs = invoices.blob(INVOICE_ID)

    await blobs.put('receipt', fakePdfBytes(2048))
    await blobs.publish('receipt', 'v1')

    await blobs.put('receipt', fakePdfBytes(3072))
    await blobs.publish('receipt', 'v2')

    const versions = await blobs.listVersions('receipt')
    const labels = versions.map(v => v.label).sort()
    expect(labels).toEqual(['v1', 'v2'])

    // Each version record carries the eTag of the immutable snapshot
    // plus a publishedAt timestamp.
    for (const v of versions) {
      expect(typeof v.eTag).toBe('string')
      expect(v.eTag.length).toBeGreaterThan(0)
      expect(typeof v.publishedAt).toBe('string')
    }
  })

  it('step 6 — recap: blob chunks are stored as ciphertext, not plaintext', async () => {
    const invoices = db.vault(VAULT).collection<Invoice>('invoices')
    const blobs = invoices.blob(INVOICE_ID)

    // Use a PDF large enough to produce at least one chunk but small
    // enough to stay single-chunk — simpler to inspect.
    const pdf = fakePdfBytes(2048)
    await blobs.put('receipt', pdf)

    // Peek at the `_blob_chunks` collection on the raw memory store.
    // This is the zero-knowledge proof point for binary payloads:
    // the store holds an EncryptedEnvelope whose `_data` is base64
    // ciphertext, not the PDF bytes.
    const chunkIds = await rawStore.list(VAULT, '_blob_chunks')
    expect(chunkIds.length).toBeGreaterThanOrEqual(1)

    const envelope = await rawStore.get(VAULT, '_blob_chunks', chunkIds[0])
    expect(envelope).toBeTruthy()
    expect(envelope!._noydb).toBe(1)
    expect(typeof envelope!._data).toBe('string')
    expect(typeof envelope!._iv).toBe('string')
    expect(envelope!._iv.length).toBeGreaterThan(0)

    // The %PDF magic never appears in the on-disk ciphertext —
    // AES-GCM has scrambled it.
    expect(envelope!._data).not.toContain('%PDF')
  })
})
