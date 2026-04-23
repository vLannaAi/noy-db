/**
 * Unit + integration tests for @noy-db/cli subcommands.
 *
 * Covers:
 *   - inspect: reads bundle header from a real writeNoydbBundle output
 *   - verify: returns ok for a well-formed bundle, fails for a tampered one
 *   - validateOptions: rejects missing store, bad role, archive-with-pull
 *   - scaffold: emits non-empty code + env for profiles A / B / C / G
 *   - formatSnapshot: produces a single-line-per-method summary
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb, writeNoydbBundle } from '@noy-db/hub'
import { inspect } from '../src/commands/inspect.js'
import { verify } from '../src/commands/verify.js'
import { validateOptions, scaffold, loadOptionsFromFile } from '../src/commands/config.js'
import { formatSnapshot } from '../src/commands/monitor.js'
import type { MeterSnapshot } from '@noy-db/to-meter'

function memoryStore(name = 'memory'): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name,
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        if (cn.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll() { /* noop */ },
    async ping() { return true },
  }
}

describe('inspect — bundle header extraction', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'noydb-cli-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reads formatVersion/handle/bodyBytes/bodySha256 without a passphrase', async () => {
    // Build a real bundle via createNoydb → writeNoydbBundle
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'test-passphrase-12345678',
    })
    const vault = await db.openVault('test-vault')
    const bundleBytes = await writeNoydbBundle(vault, { compression: 'none' })
    const path = join(dir, 'test.noydb')
    await writeFile(path, bundleBytes)

    const header = await inspect(path)
    expect(header.formatVersion).toBeGreaterThan(0)
    expect(header.handle).toMatch(/^[0-9A-Z]{26}$/)   // ULID pattern
    expect(header.bodyBytes).toBeGreaterThan(0)
    expect(header.bodySha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('verify — integrity check', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'noydb-cli-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('returns ok=true for a well-formed bundle', async () => {
    const db = await createNoydb({
      store: memoryStore(), user: 'owner', secret: 'test-passphrase-12345678',
    })
    const vault = await db.openVault('test-vault')
    const bundleBytes = await writeNoydbBundle(vault, { compression: 'none' })
    const path = join(dir, 'ok.noydb')
    await writeFile(path, bundleBytes)

    const report = await verify(path)
    expect(report.ok).toBe(true)
    expect(report.checks.magic).toBe(true)
    expect(report.checks.header).toBe(true)
    expect(report.checks.bodyHash).toBe(true)
  })

  it('returns ok=false for a tampered body', async () => {
    const db = await createNoydb({
      store: memoryStore(), user: 'owner', secret: 'test-passphrase-12345678',
    })
    const vault = await db.openVault('test-vault')
    const bundleBytes = await writeNoydbBundle(vault, { compression: 'none' })

    // Flip a byte deep in the body (past header) to break the SHA
    const tampered = new Uint8Array(bundleBytes)
    tampered[tampered.length - 5]! ^= 0xff

    const path = join(dir, 'bad.noydb')
    await writeFile(path, tampered)

    const report = await verify(path)
    expect(report.ok).toBe(false)
    expect(report.checks.magic).toBe(true)    // magic intact
    expect(report.checks.header).toBe(true)   // header intact
    expect(report.checks.bodyHash).toBe(false) // body hash mismatch caught
  })
})

