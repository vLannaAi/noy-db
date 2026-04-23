/**
 * Integration tests for @noy-db/as-zip.
 *
 * Covers:
 *   - happy path: owner with zip grant → archive with manifest + records + attachments
 *   - auth refusal: owner without grant → ExportCapabilityError
 *   - auth refusal: operator without grant → ExportCapabilityError
 *   - slot filtering: ['raw'] excludes other slots; [] excludes all blobs
 *   - filter: record predicate narrows the records.json output
 *   - write() refuses without acknowledgeRisks
 *   - write() round-trips bytes to disk; extractable contents match sources
 */
import { describe, expect, it } from 'vitest'
import { ExportCapabilityError, createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { toBytes, write, type ArchiveManifest } from '../src/index.js'

interface Invoice { id: string; client: string; amount: number; status: string }

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function seedVault() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  const vault = await db.openVault('acme')
  const invoices = vault.collection<Invoice>('invoices')
  await invoices.put('inv-1', { id: 'inv-1', client: 'Globex', amount: 1500, status: 'paid' })
  await invoices.put('inv-2', { id: 'inv-2', client: 'Acme Inc.', amount: 2400, status: 'draft' })
  await invoices.put('inv-3', { id: 'inv-3', client: 'Stark', amount: 999, status: 'overdue' })
  await invoices.blob('inv-1').put('raw', PDF, { mimeType: 'application/pdf', compress: false })
  await invoices.blob('inv-1').put('thumb', PNG, { mimeType: 'image/png', compress: false })
  await invoices.blob('inv-2').put('raw', PDF, { mimeType: 'application/pdf', compress: false })
  return { db, adapter }
}

async function grantExport(adapter: ReturnType<typeof memory>) {
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  await db.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    passphrase: 'owner-pass',
    exportCapability: { plaintext: ['zip'] },
  })
  await db.close()
}

function openExporter(adapter: ReturnType<typeof memory>) {
  return createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
}

// Locate the central directory in an archive we just built and pull
// the list of stored paths out so tests can assert on the layout.
function listZipPaths(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdOffset = bytes.length - 22
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  const recordCount = view.getUint16(eocdOffset + 10, true)

  const out: string[] = []
  let pos = cdOffset
  for (let i = 0; i < recordCount; i++) {
    // 0x02014b50 signature check
    expect(view.getUint32(pos, true)).toBe(0x02014b50)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    out.push(name)
    pos += 46 + nameLen + extraLen + commentLen
  }
  return out
}

// Read one file's stored bytes back out of the archive (STORE method — no decompression).
function readZipFile(bytes: Uint8Array, path: string): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdOffset = bytes.length - 22
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  const recordCount = view.getUint16(eocdOffset + 10, true)

  let pos = cdOffset
  for (let i = 0; i < recordCount; i++) {
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const lfhOffset = view.getUint32(pos + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    if (name === path) {
      const lfhNameLen = view.getUint16(lfhOffset + 26, true)
      const lfhExtraLen = view.getUint16(lfhOffset + 28, true)
      const compressedSize = view.getUint32(lfhOffset + 18, true)
      const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen
      return bytes.subarray(dataStart, dataStart + compressedSize)
    }
    pos += 46 + nameLen + extraLen + commentLen
  }
  return null
}

describe('happy path', () => {
  it('owner with zip grant produces archive with manifest + records + attachments', async () => {
    const { adapter } = await seedVault()
    await grantExport(adapter)

    const db = await openExporter(adapter)
    const vault = await db.openVault('acme')
    const bytes = await toBytes(vault, { records: { collection: 'invoices' } })

    const paths = listZipPaths(bytes).sort()
    expect(paths).toContain('manifest.json')
    expect(paths).toContain('records.json')
    expect(paths).toContain('attachments/inv-1/raw')
    expect(paths).toContain('attachments/inv-1/thumb')
    expect(paths).toContain('attachments/inv-2/raw')
    // inv-3 has no blobs — no attachments entry for it.
    expect(paths.filter((p) => p.startsWith('attachments/inv-3/'))).toHaveLength(0)

    // Manifest content check.
    const manifestBytes = readZipFile(bytes, 'manifest.json')!
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ArchiveManifest
    expect(manifest._noydb_archive).toBe(1)
    expect(manifest.collection).toBe('invoices')
    expect(manifest.recordCount).toBe(3)
    expect(manifest.attachmentCount).toBe(3)
    const inv1 = manifest.records.find((r) => r.id === 'inv-1')!
    expect(inv1.attachments).toHaveLength(2)

    // Records content.
    const recordsBytes = readZipFile(bytes, 'records.json')!
    const records = JSON.parse(new TextDecoder().decode(recordsBytes)) as Array<Record<string, unknown>>
    expect(records).toHaveLength(3)
    expect(records.find((r) => r._id === 'inv-1')?.client).toBe('Globex')

    // Blob round-trip — the zip stored the raw bytes STORED, so
    // extracting them should give back the exact PDF/PNG buffers.
    const rawBytes = readZipFile(bytes, 'attachments/inv-1/raw')!
    expect(rawBytes).toEqual(PDF)
    const thumbBytes = readZipFile(bytes, 'attachments/inv-1/thumb')!
    expect(thumbBytes).toEqual(PNG)

    await db.close()
  })
})

