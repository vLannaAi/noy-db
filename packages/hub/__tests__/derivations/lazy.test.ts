import { describe, it, expect, vi } from 'vitest'
import { createNoydb, withDerivation } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function toMemory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/')
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  }
}

interface Pdf extends Record<string, unknown> { id: string; body: string }
interface PdfText extends Record<string, unknown> { content: string }

describe('Derivation — lazy lifecycle', () => {
  it('does NOT derive on source write', async () => {
    const derive = vi.fn((s: Pdf) => ({ text: { content: s.body.toUpperCase() } }))
    const strategy = withDerivation<Pdf, { text: PdfText }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { text: { shape: 'record', collection: 'pdf-text' } },
      derive,
      lifecycle: 'lazy',
    })
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'derivation-lazy-noderive-secret-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hello' })
    expect(derive).not.toHaveBeenCalled()
  })

  it('derives on first read of the stale output', async () => {
    const derive = vi.fn((s: Pdf) => ({ text: { content: s.body.toUpperCase() } }))
    const strategy = withDerivation<Pdf, { text: PdfText }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { text: { shape: 'record', collection: 'pdf-text' } },
      derive,
      lifecycle: 'lazy',
    })
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'derivation-lazy-onread-secret-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hi' })
    const text = await v.collection<PdfText>('pdf-text').get('p1')
    expect(derive).toHaveBeenCalledTimes(1)
    expect(text?.content).toBe('HI')
  })

  it('does not re-derive on a second read', async () => {
    const derive = vi.fn((s: Pdf) => ({ text: { content: s.body.toUpperCase() } }))
    const strategy = withDerivation<Pdf, { text: PdfText }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { text: { shape: 'record', collection: 'pdf-text' } },
      derive,
      lifecycle: 'lazy',
    })
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'derivation-lazy-twice-secret-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hi' })
    await v.collection<PdfText>('pdf-text').get('p1')
    await v.collection<PdfText>('pdf-text').get('p1')
    expect(derive).toHaveBeenCalledTimes(1)
  })
})
