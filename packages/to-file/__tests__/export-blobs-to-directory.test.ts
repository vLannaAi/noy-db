import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNoydb, PathEscapeError, type Noydb } from '@noy-db/hub'
import { withBlobs } from '@noy-db/hub/blobs'
import { jsonFile, exportBlobsToDirectory } from '../src/index.js'

interface Doc { id: string; title: string }

const SECRET = 'export-blobs-to-directory-test-passphrase-2026'

let workDir: string
let exportDir: string
let db: Noydb

async function makeFixture(): Promise<void> {
  workDir = await mkdtemp(join(tmpdir(), 'noydb-export-'))
  exportDir = join(workDir, 'out')
  const dataDir = join(workDir, 'data')
  // First open: grant export capability via re-grant (matches the
  // existing exportBlobs test fixture in @noy-db/hub).
  const bootstrap = await createNoydb({
    store: jsonFile({ dir: dataDir }),
    user: 'alice',
    secret: SECRET,
    blobStrategy: withBlobs(),
  })
  await bootstrap.openVault('V1')
  await bootstrap.grant('V1', {
    userId: 'alice',
    displayName: 'Alice',
    role: 'owner',
    passphrase: SECRET,
    exportCapability: { plaintext: ['blob'] },
  })
  await bootstrap.close()

  db = await createNoydb({
    store: jsonFile({ dir: dataDir }),
    user: 'alice',
    secret: SECRET,
    blobStrategy: withBlobs(),
  })
  const vault = await db.openVault('V1')
  const docs = vault.collection<Doc>('docs')
  await docs.put('rec-1', { id: 'rec-1', title: 'one' })
  await docs.put('rec-2', { id: 'rec-2', title: 'two' })
  await docs.put('rec-3', { id: 'rec-3', title: 'three' })
  // Use the user-visible filename as the slot name — `slot.filename`
  // defaults to the slot key, so this round-trips through
  // ExportedBlob.meta.filename.
  await docs.blob('rec-1').put(
    'Café Invoice 2026.pdf',
    new TextEncoder().encode('alpha-bytes'),
    { mimeType: 'application/pdf' },
  )
  await docs.blob('rec-2').put(
    'Café Invoice 2026.pdf',
    new TextEncoder().encode('bravo-bytes'),
    { mimeType: 'application/pdf' }, // colliding filename across records
  )
  await docs.blob('rec-3').put(
    'note‮.exe.txt',
    new TextEncoder().encode('charlie-bytes'),
    { mimeType: 'text/plain' }, // bidi-override spoof
  )
}

beforeEach(async () => {
  await makeFixture()
})

afterEach(async () => {
  db.close()
  await rm(workDir, { recursive: true, force: true })
})

describe('exportBlobsToDirectory', () => {
  it('writes every blob to the target dir with sanitized filenames', async () => {
    const vault = await db.openVault('V1')
    const result = await exportBlobsToDirectory(vault, exportDir, {
      filenameProfile: 'macos-smb',
    })
    expect(result.written).toBe(3)
    expect(result.bytes).toBeGreaterThan(0)
    const entries = (await readdir(exportDir)).sort()
    // Three files; the bidi-override is stripped, the colliding name
    // gets a `-1` suffix.
    expect(entries).toHaveLength(3)
    expect(entries.some(e => e.includes('Café Invoice 2026'))).toBe(true)
    expect(entries.some(e => e === 'note.exe.txt')).toBe(true)
  })

  it('suffix collision policy yields stable, non-clobbering names', async () => {
    const vault = await db.openVault('V1')
    const result = await exportBlobsToDirectory(vault, exportDir, {
      filenameProfile: 'macos-smb',
      onCollision: 'suffix',
    })
    const names = result.entries.map(e => e.path.split('/').pop())
    // Both rec-1 and rec-2 sanitize to "Café Invoice 2026.pdf";
    // exactly one keeps the bare name and the other is suffixed.
    const cafeMatches = names.filter(n => n!.startsWith('Café Invoice 2026'))
    expect(cafeMatches).toHaveLength(2)
    expect(cafeMatches).toContain('Café Invoice 2026.pdf')
    expect(cafeMatches).toContain('Café Invoice 2026-1.pdf')
  })

  it('fail collision policy throws on the second blob', async () => {
    const vault = await db.openVault('V1')
    await expect(
      exportBlobsToDirectory(vault, exportDir, {
        filenameProfile: 'macos-smb',
        onCollision: 'fail',
      }),
    ).rejects.toThrow(/collision/)
  })

  it('opaque profile renames to ${blobId}.pdf and writes manifest.json', async () => {
    const vault = await db.openVault('V1')
    const result = await exportBlobsToDirectory(vault, exportDir, {
      filenameProfile: 'opaque',
    })
    expect(result.manifestPath).not.toBeNull()
    expect(result.manifestPath!.endsWith('manifest.json')).toBe(true)

    const manifest = JSON.parse(await readFile(result.manifestPath!, 'utf8')) as {
      format: string
      version: number
      entries: Array<{ opaqueName: string; originalName: string; collection: string; recordId: string }>
    }
    expect(manifest.format).toBe('noydb-opaque-export')
    expect(manifest.entries).toHaveLength(3)
    // Original names round-trip through the manifest, even the bidi-spoof one.
    expect(manifest.entries.map(e => e.originalName).sort()).toEqual([
      'Café Invoice 2026.pdf',
      'Café Invoice 2026.pdf',
      'note‮.exe.txt',
    ].sort())
    // Opaque names are blobId.<ext>, no collision because blobIds differ
    // (rec-1 and rec-2 share content for this test? No — different bytes,
    // so different eTags).
    const opaque = manifest.entries.map(e => e.opaqueName).sort()
    expect(new Set(opaque).size).toBe(3)
    expect(opaque.every(n => /^[0-9a-f]{64}\.(pdf|txt)$/i.test(n))).toBe(true)
  })

  it('PathEscapeError defense-in-depth: tampered profile cannot escape targetDir', async () => {
    // The sanitizer rejects path-traversal segments on its own; this
    // test exercises the defense-in-depth guard by aiming a custom
    // collision callback at "../escape.txt" — a hostile or buggy
    // adopter callback shouldn't be able to break out.
    const vault = await db.openVault('V1')
    await expect(
      exportBlobsToDirectory(vault, exportDir, {
        filenameProfile: 'posix',
        onCollision: () => '../escape.txt',
      }),
    ).rejects.toBeInstanceOf(PathEscapeError)
  })
})