describe('selection options', () => {
  it('filter narrows records', async () => {
    const { adapter } = await seedVault()
    await grantExport(adapter)

    const db = await openExporter(adapter)
    const vault = await db.openVault('acme')
    const bytes = await toBytes(vault, {
      records: {
        collection: 'invoices',
        filter: (r) => (r as Invoice).status === 'paid',
      },
    })

    const manifestBytes = readZipFile(bytes, 'manifest.json')!
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ArchiveManifest
    expect(manifest.recordCount).toBe(1)
    expect(manifest.records[0]?.id).toBe('inv-1')
    await db.close()
  })

  it('slot selection ["raw"] excludes other slots', async () => {
    const { adapter } = await seedVault()
    await grantExport(adapter)

    const db = await openExporter(adapter)
    const vault = await db.openVault('acme')
    const bytes = await toBytes(vault, {
      records: { collection: 'invoices' },
      attachments: { slots: ['raw'] },
    })
    const paths = listZipPaths(bytes)
    expect(paths.some((p) => p.endsWith('/raw'))).toBe(true)
    expect(paths.some((p) => p.endsWith('/thumb'))).toBe(false)
    await db.close()
  })

  it('empty slots array excludes all blobs', async () => {
    const { adapter } = await seedVault()
    await grantExport(adapter)

    const db = await openExporter(adapter)
    const vault = await db.openVault('acme')
    const bytes = await toBytes(vault, {
      records: { collection: 'invoices' },
      attachments: { slots: [] },
    })
    const paths = listZipPaths(bytes)
    expect(paths.filter((p) => p.startsWith('attachments/'))).toHaveLength(0)
    // Records + manifest still present.
    expect(paths).toContain('manifest.json')
    expect(paths).toContain('records.json')
    await db.close()
  })
})

describe('authorisation refusals', () => {
  it('owner without zip grant is refused', async () => {
    const { db } = await seedVault()
    const vault = await db.openVault('acme')
    await expect(toBytes(vault, { records: { collection: 'invoices' } })).rejects.toThrow(
      ExportCapabilityError,
    )
    await db.close()
  })

  it('operator without zip grant is refused even with read ACL', async () => {
    const { db, adapter } = await seedVault()
    await db.grant('acme', {
      userId: 'op', displayName: 'Op', role: 'operator',
      passphrase: 'op-pass',
      permissions: { invoices: 'rw' },
    })
    await db.close()

    const opDb = await createNoydb({ store: adapter, user: 'op', secret: 'op-pass' })
    const vault = await opDb.openVault('acme')
    await expect(toBytes(vault, { records: { collection: 'invoices' } })).rejects.toThrow(
      ExportCapabilityError,
    )
    await opDb.close()
  })
})

describe('write() — Node file output', () => {
  it('refuses without acknowledgeRisks', async () => {
    const { adapter } = await seedVault()
    await grantExport(adapter)

    const db = await openExporter(adapter)
    const vault = await db.openVault('acme')
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      write(vault, '/tmp/x.zip', { records: { collection: 'invoices' } } as any),
    ).rejects.toThrow(/acknowledgeRisks/)
    await db.close()
  })

  it('persists the archive to disk when acknowledged', async () => {
    const { adapter } = await seedVault()
    await grantExport(adapter)

    const db = await openExporter(adapter)
    const vault = await db.openVault('acme')

    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await mkdtemp(path.join(os.tmpdir(), 'noy-db-as-zip-'))
    const out = path.join(dir, 'invoices.zip')
    try {
      await write(vault, out, {
        records: { collection: 'invoices' },
        acknowledgeRisks: true,
      })
      const disk = new Uint8Array(await readFile(out))
      // PK magic on disk.
      expect(disk[0]).toBe(0x50)
      expect(disk[1]).toBe(0x4b)
      // Round-trip read confirms the archive is intact.
      const paths = listZipPaths(disk)
      expect(paths).toContain('manifest.json')
      expect(paths).toContain('records.json')
    } finally {
      await rm(dir, { recursive: true, force: true })
      await db.close()
    }
  })
})
