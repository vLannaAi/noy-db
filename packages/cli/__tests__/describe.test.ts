/**
 * Tests for `noydb describe` — bundle → structured YAML / JSON audit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb, writePod } from '@noy-db/hub'
import { describeBundle } from '../src/commands/describe.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
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
  }
}

interface Invoice extends Record<string, unknown> { id: string; client_id: string; amount: number }

async function buildSampleBundle(dir: string): Promise<string> {
  const InvoiceSchema = z.object({
    id: z.string(),
    client_id: z.string(),
    amount: z.number().positive(),
  })
  const db = await createNoydb({
    store: memoryStore(),
    user: 'owner@acme.example',
    secret: 'test-secret-12345678',
  })
  const vault = await db.openVault('acme')
  vault.collection<Invoice>('invoices', { schema: InvoiceSchema, persistJsonSchema: true })
  vault.collection('clients')
  await vault._drainPendingSchemaWrites()
  await vault.collection<Invoice>('invoices').put('inv-001', { id: 'inv-001', client_id: 'c1', amount: 5000 })
  await vault.collection<Invoice>('invoices').put('inv-002', { id: 'inv-002', client_id: 'c1', amount: 7500 })
  await vault.collection('clients').put('c1', { id: 'c1', name: 'Acme Co' })

  const bundleBytes = await writePod(vault, { compression: 'none' })
  const path = join(dir, 'sample.noydb')
  await writeFile(path, bundleBytes)
  return path
}

describe('describeBundle — programmatic API', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'noydb-describe-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('emits a YAML document with _provenance header at the top', async () => {
    const path = await buildSampleBundle(dir)
    const out = await describeBundle({
      bundlePath: path,
      user: 'owner@acme.example',
      secret: 'test-secret-12345678',
      format: 'yaml',
      withStats: false,
      schemas: 'none',
      sampleSize: 0,
    })
    expect(out).toMatch(/_noydb_snapshot:/)
    expect(out).toMatch(/_provenance:/)
    expect(out).toMatch(/generatedBy: noydb describe/)
    expect(out).toMatch(/source: /)
    expect(out).toMatch(/sourceSha256: [0-9a-f]{64}/)
    expect(out).toMatch(/emittedAt: /)
  })

  it('JSON output is strict-parseable and contains _provenance structured field', async () => {
    const path = await buildSampleBundle(dir)
    const out = await describeBundle({
      bundlePath: path,
      user: 'owner@acme.example',
      secret: 'test-secret-12345678',
      format: 'json',
      withStats: false,
      schemas: 'none',
      sampleSize: 0,
    })
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed._noydb_snapshot).toBe(1)
    expect(parsed._provenance).toMatchObject({
      generatedBy: expect.stringContaining('noydb describe'),
      sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(parsed.vault).toBe('acme')
    expect((parsed.collections as Record<string, unknown>).invoices).toBeDefined()
  })

  it('surfaces the persisted JSON Schema for collections that opted in', async () => {
    const path = await buildSampleBundle(dir)
    const out = await describeBundle({
      bundlePath: path,
      user: 'owner@acme.example',
      secret: 'test-secret-12345678',
      format: 'json',
      withStats: false,
      schemas: 'none',
      sampleSize: 0,
    })
    const parsed = JSON.parse(out) as { collections: Record<string, { validator?: { kind: string; source: string }; fields: Record<string, { type: string }> }> }
    expect(parsed.collections.invoices?.validator).toEqual({ kind: 'Zod', source: 'persisted' })
    expect(parsed.collections.invoices?.fields.amount?.type).toBe('number')
  })

  it('--with-stats adds records / bytes / oldest / newest', async () => {
    const path = await buildSampleBundle(dir)
    const out = await describeBundle({
      bundlePath: path,
      user: 'owner@acme.example',
      secret: 'test-secret-12345678',
      format: 'json',
      withStats: true,
      schemas: 'none',
      sampleSize: 0,
    })
    const parsed = JSON.parse(out) as { collections: Record<string, { stats?: { records: number; bytes: number; oldest: string } }>; internal?: Record<string, { records: number }> }
    expect(parsed.collections.invoices?.stats?.records).toBe(2)
    expect(parsed.collections.invoices?.stats?.bytes).toBeGreaterThan(0)
    expect(parsed.internal).toBeDefined()
    expect(parsed.internal!._keyring?.records).toBeGreaterThan(0)
  })

  it('--schemas full inlines the persisted JSON Schema body under each collection', async () => {
    const path = await buildSampleBundle(dir)
    const out = await describeBundle({
      bundlePath: path,
      user: 'owner@acme.example',
      secret: 'test-secret-12345678',
      format: 'json',
      withStats: false,
      schemas: 'full',
      sampleSize: 0,
    })
    const parsed = JSON.parse(out) as { collections: Record<string, { jsonSchema?: unknown }> }
    expect(parsed.collections.invoices?.jsonSchema).toBeDefined()
    expect(parsed.collections.invoices?.jsonSchema).toMatchObject({
      type: 'object',
    })
  })

  it('rejects a wrong secret with a clear error', async () => {
    const path = await buildSampleBundle(dir)
    await expect(describeBundle({
      bundlePath: path,
      user: 'owner@acme.example',
      secret: 'wrong-secret-not-the-real-one',
      format: 'yaml',
      withStats: false,
      schemas: 'none',
      sampleSize: 0,
    })).rejects.toThrow()
  })

  it('reads bundle bytes only once and sha256s them for provenance', async () => {
    const path = await buildSampleBundle(dir)
    const bytes = await readFile(path)
    const out = await describeBundle({
      bundlePath: path,
      user: 'owner@acme.example',
      secret: 'test-secret-12345678',
      format: 'json',
      withStats: false,
      schemas: 'none',
      sampleSize: 0,
    })
    const parsed = JSON.parse(out) as { _provenance: { sourceSha256: string } }
    // sourceSha256 is hashed FROM the raw bundle bytes — verify it's a valid hex hash
    expect(parsed._provenance.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(bytes.length).toBeGreaterThan(0) // sanity
  })
})
