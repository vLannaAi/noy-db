/**
 * Gate test for the portability capability (S4). The `vault.user.*`
 * export/withdrawal surface (`exportMyAccessibleData`, `unilateralWithdrawal`,
 * `requestWithdrawal`, `listWithdrawalRequests`, `approveWithdrawal`,
 * `rejectWithdrawal`) throws `PortabilityNotEnabledError` unless
 * `portabilityStrategy: withPortability()` is passed to createNoydb; opting in
 * makes them live.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, PortabilityNotEnabledError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withPortability } from '../src/with-audit/portability/index.js'

function makeStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(v: string, c: string) {
    let m = store.get(v); if (!m) { m = new Map(); store.set(v, m) }
    let b = m.get(c); if (!b) { b = new Map(); m.set(c, b) }
    return b
  }
  return {
    name: 'memory',
    async get(v, c, id) { return bucket(v, c).get(id) ?? null },
    async put(v, c, id, env, ev) { const b = bucket(v, c); const ex = b.get(id); if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0); b.set(id, env) },
    async delete(v, c, id) { bucket(v, c).delete(id) },
    async list(v, c) { return [...bucket(v, c).keys()] },
    async loadAll(v) { const m = store.get(v); const s: VaultSnapshot = {}; if (m) for (const [n, c] of m) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of c) r[id] = e; s[n] = r } return s },
    async saveAll(v, data) { for (const [n, recs] of Object.entries(data)) { const b = bucket(v, n); for (const [id, e] of Object.entries(recs)) b.set(id, e) } },
  }
}

describe('portability opt-in gate (S4)', () => {
  it('throws PortabilityNotEnabledError when not opted in', async () => {
    const store = makeStore()
    const owner = await createNoydb({ store, user: 'firm', secret: 'owner-pw-long-enough' })
    const ov = await owner.openVault('acme')
    await ov.collection<{ id: string; total: number }>('invoices').put('i1', { id: 'i1', total: 100 })

    await expect(ov.user.exportMyAccessibleData()).rejects.toThrow(PortabilityNotEnabledError)
    await expect(ov.user.requestWithdrawal({ legalBasis: 'gdpr-art-17' })).rejects.toThrow(PortabilityNotEnabledError)
    await expect(ov.user.listWithdrawalRequests()).rejects.toThrow(PortabilityNotEnabledError)
  })

  it('works when opted in via withPortability()', async () => {
    const store = makeStore()
    const owner = await createNoydb({ store, user: 'firm', secret: 'owner-pw-long-enough', portabilityStrategy: withPortability() })
    const ov = await owner.openVault('acme')
    await ov.collection<{ id: string; total: number }>('invoices').put('i1', { id: 'i1', total: 100 })

    const bytes = await ov.user.exportMyAccessibleData()
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.byteLength).toBeGreaterThan(0)
    const pending = await ov.user.listWithdrawalRequests()
    expect(pending).toEqual([])
  })
})
