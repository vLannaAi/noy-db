// Forget fanout (#622, #638 Task 6): `vault.forget()` asks the graph for the forgotten
// record's derived artifacts (spec §5). Record-grain artifacts (MV rows, array-shape
// derivation rows) are ERASED via the same `!internal` housekeeping-bypass machinery the
// ordinary delete path uses; aggregate-grain rollups are RECOMPUTED without the forgotten
// contribution in open periods, or skip+audit (via `putDerivedOutput`) in frozen ones.
// Results join the existing `ForgetResult` additively — the seam map's finding that NO test
// anywhere combines forget × derivation/MV becomes this file's first fixture.

import { describe, it, expect } from 'vitest'
import { createNoydb, withRollup, withMaterializedView, withDerivation } from '../../src/index.js'
import { withForgetCascade } from '../../src/with-audit/forget/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { withPeriods } from '../../src/with-audit/periods/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

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
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) { out[cname] = out[cname] ?? {}; out[cname]![id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
      }
    },
  }
}

interface Buyer extends Record<string, unknown> { id: string; asOf?: string; totalSpent?: number }
interface Sale extends Record<string, unknown> { id: string; buyerId: string; subjectId: string; total: number }

const totalSpentRollup = () =>
  withRollup<Sale, Buyer>({
    from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
    compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
  })

