/**
 * #650 Task 1 — via-lookup extraction behavior lock.
 *
 * The dict registry/handle block moved out of `kernel/vault.ts` into
 * `via/lookup/{handle,registry,active}.ts` + the new
 * `port/with/lookup-strategy.ts` seam (byte-parity — the existing dict
 * suites are the primary lock; this file additionally pins that
 * `LookupHandle` — the renamed `DictionaryHandle` — is importable from its
 * new home and that `vault.dictionary()` still round-trips through it with
 * the same change-event shape `dict-emitter.test.ts` pins.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { LookupHandle } from '../../src/via/lookup/handle.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ChangeEvent } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'

function toMemory(): NoydbStore {
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

describe('#650 Task 1 — LookupHandle importable from its new home', () => {
  it('vault.dictionary() returns a LookupHandle instance', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'owner', i18nStrategy: withI18n(), secret: 'pw' })
    const vault = await db.openVault('acme')
    const handle = vault.dictionary('status')
    expect(handle).toBeInstanceOf(LookupHandle)
  })
})

describe('#650 Task 1 — vault.dictionary() round-trip parity', () => {
  it('put/get/list/rename/delete still round-trip after the extraction', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'owner', i18nStrategy: withI18n(), secret: 'pw' })
    const vault = await db.openVault('acme')
    const dict = vault.dictionary('status')

    await dict.put('draft', { en: 'Draft', th: 'ฉบับร่าง' })
    await dict.put('paid', { en: 'Paid', th: 'ชำระแล้ว' })

    expect(await dict.get('draft')).toEqual({ en: 'Draft', th: 'ฉบับร่าง' })

    const listed = await dict.list()
    expect(listed.map((e) => e.key).sort()).toEqual(['draft', 'paid'])

    await dict.rename('draft', 'open')
    expect(await dict.get('open')).toEqual({ en: 'Draft', th: 'ฉบับร่าง' })
    expect(await dict.get('draft')).toBeNull()

    await dict.delete('open', { mode: 'warn' })
    expect(await dict.get('open')).toBeNull()
    expect((await dict.list()).map((e) => e.key)).toEqual(['paid'])
  })

  it('emits the dict-emitter.test.ts event shape { vault, collection, id, action }', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'owner', i18nStrategy: withI18n(), secret: 'pw' })
    const vault = await db.openVault('acme')
    const events: ChangeEvent[] = []
    db.on('change', (e) => events.push(e))

    await vault.dictionary('status').put('paid', { en: 'Paid' })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ vault: 'acme', collection: '_dict_status', id: 'paid', action: 'put' })
  })
})
