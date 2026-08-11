/**
 * #199 P2 — vault.user.unilateralWithdrawal(): a non-owner extracts their scope
 * AND disposes of the source (delete | freeze). Gated by the default-off
 * fail-closed built-in `client-unilateral-withdraw` policy.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { PolicyDeniedError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withPortability } from '../src/with-audit/portability/index.js'
import type { VaultPolicy } from '../src/kernel/types.js'
import { readPod } from '../src/with-pod/bundle.js'
import { withTeam } from '../src/with-party/team/index.js'

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

const GATE_ON = { gates: { 'client-unilateral-withdraw': { enabled: true, minTier: 1 } } } as const satisfies VaultPolicy

/** Owner-provisioned vault with one member granted `mode` on `invoices`. */
async function setup(store: NoydbStore, role: 'operator' | 'client', mode: 'rw' | 'ro', policy?: VaultPolicy) {
  const base = { store, user: 'firm', secret: 'owner-pw-long-enough', teamStrategy: withTeam() }
  const owner = await createNoydb(policy ? { ...base, policy } : base)
  const ov = await owner.openVault('acme')
  await ov.collection<{ id: string; total: number }>('invoices').put('i1', { id: 'i1', total: 100 })
  await ov.collection<{ id: string; total: number }>('invoices').put('i2', { id: 'i2', total: 50 })
  await owner.grant('acme', {
    userId: 'member1', displayName: 'Member', role, secret: 'member-pw-long-enough',
    permissions: { invoices: mode },
  })
  owner.close()
  const member = await createNoydb({ teamStrategy: withTeam(), store, user: 'member1', secret: 'member-pw-long-enough', portabilityStrategy: withPortability() })
  const cv = await member.openVault('acme')
  return { cv }
}

describe('#199 P2 — unilateralWithdrawal', () => {
  it('fails closed when the gate is disabled (default)', async () => {
    const { cv } = await setup(makeStore(), 'operator', 'rw') // no policy → gate fail-closed
    await expect(
      cv.user.unilateralWithdrawal({ legalBasis: 'gdpr-art-17', reKey: { secret: 'new-pw' } }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  it('read-only role cannot self-serve a withdrawal (use requestWithdrawal)', async () => {
    const { cv } = await setup(makeStore(), 'client', 'ro', GATE_ON)
    await expect(
      cv.user.unilateralWithdrawal({ legalBasis: 'gdpr-art-17', reKey: { secret: 'new-pw' } }),
    ).rejects.toThrow(/read-only|requestWithdrawal/)
  })

  it('delete disposition: exports the re-keyed copy + removes the live records', async () => {
    const { cv } = await setup(makeStore(), 'operator', 'rw', GATE_ON)
    const res = await cv.user.unilateralWithdrawal({ disposition: 'delete', legalBasis: 'gdpr-art-17', reKey: { secret: 'new-pw' } })
    expect(res.snapshot).toBeUndefined()
    // portable copy contains invoices
    const dump = JSON.parse((await readPod(res.bundle)).dumpJson) as { collections?: Record<string, unknown> }
    expect(Object.keys(dump.collections ?? {})).toContain('invoices')
    // live records gone
    expect(await cv.collection<{ id: string }>('invoices').get('i1')).toBeNull()
    expect(await cv.collection<{ id: string }>('invoices').get('i2')).toBeNull()
  })

  it('freeze disposition: retains a hash-pinned read-only snapshot + removes live records', async () => {
    const store = makeStore()
    const { cv } = await setup(store, 'operator', 'rw', GATE_ON)
    const res = await cv.user.unilateralWithdrawal({ disposition: 'freeze', legalBasis: 'retention', reKey: { secret: 'new-pw' } })
    expect(res.snapshot).toBeTruthy()
    expect(res.snapshot!.recordCount).toBe(2)
    expect(res.snapshot!.sha256).toMatch(/^[0-9a-f]{64}$/)
    // the frozen snapshot record exists and holds the original envelopes
    const snapEnv = await store.get('acme', '_frozen_snapshots', res.snapshot!.withdrawalId)
    expect(snapEnv).not.toBeNull()
    const snap = JSON.parse(snapEnv!._data) as { collections: { invoices?: Record<string, unknown> } }
    expect(Object.keys(snap.collections.invoices ?? {})).toEqual(expect.arrayContaining(['i1', 'i2']))
    // live records gone
    expect(await cv.collection<{ id: string }>('invoices').get('i1')).toBeNull()
  })
})