describe('validateOptions — NoydbOptions sanity check', () => {
  it('errors on missing store', () => {
    const report = validateOptions({ user: 'x', secret: 'y' })
    expect(report.ok).toBe(false)
    expect(report.issues.find(i => i.code === 'missing-store')).toBeDefined()
  })

  it('errors on bad-shape store', () => {
    const report = validateOptions({ store: { get: () => {} }, user: 'x', secret: 'y' })
    expect(report.ok).toBe(false)
    expect(report.issues.find(i => i.code === 'bad-store-shape')).toBeDefined()
  })

  it('accepts a clean options object', () => {
    const report = validateOptions({
      store: memoryStore(),
      user: 'alice',
      secret: 'x'.repeat(20),
    })
    expect(report.ok).toBe(true)
    expect(report.issues.filter(i => i.severity === 'error')).toHaveLength(0)
  })

  it('errors on archive-with-pull-policy', () => {
    const report = validateOptions({
      store: memoryStore(),
      user: 'alice',
      secret: 'x'.repeat(20),
      sync: [{
        store: memoryStore('remote'),
        role: 'archive',
        policy: { pull: { mode: 'interval', intervalMs: 60_000 } },
      }],
    })
    expect(report.ok).toBe(false)
    expect(report.issues.find(i => i.code === 'archive-pull-configured')).toBeDefined()
  })

  it('errors on invalid sync role', () => {
    const report = validateOptions({
      store: memoryStore(),
      user: 'alice',
      secret: 'x'.repeat(20),
      sync: [{ store: memoryStore('x'), role: 'mirror' /* invalid */ }],
    })
    expect(report.ok).toBe(false)
    expect(report.issues.find(i => i.code === 'bad-role')).toBeDefined()
  })

  it('warns on syncPolicy with no sync target', () => {
    const report = validateOptions({
      store: memoryStore(), user: 'a', secret: 'x'.repeat(20),
      syncPolicy: { push: { mode: 'on-change' } },
    })
    const warn = report.issues.find(i => i.code === 'policy-without-sync')
    expect(warn).toBeDefined()
    expect(warn?.severity).toBe('warn')
    expect(report.ok).toBe(true)    // warn only
  })
})

describe('loadOptionsFromFile — TS rejection', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'noydb-cli-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('throws a human-readable error when passed a .ts file', async () => {
    const path = join(dir, 'config.ts')
    await writeFile(path, 'export default {}\n')
    await expect(loadOptionsFromFile(path)).rejects.toThrow(/TypeScript config files/)
  })

  it('loads a real .mjs file with a default export', async () => {
    const path = join(dir, 'config.mjs')
    await writeFile(path, 'export default { user: "alice" }\n')
    const value = await loadOptionsFromFile(path) as { user: string }
    expect(value.user).toBe('alice')
  })
})

describe('scaffold — topology profiles', () => {
  it.each(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const)('profile %s emits code + env', (profile) => {
    const result = scaffold(profile)
    expect(result.profile).toBe(profile)
    expect(result.code).toContain('createNoydb')
    expect(result.code).toContain("from '@noy-db/hub'")
    // Profile J uses per-unlock secret supplied via openVault, so the
    // config-level env file may legitimately be thin. All other profiles
    // carry at least NOYDB_USER/NOYDB_SECRET.
    if (profile !== 'J') expect(result.env).toContain('NOYDB_SECRET')
  })
})

describe('formatSnapshot — monitor output shape', () => {
  it('includes status + per-method summary for methods with traffic', () => {
    const snap: MeterSnapshot = {
      byMethod: {
        get:     { count: 0, errors: 0, p50: 0, p90: 0, p99: 0, max: 0, avg: 0 },
        put:     { count: 5, errors: 1, p50: 10, p90: 40, p99: 50, max: 60, avg: 20 },
        delete:  { count: 0, errors: 0, p50: 0, p90: 0, p99: 0, max: 0, avg: 0 },
        list:    { count: 2, errors: 0, p50: 3, p90: 5, p99: 5, max: 5, avg: 4 },
        loadAll: { count: 0, errors: 0, p50: 0, p90: 0, p99: 0, max: 0, avg: 0 },
        saveAll: { count: 0, errors: 0, p50: 0, p90: 0, p99: 0, max: 0, avg: 0 },
      },
      status: 'ok',
      casConflicts: 0,
      totalCalls: 7,
      windowMs: 3000,
      collectedAt: new Date().toISOString(),
    }
    const out = formatSnapshot(snap)
    expect(out).toContain('status=ok')
    expect(out).toContain('calls=7')
    expect(out).toContain('put')
    expect(out).toContain('p99=50ms')
    expect(out).toContain('list')
    // methods with zero traffic are omitted
    expect(out).not.toMatch(/^\s+get\s/m)
  })
})
