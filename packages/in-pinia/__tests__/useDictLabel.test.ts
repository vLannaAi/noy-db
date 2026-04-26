import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { withI18n } from '@noy-db/hub/i18n'
import type { Noydb, Vault } from '@noy-db/hub'
import { setActiveNoydb } from '../src/context.js'
import { useDictLabel } from '../src/useDictLabel.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

async function setup(): Promise<{ db: Noydb; vault: Vault }> {
  const db = await createNoydb({
    store: memory(),
    user: 'owner',
    secret: 'pw',
    i18nStrategy: withI18n(),
  })
  const vault = await db.openVault('acme')
  const dict = vault.dictionary('invoiceStatus')
  await dict.put('draft', { en: 'Draft', th: 'ฉบับร่าง' })
  await dict.put('paid', { en: 'Paid', th: 'ชำระแล้ว' })
  setActiveNoydb(db)
  return { db, vault }
}

const tick = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('useDictLabel', () => {
  beforeEach(() => {
    setActiveNoydb(null)
  })

  it('resolves a known key to the requested locale', async () => {
    const { vault } = await setup()
    const label = useDictLabel('invoiceStatus', { vault, locale: 'en' })
    const draft = label('draft')
    for (let i = 0; i < 50 && draft.value !== 'Draft'; i++) await tick(10)
    expect(draft.value).toBe('Draft')
  })

  it('falls back through the chain', async () => {
    const { vault } = await setup()
    const label = useDictLabel('invoiceStatus', { vault, locale: 'fr', fallback: ['en', 'any'] })
    const draft = label('draft')
    for (let i = 0; i < 50 && draft.value !== 'Draft'; i++) await tick(10)
    expect(draft.value).toBe('Draft')
  })

  it('reacts to locale changes', async () => {
    const { vault } = await setup()
    const locale = ref('en')
    const label = useDictLabel('invoiceStatus', { vault, locale, fallback: ['any'] })
    const paid = label('paid')
    // The first resolve is async (decrypts the dict envelope) — poll
    // until it settles instead of awaiting a fixed number of ticks.
    for (let i = 0; i < 50 && paid.value !== 'Paid'; i++) await tick(10)
    expect(paid.value).toBe('Paid')

    locale.value = 'th'
    for (let i = 0; i < 50 && paid.value !== 'ชำระแล้ว'; i++) await tick(10)
    expect(paid.value).toBe('ชำระแล้ว')
  })

  // Dict mutations (via DictionaryHandle.put) don't emit hub-level
  // change events today — the handle writes through the adapter
  // directly, bypassing the Collection wrapper's emitter. Tracked as
  // a v0.22 hub follow-up. Locale changes (the more common reactivity
  // path) work; see "reacts to locale changes" above.

  it('returns the stable key when missing (default onMissing)', async () => {
    const { vault } = await setup()
    const label = useDictLabel('invoiceStatus', { vault, locale: 'en' })
    expect(label('nonexistent').value).toBe('nonexistent')
  })

  it('returns empty string when onMissing: "empty"', async () => {
    const { vault } = await setup()
    const label = useDictLabel('invoiceStatus', {
      vault,
      locale: 'en',
      onMissing: 'empty',
    })
    await tick()
    expect(label('nonexistent').value).toBe('')
  })

  it('returns visible placeholder when onMissing: "placeholder"', async () => {
    const { vault } = await setup()
    const label = useDictLabel('invoiceStatus', {
      vault,
      locale: 'en',
      onMissing: 'placeholder',
    })
    await tick()
    expect(label('nonexistent').value).toBe('⟨missing:nonexistent⟩')
  })

  it('shares the same ref across repeat calls for the same key', async () => {
    const { vault } = await setup()
    const label = useDictLabel('invoiceStatus', { vault, locale: 'en' })
    const a = label('draft')
    const b = label('draft')
    expect(a).toBe(b)
  })

  it('throws a helpful error when no vault is open and none is supplied', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
    setActiveNoydb(db)
    expect(() => useDictLabel('anything')).toThrow(/no open vault/)
  })

  it('resolves vault by name when passed as string', async () => {
    const { vault } = await setup()
    void vault
    const label = useDictLabel('invoiceStatus', { vault: 'acme', locale: 'en' })
    const draft = label('draft')
    for (let i = 0; i < 50 && draft.value !== 'Draft'; i++) await tick(10)
    expect(draft.value).toBe('Draft')
  })
})
