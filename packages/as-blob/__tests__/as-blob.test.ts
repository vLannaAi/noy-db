/**
 * Integration tests for @noy-db/as-blob.
 *
 * Covers:
 *   - happy path: owner with plaintext blob grant → bytes + mime + filename
 *   - default slot 'raw' picked when omitted
 *   - explicit slot override
 *   - custom filename on download()
 *   - authorization refusal: owner without grant → ExportCapabilityError
 *   - authorization refusal: operator without grant → ExportCapabilityError
 *   - unknown record / slot → AsBlobNotFoundError
 *   - acknowledgeRisks refusal on write()
 *   - write() persists bytes byte-for-byte
 */
import { describe, expect, it } from 'vitest'
import { ExportCapabilityError, createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { toBytes, download, write, AsBlobNotFoundError } from '../src/index.js'

interface Invoice { client: string; amount: number }

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function seedVault() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  const vault = await db.openVault('acme')
  const invoices = vault.collection<Invoice>('invoices')
  await invoices.put('inv-1', { client: 'Globex', amount: 1500 })
  // BlobSet.put stores `filename: slotName` — the slot name IS the
  // filename from the hub's POV (current v0.12 contract). Callers
  // override the display name at download time via the `filename`
  // option on `download()` (as-blob respects that override).
  await invoices
    .blob('inv-1')
    .put('raw', PDF_BYTES, { mimeType: 'application/pdf', compress: false })
  await invoices
    .blob('inv-1')
    .put('thumb', PNG_BYTES, { mimeType: 'image/png', compress: false })
  return { db, adapter }
}

describe('happy path', () => {
  it('owner with plaintext blob grant gets bytes + mime + filename', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['blob'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')
    const result = await toBytes(vault, { collection: 'invoices', id: 'inv-1' })
    expect(result.mime).toBe('application/pdf')
    // BlobSet stores filename == slotName in v0.12. Callers override
    // at download() time — see the download test below.
    expect(result.filename).toBe('raw')
    expect(result.bytes).toEqual(PDF_BYTES)
    await db2.close()
  })

  it('defaults to slot "raw" when omitted', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['blob'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')
    const fromDefault = await toBytes(vault, { collection: 'invoices', id: 'inv-1' })
    const fromExplicit = await toBytes(vault, { collection: 'invoices', id: 'inv-1', slot: 'raw' })
    expect(fromDefault.bytes).toEqual(fromExplicit.bytes)
    await db2.close()
  })

  it('returns a different slot when explicitly named', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['blob'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')
    const thumb = await toBytes(vault, { collection: 'invoices', id: 'inv-1', slot: 'thumb' })
    expect(thumb.mime).toBe('image/png')
    expect(thumb.filename).toBe('thumb')
    expect(thumb.bytes).toEqual(PNG_BYTES)
    await db2.close()
  })
})

describe('authorization refusals', () => {
  it('owner without blob grant is refused', async () => {
    const { db } = await seedVault()
    const vault = await db.openVault('acme')
    // Default owner has no plaintext grant.
    await expect(toBytes(vault, { collection: 'invoices', id: 'inv-1' })).rejects.toThrow(
      ExportCapabilityError,
    )
    await db.close()
  })

  it('operator without blob grant is refused even with read ACL', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'op', displayName: 'Op', role: 'operator',
      passphrase: 'op-pass',
      permissions: { invoices: 'rw' },
    })
    await db.close()

    const opDb = await createNoydb({ store: adapter, user: 'op', secret: 'op-pass' })
    const vault = await opDb.openVault('acme')
    await expect(toBytes(vault, { collection: 'invoices', id: 'inv-1' })).rejects.toThrow(
      ExportCapabilityError,
    )
    await opDb.close()
  })
})

describe('not-found cases', () => {
  it('unknown record throws AsBlobNotFoundError', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['blob'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')
    await expect(
      toBytes(vault, { collection: 'invoices', id: 'missing' }),
    ).rejects.toBeInstanceOf(AsBlobNotFoundError)
    await db2.close()
  })

  it('unknown slot throws AsBlobNotFoundError with actionable message', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['blob'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')
    try {
      await toBytes(vault, { collection: 'invoices', id: 'inv-1', slot: 'not-a-slot' })
    } catch (err) {
      expect(err).toBeInstanceOf(AsBlobNotFoundError)
      const e = err as AsBlobNotFoundError
      expect(e.collection).toBe('invoices')
      expect(e.id).toBe('inv-1')
      expect(e.slot).toBe('not-a-slot')
    }
    await db2.close()
  })
})

describe('write() — Node file output', () => {
  it('refuses without acknowledgeRisks', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['blob'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      write(vault, '/tmp/x.pdf', { collection: 'invoices', id: 'inv-1' } as any),
    ).rejects.toThrow(/acknowledgeRisks/)
    await db2.close()
  })

  it('writes bytes byte-for-byte to disk when acknowledged', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['blob'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')

    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'noy-db-as-blob-'))
    const outPath = path.join(dir, 'scan.pdf')
    try {
      await write(vault, outPath, {
        collection: 'invoices',
        id: 'inv-1',
        acknowledgeRisks: true,
      })
      const disk = await readFile(outPath)
      expect(new Uint8Array(disk)).toEqual(PDF_BYTES)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await db2.close()
    }
  })
})

describe('download() — browser happy path', () => {
  it('resolves in a happy-dom environment with a custom filename', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'owner-01', displayName: 'Owner', role: 'owner',
      passphrase: 'owner-pass',
      exportCapability: { plaintext: ['blob'] },
    })
    await db.close()

    const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const vault = await db2.openVault('acme')

    // Stub URL.createObjectURL / revokeObjectURL — happy-dom doesn't
    // ship them by default. The click on `<a>` is a no-op here —
    // happy-dom creates the element, we just need the call to
    // complete without throwing.
    const originalCreate = (URL as unknown as { createObjectURL?: unknown }).createObjectURL
    const originalRevoke = (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(URL as any).createObjectURL = () => 'blob:stub-url'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(URL as any).revokeObjectURL = () => {}
    try {
      await download(vault, {
        collection: 'invoices',
        id: 'inv-1',
        filename: 'renamed.pdf',
      })
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(URL as any).createObjectURL = originalCreate
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(URL as any).revokeObjectURL = originalRevoke
      await db2.close()
    }
  })
})
