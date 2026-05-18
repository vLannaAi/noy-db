import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createNoydb, withDerivation } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

// Inline file-backed store — same pattern as packages/hub/__tests__/guards/cross-store.test.ts
function fileStore(dir: string): NoydbStore {
  const filePath = (v: string, c: string, i: string) => join(dir, v, c, `${i}.json`)
  return {
    capabilities: { casAtomic: false, auth: { kind: 'none' } },
    async get(v, c, i) {
      try {
        const raw = await readFile(filePath(v, c, i), 'utf8')
        return JSON.parse(raw) as EncryptedEnvelope
      } catch {
        return null
      }
    },
    async put(v, c, i, env) {
      const fp = filePath(v, c, i)
      await mkdir(dirname(fp), { recursive: true })
      await writeFile(fp, JSON.stringify(env))
    },
    async delete(v, c, i) {
      try {
        await rm(filePath(v, c, i))
      } catch { /* idempotent */ }
    },
    async list(v, c) {
      try {
        const entries = await readdir(join(dir, v, c))
        return entries.filter(e => e.endsWith('.json')).map(e => e.slice(0, -5))
      } catch {
        return []
      }
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      try {
        const colls = await readdir(join(dir, v))
        for (const c of colls) {
          const ids = await readdir(join(dir, v, c)).catch(() => [])
          for (const f of ids) {
            if (!f.endsWith('.json')) continue
            const id = f.slice(0, -5)
            const raw = await readFile(join(dir, v, c, f), 'utf8')
            out[c] = out[c] ?? {}
            out[c][id] = JSON.parse(raw)
          }
        }
      } catch { /* empty vault */ }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c])) {
          await this.put(v, c, i, payload[c][i])
        }
      }
    },
  }
}

interface Pdf extends Record<string, unknown> { id: string; body: string }
interface PdfMeta extends Record<string, unknown> { len: number }

describe('Derivation conformance on file-backed store', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noydb-derivations-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('eager derivation survives vault re-open', async () => {
    const strategy = withDerivation<Pdf, { meta: PdfMeta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    })
    const open = () => createNoydb({
      store: fileStore(dir),
      user: 'alice',
      secret: 'derivation-tofile-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const db1 = await open()
    const v1 = await db1.openVault('demo')
    await v1.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hello' })

    const db2 = await open()
    const v2 = await db2.openVault('demo')
    const meta = await v2.collection<PdfMeta>('pdf-meta').get('p1')
    expect(meta?.len).toBe(5)
  })
})
