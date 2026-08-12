/**
 * Tests for the @noy-db/file pod helpers — savePod / loadPod.
 *
 * v0.6. These wrap the core writePod / readPod
 * primitives with path-based filesystem I/O — the tests focus on the
 * filesystem behavior (path resolution, parent dir creation, atomic
 * write/read round-trip on a real temp directory) and on confirming
 * that the wrappers don't introduce any new format quirks beyond
 * what the core primitives do.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNoydb, type Noydb, PodIntegrityError, hasNoydbPodMagic } from '@noy-db/hub'
import { toFile, savePod, loadPod } from '../src/index.js'

let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'noydb-bundle-test-'))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

interface Invoice {
  id: string
  amount: number
  status: 'open' | 'paid'
}

async function makeDb(dataDir?: string): Promise<Noydb> {
  return createNoydb({
    store: toFile({ dir: dataDir ?? join(testDir, 'data') }),
    user: 'owner',
    secret: 'bundle-file-test-secret-2026',
  })
}

describe('@noy-db/file > savePod / loadPod round-trip', () => {
  it('writes a `.noydb` file with the magic prefix and reads it back', async () => {
    const db = await makeDb()
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open' })
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'paid' })

    const handle = await c.getPodHandle()
    const bundlePath = join(testDir, `${handle}.noydb`)

    await savePod(bundlePath, c)
    // File exists and starts with the bundle magic.
    const bytes = await readFile(bundlePath)
    expect(hasNoydbPodMagic(bytes)).toBe(true)
    expect(bytes.length).toBeGreaterThan(10)

    const result = await loadPod(bundlePath)
    expect(result.header.handle).toBe(handle)
    const parsed = JSON.parse(result.dumpJson) as {
      _compartment: string
      collections: Record<string, Record<string, unknown>>
    }
    expect(parsed._compartment).toBe('TEST')
    expect(Object.keys(parsed.collections['invoices']!)).toEqual(['inv-1', 'inv-2'])
  })

  it('creates intermediate parent directories', async () => {
    const db = await makeDb()
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open' })

    // Path with two levels of directories that don't exist yet.
    const bundlePath = join(testDir, 'nested', 'path', 'bundle.noydb')
    await savePod(bundlePath, c)

    const stats = await stat(bundlePath)
    expect(stats.isFile()).toBe(true)
    expect(stats.size).toBeGreaterThan(10)
  })

  it('overwrites an existing file at the same path', async () => {
    const db = await makeDb()
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open' })

    const bundlePath = join(testDir, 'bundle.noydb')
    await savePod(bundlePath, c)
    const sizeBefore = (await stat(bundlePath)).size

    // Add more records and re-save.
    for (let i = 2; i <= 50; i++) {
      await invoices.put(`inv-${i}`, { id: `inv-${i}`, amount: i * 10, status: 'open' })
    }
    await savePod(bundlePath, c)
    const sizeAfter = (await stat(bundlePath)).size

    // Bundle grew because we added 49 more records.
    expect(sizeAfter).toBeGreaterThan(sizeBefore)
    // The handle is stable across re-saves.
    const result = await loadPod(bundlePath)
    const parsed = JSON.parse(result.dumpJson) as {
      collections: Record<string, Record<string, unknown>>
    }
    expect(Object.keys(parsed.collections['invoices']!)).toHaveLength(50)
  })

  it('honors compression option (gzip vs auto)', async () => {
    const db = await makeDb()
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open' })

    const gzipPath = join(testDir, 'bundle-gzip.noydb')
    await savePod(gzipPath, c, { compression: 'gzip' })
    const gzipBytes = await readFile(gzipPath)
    expect(gzipBytes[5]).toBe(1) // COMPRESSION_GZIP

    // loadPod handles either format byte transparently.
    const result = await loadPod(gzipPath)
    expect(result.header.formatVersion).toBe(1)
  })
})

describe('@noy-db/file > loadPod integrity verification', () => {
  it('throws PodIntegrityError on a tampered bundle file', async () => {
    const db = await makeDb()
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open' })

    const bundlePath = join(testDir, 'bundle.noydb')
    await savePod(bundlePath, c)

    // Read, flip a body byte, write back.
    const bytes = new Uint8Array(await readFile(bundlePath))
    // Flip a byte well into the body region (past the 10-byte
    // prefix and the JSON header).
    const flipOffset = bytes.length - 5
    bytes[flipOffset] = (bytes[flipOffset] ?? 0) ^ 0xff
    await writeFile(bundlePath, bytes)

    let threw: unknown = null
    try {
      await loadPod(bundlePath)
    } catch (err) {
      threw = err
    }
    expect(threw).toBeInstanceOf(PodIntegrityError)
  })
})

describe('@noy-db/file > handle stability across separate noydb sessions', () => {
  it('the same vault on the same data dir produces the same handle', async () => {
    const dataDir = join(testDir, 'shared-data')

    const db1 = await makeDb(dataDir)
    const c1 = await db1.openVault('TEST')
    const handle1 = await c1.getPodHandle()

    // Fresh noydb instance over the same data directory — the
    // _meta/handle envelope persists on disk and is visible to
    // the new instance.
    const db2 = await makeDb(dataDir)
    const c2 = await db2.openVault('TEST')
    const handle2 = await c2.getPodHandle()

    expect(handle2).toBe(handle1)
  })
})

