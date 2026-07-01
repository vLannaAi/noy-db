/**
 * #199 P3 — two-party withdrawal ceremony. A read-only client (who cannot
 * self-serve a destructive `unilateralWithdrawal`) files a request; an owner
 * reviews and approves (extract-and-dispose under firm authority) or rejects.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { readNoydbBundle } from '../src/with-pod/bundle.js'
import { WithdrawalRequestError } from '../src/with-audit/portability/request-withdrawal.js'

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

/** Owner vault + a read-only client both open on the same store/vault. */
async function setup(store: NoydbStore, clientMode: 'rw' | 'ro' = 'ro') {
  const owner = await createNoydb({ store, user: 'firm', secret: 'owner-pw-long-enough' })
  const ov = await owner.openVault('acme')
  await ov.collection<{ id: string; total: number }>('invoices').put('i1', { id: 'i1', total: 100 })
  await ov.collection<{ id: string; total: number }>('invoices').put('i2', { id: 'i2', total: 50 })
  await owner.grant('acme', {
    userId: 'client1', displayName: 'Client', role: 'client', passphrase: 'client-pw-long-enough',
    permissions: { invoices: clientMode },
  })
  const client = await createNoydb({ store, user: 'client1', secret: 'client-pw-long-enough' })
  const cv = await client.openVault('acme')
  return { ov, cv }
}

describe('#199 P3 — two-party withdrawal', () => {
  it('a read-only client files a request, the owner approves and the records are deleted under firm authority', async () => {
    const { ov, cv } = await setup(makeStore())

    const { requestId, status } = await cv.user.requestWithdrawal({ legalBasis: 'gdpr-art-17' })
    expect(status).toBe('pending')

    // Owner sees the pending request.
    const pending = await ov.user.listWithdrawalRequests({ status: 'pending' })
    expect(pending.map((r) => r.requestId)).toContain(requestId)
    expect(pending[0]!.requester).toBe('client1')
    expect(pending[0]!.collections).toEqual(['invoices'])

    // Owner approves → bundle handed back + records deleted under owner authority.
    const { bundle, snapshot } = await ov.user.approveWithdrawal(requestId, { reKey: { passphrase: 'client-takeaway' } })
    expect(snapshot).toBeUndefined()
    const dump = JSON.parse((await readNoydbBundle(bundle)).dumpJson) as { collections?: Record<string, unknown> }
    expect(Object.keys(dump.collections ?? {})).toContain('invoices')
    expect(await ov.collection<{ id: string }>('invoices').get('i1')).toBeNull()
    expect(await ov.collection<{ id: string }>('invoices').get('i2')).toBeNull()

    // Request is now approved.
    const approved = await ov.user.listWithdrawalRequests({ status: 'approved' })
    expect(approved.map((r) => r.requestId)).toContain(requestId)
  })

  it('freeze disposition flows end-to-end through the request', async () => {
    const { ov, cv } = await setup(makeStore())
    const { requestId } = await cv.user.requestWithdrawal({ disposition: 'freeze', legalBasis: 'retention' })
    const { snapshot } = await ov.user.approveWithdrawal(requestId, { reKey: { passphrase: 'p' } })
    expect(snapshot).toBeTruthy()
    expect(snapshot!.recordCount).toBe(2)
    expect(snapshot!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await ov.collection<{ id: string }>('invoices').get('i1')).toBeNull()
  })

  it('only an owner/admin can approve or reject', async () => {
    const { cv } = await setup(makeStore())
    const { requestId } = await cv.user.requestWithdrawal({ legalBasis: 'gdpr-art-17' })
    // The client cannot approve its own request.
    await expect(cv.user.approveWithdrawal(requestId)).rejects.toBeInstanceOf(WithdrawalRequestError)
    await expect(cv.user.rejectWithdrawal(requestId)).rejects.toBeInstanceOf(WithdrawalRequestError)
  })

  it('reject leaves the data untouched and marks the request rejected', async () => {
    const { ov, cv } = await setup(makeStore())
    const { requestId } = await cv.user.requestWithdrawal({ legalBasis: 'gdpr-art-17' })
    const rejected = await ov.user.rejectWithdrawal(requestId, { reason: 'incomplete-id-check' })
    expect(rejected.status).toBe('rejected')
    expect(rejected.rejectReason).toBe('incomplete-id-check')
    // Data still present.
    expect(await ov.collection<{ id: string }>('invoices').get('i1')).not.toBeNull()
    // A decided request cannot be approved.
    await expect(ov.user.approveWithdrawal(requestId)).rejects.toBeInstanceOf(WithdrawalRequestError)
  })

  it('a request cannot be approved twice', async () => {
    const { ov, cv } = await setup(makeStore())
    const { requestId } = await cv.user.requestWithdrawal({ legalBasis: 'gdpr-art-17' })
    await ov.user.approveWithdrawal(requestId, { reKey: { passphrase: 'p' } })
    await expect(ov.user.approveWithdrawal(requestId, { reKey: { passphrase: 'p' } }))
      .rejects.toBeInstanceOf(WithdrawalRequestError)
  })

  it('an expired request cannot be approved', async () => {
    const { ov, cv } = await setup(makeStore())
    const { requestId, expiresAt } = await cv.user.requestWithdrawal({ legalBasis: 'gdpr-art-17', expiresInMs: -1 })
    expect(expiresAt).toBeTruthy() // already in the past
    await expect(ov.user.approveWithdrawal(requestId)).rejects.toThrow(/expired/)
  })
})
