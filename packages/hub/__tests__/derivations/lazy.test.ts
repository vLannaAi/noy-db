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

/**
 * #1258 — a FAILED lazy re-derive must not launder staleness into freshness.
 *
 * `resolveStaleOnRead` consumes the pending flag before reading the source
 * (the recursion fix). On a STRICT failure it throws and the catch restores
 * the flag. On a NON-STRICT failure it warned and continued, so the flag
 * stayed consumed and the record was served as fresh — permanently, because
 * nothing would ever mark it stale again.
 *
 * The decision this issue asked for: restore-and-retry, not serve-stale-but-
 * marked. `strict: false` means "a failed derivation must not break the read",
 * NOT "report the output as current". The record is still served (no throw),
 * the warning still fires, and the flag survives so the next read retries —
 * which is exactly what strict mode already does, minus the throw.
 *
 * The cost is deliberate and worth stating: a permanently-failing non-strict
 * derivation now re-runs on every read of that id instead of once. That is
 * louder and more expensive than silently serving a stale value forever, and
 * it is the trade this project makes everywhere else — a degraded state must
 * not render as a healthy one.
 */
describe('lazy resolve-on-read: a failed non-strict derivation keeps the stale flag (#1258)', () => {
  const makeStrategy = (fail: { now: boolean }, calls: { n: number }) =>
    withDerivation<{ id: string; amount: number }, { out: { id: string; doubled: number } }>({
      source: 'src',
      deterministic: true,
      lifecycle: 'lazy',
      strict: false,
      outputs: { out: { shape: 'record', collection: 'derived' } },
      derive: async (rec) => {
        calls.n += 1
        if (fail.now) throw new Error('derive blew up')
        return { out: { id: rec.id, doubled: rec.amount * 2 } }
      },
    })

  it('retries on the NEXT read after a non-strict failure, and succeeds once the cause clears', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fail = { now: true }
    const calls = { n: 0 }
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'lazy-1258-retry-2026',
      derivationStrategies: [makeStrategy(fail, calls)],
    })
    const v = await db.openVault('demo')
    const src = v.collection<{ id: string; amount: number }>('src')
    const derived = v.collection<{ id: string; doubled: number }>('derived')

    await src.put('r1', { id: 'r1', amount: 5 })

    // First read: derivation throws, non-strict swallows it, read still works.
    await expect(derived.get('r1')).resolves.toBeNull()
    expect(calls.n).toBe(1)

    // The cause clears. A SECOND read must retry — this is the assertion that
    // fails before the fix, because the flag had been consumed and dropped.
    fail.now = false
    const after = await derived.get('r1')
    expect(calls.n).toBe(2)
    expect(after).toMatchObject({ id: 'r1', doubled: 10 })

    // And once it has succeeded, the flag is gone: a third read does not re-derive.
    await derived.get('r1')
    expect(calls.n).toBe(2)

    warn.mockRestore()
    await db.close()
  })

  it('a SUCCESSFUL derivation still clears the flag — the control', async () => {
    const fail = { now: false }
    const calls = { n: 0 }
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'lazy-1258-control-2026',
      derivationStrategies: [makeStrategy(fail, calls)],
    })
    const v = await db.openVault('demo')
    await v.collection<{ id: string; amount: number }>('src').put('r1', { id: 'r1', amount: 5 })
    const derived = v.collection<{ id: string; doubled: number }>('derived')

    expect(await derived.get('r1')).toMatchObject({ id: 'r1', doubled: 10 })
    expect(calls.n).toBe(1)
    await derived.get('r1')
    expect(calls.n).toBe(1)   // not re-derived: the flag was consumed on success
    await db.close()
  })
})
