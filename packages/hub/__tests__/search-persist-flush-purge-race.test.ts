/**
 * #725 — persisted-index flush/purge race. `PersistedIndexStore` debounces a
 * save (encrypt + `adapter.put`) of the `_ftindex` blob; `removePersisted()`
 * (elevate's tier purge, forget's erasure) must never be overtaken by a save
 * that was already in flight when the purge landed — otherwise a purged or
 * forgotten record's derived plaintext resurrects at rest (#721's residual
 * race, both variants named in the issue).
 *
 * Determinism: a gate on the underlying adapter's `put('_ftindex', ...)`
 * blocks the in-flight save right where its real `encryptJsonString` → `put`
 * gap sits, and signals once it has genuinely arrived there. The purge is then
 * run to full completion WHILE the save is still blocked — the worst-case
 * ordering (delete lands, then a stale put resolves after) — before the gate
 * is released, reproducing the exact interleaving the issue describes without
 * any real-time sleep.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withSearch, ConflictError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withI18n } from '../src/via/i18n/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
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
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

/** Wrap a store so a `put` to `_ftindex` blocks on `gate` while `gate` is
 *  armed, and calls `onReached` right before blocking — lets a test know the
 *  in-flight save has genuinely reached its adapter.put boundary. */
function gateFtindexPut(store: NoydbStore, hooks: { gate: () => Promise<void> | null; onReached: () => void }): NoydbStore {
  return {
    ...store,
    async put(v, c, id, env, ev) {
      const g = c === '_ftindex' ? hooks.gate() : null
      if (g) { hooks.onReached(); await g }
      return store.put(v, c, id, env, ev)
    },
  }
}

const SECRET = 'flush-purge-race-secret-725'

describe('#725 elevate() purge cannot be overtaken by an in-flight debounced flush', () => {
  interface Doc { id: string; body: string }

  it('the _ftindex blob stays ABSENT at the adapter once both the in-flight flush and elevate() settle', async () => {
    const base = memoryStore()
    let gate: Promise<void> | null = null
    let reached: (() => void) | null = null
    const store = gateFtindexPut(base, { gate: () => gate, onReached: () => reached?.() })

    const db = await createNoydb({ store, user: 'owner', secret: SECRET, searchStrategy: withSearch(), tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1],
      perRecordKeys: true,
      textIndexes: ['body'],
      textIndexPersist: true,
    })

    await docs.put('e1', { id: 'e1', body: 'topsecret-alpha-bravo' })
    await docs.flushIndex() // initial persist, uninterrupted (gate not yet armed)
    expect(await store.get('v1', '_ftindex', 'docs')).not.toBeNull()

    // Arm the gate and start a SECOND flush without awaiting it — wait until
    // it has genuinely reached the `_ftindex` put before doing anything else.
    let release!: () => void
    gate = new Promise<void>((r) => { release = r })
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const flushPromise = docs.flushIndex()
    await reachedPromise // the flush is now blocked INSIDE the in-flight save

    // elevate() purges to completion WHILE the save is still blocked mid-flight
    // — the worst-case ordering: the purge's delete lands, and only THEN does
    // the stale save's put resolve and (absent the fix) resurrect the blob.
    await docs.elevate('e1', 1)
    expect(await store.get('v1', '_ftindex', 'docs')).toBeNull() // purge landed first

    release() // now let the stale, already-in-flight save's put resolve
    await flushPromise

    expect(await store.get('v1', '_ftindex', 'docs')).toBeNull()
  })
})

describe('#725 forget() erasure cannot be overtaken by an in-flight debounced flush', () => {
  interface Invoice { id: string; buyerId: string; memo: string }

  it('the _ftindex blob stays ABSENT at the adapter once both the in-flight flush and forget() settle', async () => {
    const base = memoryStore()
    let gate: Promise<void> | null = null
    let reached: (() => void) | null = null
    const store = gateFtindexPut(base, { gate: () => gate, onReached: () => reached?.() })

    const db = await createNoydb({
      store,
      user: 'alice',
      secret: SECRET,
      searchStrategy: withSearch(),
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('v1')
    const invoices = vault.collection<Invoice>('invoices', {
      textIndexes: ['memo'],
      textIndexPersist: true,
    })

    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1', memo: 'overdue payment frombuyer1' })
    await invoices.flushIndex() // initial persist, uninterrupted (gate not yet armed)
    expect(await store.get('v1', '_ftindex', 'invoices')).not.toBeNull()

    // Arm the gate and start a SECOND flush without awaiting it — wait until
    // it has genuinely reached the `_ftindex` put before doing anything else.
    let release!: () => void
    gate = new Promise<void>((r) => { release = r })
    const reachedPromise = new Promise<void>((r) => { reached = r })
    const flushPromise = invoices.flushIndex()
    await reachedPromise // the flush is now blocked INSIDE the in-flight save

    // forget() erases to completion WHILE the save is still blocked mid-flight
    // — the worst-case ordering: the erasure's delete lands, and only THEN does
    // the stale save's put resolve and (absent the fix) resurrect the
    // forgotten record's text.
    const result = await vault.forget('buyer-1')
    expect(result.recordsShredded).toBe(1)
    expect(await store.get('v1', '_ftindex', 'invoices')).toBeNull() // erasure landed first

    release() // now let the stale, already-in-flight save's put resolve
    await flushPromise

    expect(await store.get('v1', '_ftindex', 'invoices')).toBeNull()
  })
})
