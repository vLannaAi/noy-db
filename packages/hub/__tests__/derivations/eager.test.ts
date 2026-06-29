import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

function memory(): NoydbStore {
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
interface PdfMeta extends Record<string, unknown> { len: number; _derivedFrom?: unknown }

describe('Derivation — eager lifecycle', () => {
  it('writes derived outputs immediately after source write', async () => {
    const strategy = withDerivation<Pdf, { meta: PdfMeta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-eager-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hello' })
    const meta = await v.collection<PdfMeta>('pdf-meta').get('p1')
    expect(meta?.len).toBe(5)
    expect((meta as any)?._derivedFrom?.source).toBe('pdfs')
  })

  it('re-derives on source change', async () => {
    const strategy = withDerivation<Pdf, { meta: PdfMeta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-rederive-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hi' })
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'longer text' })
    const meta = await v.collection<PdfMeta>('pdf-meta').get('p1')
    expect(meta?.len).toBe('longer text'.length)
  })

  it('writes multiple outputs', async () => {
    interface Text extends Record<string, unknown> { content: string }
    const strategy = withDerivation<Pdf, { meta: PdfMeta; text: Text }>({
      source: 'pdfs',
      deterministic: true,
      outputs: {
        meta: { shape: 'record', collection: 'pdf-meta' },
        text: { shape: 'record', collection: 'pdf-text' },
      },
      derive: (s) => ({ meta: { len: s.body.length }, text: { content: s.body.toUpperCase() } }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-multi-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hi' })
    const meta = await v.collection<PdfMeta>('pdf-meta').get('p1')
    const text = await v.collection<Text>('pdf-text').get('p1')
    expect(meta?.len).toBe(2)
    expect(text?.content).toBe('HI')
  })
})