describe('forget() fanout to derived residue (#622)', () => {
  it('forget × rollup: the parent aggregate is recomputed without the forgotten child (open period)', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'forget-fanout-rollup-passphrase-2026',
      derivationStrategies: [totalSpentRollup()],
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { sales: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    const sales = vault.collection<Sale>('sales')

    await buyers.put('b1', { id: 'b1' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', subjectId: 'subj-1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', subjectId: 'subj-2', total: 50 })
    expect((await buyers.get('b1'))?.totalSpent).toBe(150)

    const result = await vault.forget('subj-1')

    // Parent value drops — the forgotten child's contribution is gone.
    expect((await buyers.get('b1'))?.totalSpent).toBe(50)
    expect(result.derivedAggregatesRecomputed).toBe(1)
    expect(result.recordsShredded).toBe(1)
    expect(await sales.get('s1')).toBeNull()
    expect(await sales.get('s2')).not.toBeNull()
  })

  it('forget × MV row: the row keyed by the forgotten subject is erased', async () => {
    interface Person extends Record<string, unknown> { id: string; subjectId: string; name: string }
    const mv = withMaterializedView<Person>({
      name: 'people-mirror',
      query: (db) => db.collection<Person>('people').query(),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'forget-fanout-mv-passphrase-2026',
      materializedViewStrategies: [mv],
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { people: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    const people = vault.collection<Person>('people')
    const mirror = vault.collection<Person>('people-mirror')
    await people.put('p1', { id: 'p1', subjectId: 'subj-1', name: 'Ada' })
    await people.put('p2', { id: 'p2', subjectId: 'subj-2', name: 'Bea' })
    expect(await mirror.get('p1')).not.toBeNull()

    const result = await vault.forget('subj-1')

    expect(await mirror.get('p1')).toBeNull()
    expect(await mirror.get('p2')).not.toBeNull() // untouched sibling
    expect(result.derivedRecordsErased).toBeGreaterThanOrEqual(1)
    expect(result.recordsShredded).toBe(1)
  })

  it('forget × optional derivation with no emitted row: derivedRecordsErased counts only REAL erasures (#622 review Finding 1)', async () => {
    // RCT-TRIGGER-001-style optional output: the derivation edge exists (allocations →
    // receipts), but `derive` returns null for THIS record, so no receipt row was ever
    // written. Forgetting it must NOT count a phantom erasure — `dispatchArrayDerivationsOnDelete`'s
    // `_internalDelete` no-ops (nothing to delete), and the count must reflect that 0, not the
    // edge count (1). Fails on the unfixed edge-count path (over-counts to 1).
    interface Alloc extends Record<string, unknown> { id: string; subjectId: string; servicesNetPortion: number }
    interface Receipt extends Record<string, unknown> { id: string; appliedAmount: number }
    const strategy = withDerivation<Alloc, { receipt: Receipt }>({
      source: 'allocations',
      deterministic: true,
      outputs: { receipt: { shape: 'record', collection: 'receipts', optional: true } },
      derive: (alloc) => ({
        receipt: alloc.servicesNetPortion > 0 ? { id: alloc.id, appliedAmount: alloc.servicesNetPortion } : null!,
      }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'forget-fanout-optional-skip-passphrase-2026',
      derivationStrategies: [strategy],
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { allocations: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    await vault.collection<Alloc>('allocations').put('a1', { id: 'a1', subjectId: 'subj-1', servicesNetPortion: 0 })
    expect(await vault.collection<Receipt>('receipts').get('a1')).toBeNull() // never emitted

    const result = await vault.forget('subj-1')

    expect(result.recordsShredded).toBe(1)
    expect(result.derivedRecordsErased).toBe(0) // exact: no output row ever existed to erase
  })

  it('forget × frozen aggregate: recompute skipped, residue reported + audited, subject still fully shredded', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'forget-fanout-frozen-passphrase-2026',
      derivationStrategies: [totalSpentRollup()],
      periodsStrategy: withPeriods(),
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { sales: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    const sales = vault.collection<Sale>('sales')

    await buyers.put('b1', { id: 'b1', asOf: '2026-01-15' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', subjectId: 'subj-1', total: 100 })
    const beforeTotal = (await buyers.get('b1'))?.totalSpent
    expect(beforeTotal).toBe(100)

    await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'asOf' })

    const result = await vault.forget('subj-1')

    // Recompute skipped — the historical aggregate (still holding the forgotten
    // contribution) stands, and the skip is reported for audit.
    expect(result.derivedResidueFrozen).toEqual(['buyers:b1'])
    expect((await buyers.get('b1'))?.totalSpent).toBe(beforeTotal)

    // The subject record itself is still fully shredded — GDPR erasure of the
    // record's OWN body is unconditional, independent of the aggregate freeze.
    expect(result.recordsShredded).toBe(1)
    expect(await sales.get('s1')).toBeNull()

    const entries = await vault.ledger().entries()
    const auditEntries = entries.filter(e => e.op === 'lifecycle' && e.reason?.includes('derivation-skipped-frozen'))
    expect(auditEntries).toHaveLength(1)
  })

  it('forget with no derived consumers: existing report fields are byte-unchanged, new fields default to zero/empty', async () => {
    interface Person extends Record<string, unknown> { id: string; subjectId: string; name: string }
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'forget-fanout-plain-passphrase-2026',
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { people: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    await vault.collection<Person>('people').put('p1', { id: 'p1', subjectId: 'subj-1', name: 'Ada' })

    const result = await vault.forget('subj-1')

    expect(result.recordsShredded).toBe(1)
    expect(result.collections).toEqual(['people'])
    expect(result.historyVersionsShredded).toBe(0)
    expect(result.unmigratedRecords).toEqual([])
    expect(result.blobsShredded).toBe(0)
    expect(result.blobResidueCollections).toEqual([])
    expect(result.indexPostingsPurged).toBe(0)
    expect(result.indexResidue).toEqual([])
    expect(result.sealedFieldsShredded).toBe(0)
    expect(result.sealedCekEnvelopesPurged).toBe(0)
    expect(result.sealedCekResidue).toEqual([])
    expect(result.sealedResidue).toEqual([])
    // Additive #622 fields default to zero/empty when nothing was derived.
    expect(result.derivedRecordsErased).toBe(0)
    expect(result.derivedAggregatesRecomputed).toBe(0)
    expect(result.derivedResidueFrozen).toEqual([])
    // Additive #650 Task 5 fields default to zero when no lookup ref propagated.
    expect(result.lookupReferencesCascaded).toBe(0)
    expect(result.lookupReferencesNullified).toBe(0)
    // Snapshot the full key set — a byte-shape regression on an EXISTING field
    // would silently pass value assertions above but fail this key list.
    // #650 Task 5 — lookupReferencesCascaded/lookupReferencesNullified are new,
    // additive fields (see lookup-forget-ref.test.ts); every pre-existing key
    // below is unchanged.
    expect(Object.keys(result).sort()).toEqual([
      'blobResidueCollections', 'blobsRetainedShared', 'blobsShredded', 'collections',
      'derivedAggregatesRecomputed', 'derivedRecordsErased', 'derivedResidueFrozen',
      'historyVersionsShredded', 'indexPostingsPurged', 'indexResidue', 'ledgerEntry',
      'lookupReferencesCascaded', 'lookupReferencesNullified',
      'recordsShredded', 'sealedCekEnvelopesPurged', 'sealedCekResidue', 'sealedFieldsShredded',
      'sealedResidue', 'subject', 'unmigratedRecords',
    ])
  })
})
