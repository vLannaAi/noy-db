/**
 * #285 smart-substitute — nearest-script fallback. When onMissing:'substitute'
 * + smartSubstitute and the explicit chain misses, pick the available locale
 * whose primary script is nearest the target (same script, then Latin) instead
 * of an arbitrary first-non-empty value.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { ConflictError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { resolveI18nText, i18nText } from '../src/with-shape/i18n/core.js'
import { withI18n } from '../src/with-shape/i18n/index.js'

// insertion order th, en, ar — so a naive first-non-empty picks 'th'
const VALUE = { th: 'สวัสดี', en: 'Hello', ar: 'مرحبا' }

describe('#285 smart-substitute — resolveI18nText logic', () => {
  it('prefers the same-script locale over first-non-empty', () => {
    // target 'fa' is Arabic script → smart picks ar (same script), not th (first)
    expect(resolveI18nText(VALUE, 'fa', undefined, 'x', { policy: 'substitute', smartSubstitute: true })).toBe(VALUE.ar)
  })

  it('contrast: substitute:["any"] picks the arbitrary first-non-empty (th)', () => {
    expect(resolveI18nText(VALUE, 'fa', undefined, 'x', { policy: 'substitute', substitute: ['any'] })).toBe('สวัสดี')
  })

  it('falls back to Latin (readable) when no same-script locale is available', () => {
    // value has Thai + Latin only; target 'fa' (Arabic) → no Arabic → Latin beats Thai
    const v = { th: 'สวัสดี', en: 'Hello' }
    expect(resolveI18nText(v, 'fa', undefined, 'x', { policy: 'substitute', smartSubstitute: true })).toBe('Hello')
  })

  it('returns null when nothing is available (still under substitute policy)', () => {
    expect(resolveI18nText({}, 'fa', undefined, 'x', { policy: 'substitute', smartSubstitute: true })).toBeNull()
  })
})

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) {
        const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r
      }
      return s
    },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

interface Doc extends Record<string, unknown> { id: string; title: Record<string, string> }

describe('#285 smart-substitute — on a collection read', () => {
  it('threads descriptor.smartSubstitute through get() at a missing locale', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'smart-sub-pass-2026', i18nStrategy: withI18n() })
    const vault = await db.openVault('v')
    const docs = vault.collection<Doc>('docs', {
      i18nFields: { title: i18nText({ languages: ['th', 'en', 'ar', 'fa'], required: 'any', onMissing: 'substitute', smartSubstitute: true }) },
    })
    await docs.put('d1', { id: 'd1', title: { th: 'สวัสดี', en: 'Hello', ar: 'مرحبا' } })
    // read at 'fa' (Arabic, absent) → smart picks the Arabic-script ar value
    expect((await docs.get('d1', { locale: 'fa' }))?.title).toBe('مرحبا')
  })
})
