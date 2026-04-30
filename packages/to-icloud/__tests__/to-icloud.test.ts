import { describe, expect, it, beforeEach } from 'vitest'
import { BundleVersionConflictError } from '@noy-db/hub'
import { icloud, type ICloudFs } from '../src/index.js'

/**
 * In-memory fake file system with iCloud-style eviction semantics.
 * Each file can be "offloaded" — readFile then returns null, but a
 * `.icloud` stub exists. `triggerDownload` simulates the macOS
 * `brctl download` call bringing the file back.
 */
function mockFs(): ICloudFs & {
  files: Map<string, { bytes: Uint8Array; mtime: number; size: number }>
  stubs: Set<string>
  offload(path: string): void
} {
  const files = new Map<string, { bytes: Uint8Array; mtime: number; size: number }>()
  const stubs = new Set<string>()
  let now = 1_700_000_000_000

  return {
    files, stubs,
    offload(path) {
      files.delete(path)
      stubs.add(`${path}.icloud`)
    },
    async readFile(path) {
      const entry = files.get(path)
      return entry ? entry.bytes : null
    },
    async writeFile(path, data) {
      now += 1
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
      files.set(path, { bytes, mtime: now, size: bytes.length })
    },
    async unlink(path) { files.delete(path) },
    async readdir(path) {
      const prefix = path.endsWith('/') ? path : path + '/'
      const out = new Set<string>()
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        if (!rest.includes('/')) out.add(rest)
      }
      for (const s of stubs) {
        if (!s.startsWith(prefix)) continue
        const rest = s.slice(prefix.length)
        if (!rest.includes('/')) out.add(rest)
      }
      return [...out].sort()
    },
    async stat(path) {
      const entry = files.get(path)
      if (entry) return { mtimeMs: entry.mtime, size: entry.size }
      if (stubs.has(path)) return { mtimeMs: 0, size: 0 } // stub metadata
      return null
    },
    async triggerDownload(stubPath) {
      const target = stubPath.replace(/\.icloud$/, '')
      // Rehydrate with dummy content — in the test we replace it manually
      // below via the returned helper. Here we just clear the stub flag.
      stubs.delete(stubPath)
    },
  }
}

function bytes(s: string): Uint8Array { return new TextEncoder().encode(s) }

describe('@noy-db/to-icloud', () => {
  const dir = '/Users/alice/Library/Mobile Documents/NoyDB'
  let fs: ReturnType<typeof mockFs>

  beforeEach(() => { fs = mockFs() })

  it('kind is "bundle" and name is "icloud"', () => {
    const store = icloud({ folder: dir, fs })
    expect(store.kind).toBe('bundle')
    expect(store.name).toBe('icloud')
  })

  it('readBundle returns null when no bundle exists', async () => {
    const store = icloud({ folder: dir, fs })
    expect(await store.readBundle('acme')).toBeNull()
  })

  it('writeBundle + readBundle round-trip', async () => {
    const store = icloud({ folder: dir, fs })
    const payload = bytes('hello-vault')
    const { version } = await store.writeBundle('acme', payload, null)
    expect(version).toBeTruthy()

    const read = await store.readBundle('acme')
    expect(read).not.toBeNull()
    expect(new TextDecoder().decode(read!.bytes)).toBe('hello-vault')
    expect(read!.version).toBe(version)
  })

  it('writeBundle throws on version mismatch', async () => {
    const store = icloud({ folder: dir, fs })
    await store.writeBundle('acme', bytes('v1'), null)
    await expect(store.writeBundle('acme', bytes('v2'), 'wrong-version'))
      .rejects.toBeInstanceOf(BundleVersionConflictError)
  })

  it('writeBundle raises on detected conflict file', async () => {
    const store = icloud({ folder: dir, fs })
    await store.writeBundle('acme', bytes('v1'), null)

    // Inject a conflict file as iCloud would.
    fs.files.set(`${dir}/acme (conflicted copy 2026-04-23).noydb`, {
      bytes: bytes('rival-v1'), mtime: 1_700_000_500_000, size: 8,
    })
    await expect(store.writeBundle('acme', bytes('v2'), 'stale'))
      .rejects.toBeInstanceOf(BundleVersionConflictError)
  })

  it('deleteBundle is idempotent', async () => {
    const store = icloud({ folder: dir, fs })
    await store.writeBundle('acme', bytes('v1'), null)
    await store.deleteBundle('acme')
    await expect(store.deleteBundle('acme')).resolves.toBeUndefined()
    expect(await store.readBundle('acme')).toBeNull()
  })

  it('listBundles enumerates vault bundles excluding .icloud stubs', async () => {
    const store = icloud({ folder: dir, fs })
    await store.writeBundle('acme', bytes('v1'), null)
    await store.writeBundle('globex', bytes('v1'), null)
    // Offload the acme file — the stub should be filtered out of list.
    fs.offload(`${dir}/acme.noydb`)

    const list = await store.listBundles()
    const ids = list.map(b => b.vaultId).sort()
    expect(ids).toEqual(['globex']) // acme is offloaded, list shouldn't include stubs
  })

  it('custom suffix is honored throughout', async () => {
    const store = icloud({ folder: dir, fs, suffix: '.nvault' })
    await store.writeBundle('acme', bytes('v1'), null)
    expect([...fs.files.keys()]).toEqual([`${dir}/acme.nvault`])
    const list = await store.listBundles()
    expect(list[0]!.vaultId).toBe('acme')
  })
})
