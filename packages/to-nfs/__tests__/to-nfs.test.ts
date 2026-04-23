import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EncryptedEnvelope } from '@noy-db/hub'
import { nfs, runMountDiagnostics, type MountDetector } from '../src/index.js'

function env(v: number): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date(1700000000000 + v * 1000).toISOString(), _iv: 'a', _data: `ct-${v}`, _by: 'alice' }
}

const cleanDetector: MountDetector = async () => ({ exists: true, fstype: 'nfs4', options: ['rw', 'noac'] })
const nolockDetector: MountDetector = async () => ({ exists: true, fstype: 'nfs4', options: ['rw', 'nolock'] })
const noacMissingDetector: MountDetector = async () => ({ exists: true, fstype: 'nfs4', options: ['rw'] })
const wrongFsDetector: MountDetector = async () => ({ exists: true, fstype: 'ext4', options: ['rw'] })
const missingDetector: MountDetector = async () => ({ exists: false })

describe('runMountDiagnostics', () => {
  it('clean NFSv4 mount produces no risks', async () => {
    const { risks } = await runMountDiagnostics({ mountPath: '/mnt/x', mountDetector: cleanDetector })
    expect(risks).toEqual([])
  })

  it('nolock flag produces a clear risk', async () => {
    const { risks } = await runMountDiagnostics({ mountPath: '/mnt/x', mountDetector: nolockDetector })
    expect(risks.some(r => r.includes('nolock'))).toBe(true)
  })

  it('missing noac produces an advisory risk', async () => {
    const { risks } = await runMountDiagnostics({ mountPath: '/mnt/x', mountDetector: noacMissingDetector })
    expect(risks.some(r => r.includes('noac'))).toBe(true)
  })

  it('non-NFS filesystem produces a risk', async () => {
    const { risks } = await runMountDiagnostics({ mountPath: '/mnt/x', mountDetector: wrongFsDetector })
    expect(risks.some(r => r.includes('ext4'))).toBe(true)
  })

  it('path not in /proc/mounts produces an informative risk', async () => {
    const { risks } = await runMountDiagnostics({ mountPath: '/mnt/x', mountDetector: missingDetector })
    expect(risks.some(r => r.includes('not listed'))).toBe(true)
  })
})

describe('@noy-db/to-nfs — store behavior', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'nfs-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('name is "nfs"', () => {
    const store = nfs({ mountPath: dir, mountDetector: cleanDetector })
    expect(store.name).toBe('nfs')
  })

  it('put + get round-trip works against a clean mount', async () => {
    const store = nfs({ mountPath: dir, mountDetector: cleanDetector })
    await store.put('v1', 'c1', 'r1', env(1))
    expect(await store.get('v1', 'c1', 'r1')).toEqual(env(1))
  })

  it('nolock + onNolock: "warn" prints to console but does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = nfs({ mountPath: dir, mountDetector: nolockDetector, onNolock: 'warn' })
    await store.put('v1', 'c1', 'r1', env(1))
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0]![0]).toMatch(/nolock/)
    warn.mockRestore()
  })

  it('nolock + onNolock: "error" throws', async () => {
    const store = nfs({ mountPath: dir, mountDetector: nolockDetector, onNolock: 'error' })
    await expect(store.put('v1', 'c1', 'r1', env(1))).rejects.toThrow(/nolock/)
  })

  it('diagnostics() surfaces the raw risk list', async () => {
    const store = nfs({ mountPath: dir, mountDetector: noacMissingDetector })
    const report = await store.diagnostics()
    expect(report.risks.length).toBeGreaterThan(0)
  })

  it('list + delete work through the detection layer', async () => {
    const store = nfs({ mountPath: dir, mountDetector: cleanDetector })
    await store.put('v1', 'c1', 'a', env(1))
    await store.put('v1', 'c1', 'b', env(2))
    expect((await store.list('v1', 'c1')).sort()).toEqual(['a', 'b'])
    await store.delete('v1', 'c1', 'a')
    expect(await store.get('v1', 'c1', 'a')).toBeNull()
  })
})
