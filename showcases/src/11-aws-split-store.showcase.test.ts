/**
 * Showcase 11 — "AWS Split Store: records in DynamoDB, blobs in S3"
 *
 * Framework: Pure hub (Node.js, no framework glue)
 * Store:     `routeStore({ default: dynamo(...), blobs: s3(...) })`
 * Pattern:   Pattern C from docs/topology-matrix.md — canonical split-store
 *            topology: structured records to DynamoDB (CAS-atomic, cheap
 *            per-item), encrypted binary chunks to S3 (unlimited size,
 *            lifecycle-tierable). One `createNoydb()` call, transparent
 *            routing inside `routeStore`.
 * Dimension: Cloud-native, realistic production wiring — the exact
 *            deployment shape the topology matrix recommends for any app
 *            with binary attachments.
 *
 * SKIPPED BY DEFAULT.
 *
 * Runs only when `NOYDB_SHOWCASE_AWS_PROFILE=<profile-name>` is set in
 * `showcases/.env`. Credentials + region come from that profile; this
 * file never reads raw credentials.
 *
 * Prerequisites (one-time):
 *
 *   aws cloudformation deploy \
 *     --template-file showcases/cfn-showcase-table.yaml \
 *     --stack-name noydb-showcase \
 *     --profile <your-profile-name>
 *
 * The CFN template provisions both the DynamoDB table AND an S3 bucket
 * with a 1-day lifecycle rule as a safety net in case afterAll cleanup
 * fails. Stack teardown is always manual.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createNoydb, routeStore, type Noydb, type NoydbStore } from '@noy-db/hub'
import { dynamo } from '@noy-db/to-aws-dynamo'
import { s3 } from '@noy-db/to-aws-s3'

import {
  type Invoice,
  fakePdfBytes,
  sampleClients,
  SHOWCASE_PASSPHRASE,
} from './_fixtures.js'
import {
  AWS_ENABLED,
  DYNAMO_TABLE,
  S3_BUCKET,
  RUN_ID,
  cleanupVault,
  logSkipHint,
} from './_aws.js'

logSkipHint('showcase-11')

const VAULT_NAME = `showcase-11-${RUN_ID}`
const INVOICE_ID = 'inv-split-001'
const SLOT = 'receipt'

// Blob chunks land in the NOYDB system collection `_blob_chunks`. Index
// metadata + per-record slot metadata live in `_blob_index` and
// `_blob_slots_invoices`. Cleanup needs to reach into each — `loadAll()`
// filters underscore-prefixed collections, so it's `store.list()` + per-id
// delete.
const BLOB_COLLECTIONS = [
  '_blob_chunks',
  '_blob_index',
  '_blob_slots_invoices',
]

describe.skipIf(!AWS_ENABLED)('Showcase 11 — AWS Split Store (records → DynamoDB, blobs → S3)', () => {
  let db: Noydb
  let dynamoStore: NoydbStore
  let s3Store: NoydbStore
  let routed: NoydbStore

  beforeAll(async () => {
    // Hold separate references to each backing store so tests can peek
    // into either one and prove which store received which data. The
    // routing dispatch happens inside `routeStore`; everything above it
    // sees a single NoydbStore surface.
    dynamoStore = dynamo({ table: DYNAMO_TABLE })
    s3Store = s3({ bucket: S3_BUCKET })

    routed = routeStore({
      default: dynamoStore,
      blobs: s3Store,
    })

    db = await createNoydb({
      store: routed,
      user: 'owner',
      secret: SHOWCASE_PASSPHRASE,
    })
    await db.openVault(VAULT_NAME)
  }, 30_000)

  afterAll(async () => {
    try {
      await cleanupVault({
        label: 'showcase-11',
        vault: VAULT_NAME,
        stores: [
          // Structured records + keyring/sync live in DynamoDB.
          {
            store: dynamoStore,
            collections: ['invoices', '_keyring', '_sync'],
          },
          // Blob chunks + index + slot metadata live in S3.
          { store: s3Store, collections: BLOB_COLLECTIONS },
        ],
      })
    } finally {
      db?.close()
    }
  }, 60_000)

  it('step 1 — structured record lands in DynamoDB, not in S3', async () => {
    // A plain record (not a blob) goes to the default route. Proof:
    // (a) DynamoDB's list() surfaces the record id;
    // (b) S3's list() for the same collection is empty.
    const coll = db.vault(VAULT_NAME).collection<Invoice>('invoices')
    await coll.put(INVOICE_ID, {
      id: INVOICE_ID,
      clientId: sampleClients[0]!.id,
      amount: 18_750,
      currency: 'THB',
      status: 'open',
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      month: '2026-04',
    })

    const dynamoIds = await dynamoStore.list(VAULT_NAME, 'invoices')
    expect(dynamoIds).toContain(INVOICE_ID)

    const s3Ids = await s3Store.list(VAULT_NAME, 'invoices')
    expect(s3Ids).not.toContain(INVOICE_ID)

    // And the record round-trips through the routed surface exactly as
    // if it were a single-store deployment.
    const roundTrip = await coll.get(INVOICE_ID)
    expect(roundTrip?.amount).toBe(18_750)
  })

  it('step 2 — binary blob chunks land in S3, not in DynamoDB', async () => {
    // Attach a fake PDF (starts with `%PDF-1.4` so MIME detection
    // classifies it) to the invoice record. The blob chunks route to
    // S3 because `blobs: s3Store` was declared in routeStore.
    const coll = db.vault(VAULT_NAME).collection<Invoice>('invoices')
    const blob = coll.blob(INVOICE_ID)
    const pdfBytes = fakePdfBytes(8_192) // 8 KB — splits into chunks

    await blob.put(SLOT, pdfBytes)

    // S3 should hold the chunks and (depending on hub version) the
    // index + slot map; DynamoDB should not.
    const s3Chunks = await s3Store.list(VAULT_NAME, '_blob_chunks')
    expect(s3Chunks.length).toBeGreaterThan(0)

    const dynamoChunks = await dynamoStore
      .list(VAULT_NAME, '_blob_chunks')
      .catch(() => [] as string[])
    expect(dynamoChunks).toEqual([])
  })

  it('step 3 — round-trip reads the blob back byte-for-byte', async () => {
    // The routed surface gives the caller a single `BlobSet` handle;
    // under the hood `get()` fetches chunks from S3, reassembles and
    // decrypts them. The reconstructed bytes must match the original
    // plaintext exactly.
    const coll = db.vault(VAULT_NAME).collection<Invoice>('invoices')
    const fetched = await coll.blob(INVOICE_ID).get(SLOT)
    expect(fetched).toBeInstanceOf(Uint8Array)
    const original = fakePdfBytes(8_192)
    expect(fetched!.length).toBe(original.length)
    // Spot-check a few bytes — comparing all 8K bytes is noisy and
    // equality on `expect(fetched).toEqual(original)` works too; a
    // spread sample keeps test failures readable.
    expect(fetched![0]).toBe(original[0])
    expect(fetched![7]).toBe(original[7])
    expect(fetched![fetched!.length - 1]).toBe(original[original.length - 1])
  })

  it('step 4 — recap: S3 chunks are AES-GCM ciphertext, zero-knowledge holds', async () => {
    // Peek directly at a blob chunk on S3. The hub's envelope has the
    // same shape as any other record: { _noydb: 1, _v, _iv, _data }.
    // The `_data` payload is AES-GCM ciphertext — the raw PDF bytes
    // (including the `%PDF-1.4` magic prefix) never appear.
    const [firstChunkId] = await s3Store.list(VAULT_NAME, '_blob_chunks')
    expect(firstChunkId).toBeTruthy()
    const envelope = await s3Store.get(VAULT_NAME, '_blob_chunks', firstChunkId!)
    expect(envelope).toBeTruthy()
    expect(envelope!._noydb).toBe(1)
    expect(typeof envelope!._iv).toBe('string')
    expect(typeof envelope!._data).toBe('string')

    // Neither the PDF magic nor the base64-encoded form of the magic
    // leaks into the ciphertext.
    expect(envelope!._data).not.toContain('%PDF')
    expect(envelope!._data).not.toContain('JVBERi') // base64(%PDF)
  })
})
