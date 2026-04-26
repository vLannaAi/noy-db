import { describe, expect, it, beforeEach } from 'vitest'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { smb, type SmbHandle } from '../src/index.js'

function mockSmb(): SmbHandle & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files, dirs,
    async readFile(path) {
      const data = files.get(path)
      return data === undefined ? null : new TextEncoder().encode(data)
    },
    async writeFile(path, data) {
      const text = typeof data === 'string'
        ? data
        : new TextDecoder().decode(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer))
      files.set(path, text)
    },
    async unlink(path) {
      if (!files.has(path)) throw new Error(`unlink: ${path} not found`)
      files.delete(path)
    },
    async mkdir(path) { dirs.add(path) },
    async rename(from, to) {
      const data = files.get(from)
      if (data === undefined) throw new Error(`rename: ${from} not found`)
      files.set(to, data)
      files.delete(from)
    },
    async readdir(path) {
      const prefix = path ? path + '/' : ''
      const out = new Set<string>()
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue
        const rest = f.slice(prefix.length)
        if (!rest) continue
        out.add(rest.split('/')[0]!)
      }
      for (const d of dirs) {
        if (!d.startsWith(prefix) || d === path) continue
        const rest = d.slice(prefix.length)
        if (rest && !rest.includes('/')) out.add(rest)
      }
      if (out.size === 0 && !dirs.has(path) && path !== '') {
        // Return empty, not throw — readdir on non-existent returns no entries
        return []
      }
      return [...out].sort()
    },
    async ping() { return true },
  }
}

function env(v: number): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(), _iv: 'a', _data: `ct-${v}`, _by: 'alice' }
}

describe('@noy-db/to-smb', () => {
  let smbClient: ReturnType<typeof mockSmb>
  let store: ReturnType<typeof smb>
  beforeEach(() => {
    smbClient = mockSmb()
    store = smb({ smb: smbClient })
  })

  it('name defaults to "smb"', () => {
    expect(store.name).toBe('smb')
  })

  it('put + get round-trip', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
  })

  it('get returns null for missing', async () => {
    expect(await store.get('v1', 'c1', 'nope')).toBeNull()
  })

  it('put is atomic — tmp + rename, no half-written target', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    const paths = [...smbClient.files.keys()]
    expect(paths.some(p => p.endsWith('.tmp'))).toBe(false)
  })

  it('put creates the collection directory if missing', async () => {
    await store.put('v1', 'new', 'r1', env(1))
    expect(smbClient.dirs.has('noydb/v1/new')).toBe(true)
  })

  it('list returns sorted record ids', async () => {
    await store.put('v1', 'c1', 'b', env(1))
    await store.put('v1', 'c1', 'a', env(1))
    expect(await store.list('v1', 'c1')).toEqual(['a', 'b'])
  })

  it('list skips tmp files', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    smbClient.files.set('noydb/v1/c1/orphan.json.tmp', '{}')
    expect(await store.list('v1', 'c1')).toEqual(['r1'])
  })

  it('delete is idempotent', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await store.delete('v1', 'c1', 'r1')
    await expect(store.delete('v1', 'c1', 'r1')).resolves.toBeUndefined()
  })

  it('loadAll groups records by collection', async () => {
    await store.put('v1', 'c1', 'r1', env(1))
    await store.put('v1', 'c2', 'r2', env(2))
    const snap = await store.loadAll('v1')
    expect(Object.keys(snap).sort()).toEqual(['c1', 'c2'])
  })

  it('saveAll replaces vault contents', async () => {
    await store.put('v1', 'c1', 'keep', env(1))
    await store.saveAll('v1', { c1: { fresh: env(9) } })
    expect(await store.list('v1', 'c1')).toEqual(['fresh'])
  })

  it('ping returns true for a live share', async () => {
    expect(await store.ping!()).toBe(true)
  })

  it('custom name threads through', () => {
    const s = smb({ smb: mockSmb(), name: 'corp-nas' })
    expect(s.name).toBe('corp-nas')
  })
})
