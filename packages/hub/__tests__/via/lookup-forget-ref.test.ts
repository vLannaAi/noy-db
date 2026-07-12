/**
 * Forget × lookup-ref semantics (#650 Task 5, phase D of the Via port;
 * fixes #648). Spec §4 design decision: forgetting a referenced backing row
 * under `restrict` is REFUSED before any shred (the reference must be
 * retired/rewritten first — same as an ordinary restrict delete); `cascade`/
 * `nullify` propagate ADDITIVELY, after the shred, reported on
 * `ForgetResult.lookupReferencesCascaded`/`lookupReferencesNullified`.
 * Taint composes independently of forget: a lookup edge whose source names a
 * classified field folds that field's posture into the derived presentation
 * posture (edges are field-level — no `'*'`-node collection posture frame,
 * #642 stays out of scope).
 *
 * RED (pre-Task-5): no `'ref'` `EdgeKind`/edge registration, no restrict
 * pre-shred check in `Vault.forget()`, no `'ref'` branch in
 * `forgetDerivedFanout`, no `lookupReferencesCascaded`/`lookupReferencesNullified`
 * on `ForgetResult` — every assertion below failed (restrict never refused;
 * cascade/nullify never propagated; the new fields were `undefined`).
 */
import { describe, it, expect, vi } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { lookup } from '../../src/shape/via-lookup/descriptor.js'
import { withForgetCascade } from '../../src/with-audit/forget/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { withClassified } from '../../src/shape/via-classified/index.js'
import { classified } from '../../src/shape/via-classified/presets.js'
import { DictKeyInUseError } from '../../src/kernel/errors.js'
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

interface Country extends Record<string, unknown> { id: string; subjectId: string; name: string }
interface Traveler extends Record<string, unknown> { id: string; country: string }

describe('forget() × lookup ref semantics (#650 Task 5, fixes #648)', () => {
  it('(a) restrict: forget() of a referenced backing row is REFUSED before any shred', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'lookup-forget-ref-restrict-2026',
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { countries: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    const countries = vault.collection<Country>('countries', {})
    const travelers = vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries', { onDelete: 'restrict' }) },
    })
    await countries.put('US', { id: 'US', subjectId: 'subj-1', name: 'United States' })
    await travelers.put('t1', { id: 't1', country: 'US' })

    await expect(vault.forget('subj-1')).rejects.toThrow(DictKeyInUseError)

    // Refused BEFORE any shred — the subject row is untouched.
    expect(await countries.get('US')).not.toBeNull()
    expect(await travelers.get('t1')).not.toBeNull()
  })

  it('(b) cascade: the fanout reports lookupReferencesCascaded === 1; the order is tombstoned; the subject is fully shredded', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'lookup-forget-ref-cascade-2026',
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { countries: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    const countries = vault.collection<Country>('countries', {})
    const travelers = vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries', { onDelete: 'cascade' }) },
    })
    await countries.put('US', { id: 'US', subjectId: 'subj-1', name: 'United States' })
    await travelers.put('t1', { id: 't1', country: 'US' })

    const result = await vault.forget('subj-1')

    expect(result.lookupReferencesCascaded).toBe(1)
    expect(result.lookupReferencesNullified).toBe(0)
    expect(result.recordsShredded).toBe(1)
    expect(await travelers.get('t1')).toBeNull()
    expect(await countries.get('US')).toBeNull()
  })

  it('(b2) cascade with a non-default descriptor.key: the fanout resolves the PRE-tombstone row[key], not the PUT-id (the row is already shredded by the time the fanout runs)', async () => {
    interface CountryKeyed extends Record<string, unknown> { id: string; subjectId: string; iso2: string }
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'lookup-forget-ref-cascade-keyfield-2026',
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { countries: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    const countries = vault.collection<CountryKeyed>('countries', {})
    const travelers = vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'cascade' }) },
    })
    // The PUT-id ('US-internal') is deliberately NOT the iso2 value ('US').
    await countries.put('US-internal', { id: 'US-internal', subjectId: 'subj-1', iso2: 'US' })
    await travelers.put('t1', { id: 't1', country: 'US' })

    const result = await vault.forget('subj-1')

    expect(result.lookupReferencesCascaded).toBe(1)
    expect(await travelers.get('t1')).toBeNull()
    expect(await countries.get('US-internal')).toBeNull()
  })

  it('(b3) cascade with a non-default descriptor.key: propagation still happens even when the PRE-tombstone envelope DECODE fails — the compare-key is resolved from the LIVE row BEFORE the shred, not from a post-shred decode (#650 Task 5 review, Important fix)', async () => {
    interface CountryKeyed extends Record<string, unknown> { id: string; subjectId: string; iso2: string }
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'lookup-forget-ref-cascade-decodefail-2026',
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { countries: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    const countries = vault.collection<CountryKeyed>('countries', {})
    const travelers = vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'cascade' }) },
    })
    await countries.put('US-internal', { id: 'US-internal', subjectId: 'subj-1', iso2: 'US' })
    await travelers.put('t1', { id: 't1', country: 'US' })

    // Stub out the PRE-tombstone envelope decode the OLD implementation depended on for a
    // non-'id' keyField — on unfixed HEAD this made the fanout's compareKey resolve to
    // `undefined` and silently `continue`, leaving 't1' un-cascaded with NO report entry.
    vi.spyOn(countries, '_decodeEnvelope').mockResolvedValue(null)

    const result = await vault.forget('subj-1')

    expect(result.lookupReferencesCascaded).toBe(1) // propagated anyway — resolved live, pre-shred
    expect(result.lookupReferencesResidue).toEqual([])
    expect(await travelers.get('t1')).toBeNull()
    expect(await countries.get('US-internal')).toBeNull()
  })

  it('(b4) cascade with a non-default descriptor.key: when the LIVE pre-shred resolve ALSO fails (row unreadable), propagation is skipped but reported via lookupReferencesResidue — never silently (#650 Task 5 review, Important fix)', async () => {
    interface CountryKeyed extends Record<string, unknown> { id: string; subjectId: string; iso2: string }
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'lookup-forget-ref-cascade-doublefail-2026',
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { countries: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    const countries = vault.collection<CountryKeyed>('countries', {})
    const travelers = vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'cascade' }) },
    })
    await countries.put('US-internal', { id: 'US-internal', subjectId: 'subj-1', iso2: 'US' })
    await travelers.put('t1', { id: 't1', country: 'US' })

    // The backing row is unreadable even LIVE, pre-shred — the double-failure path.
    vi.spyOn(countries, 'get').mockResolvedValue(null)

    const result = await vault.forget('subj-1')

    expect(result.lookupReferencesCascaded).toBe(0)
    expect(result.lookupReferencesResidue).toEqual(['countries:US-internal:travelers.country'])
    expect(await travelers.get('t1')).not.toBeNull() // skipped, but reported — never silently dropped
  })

  it('(c) nullify: the fanout reports lookupReferencesNullified === 1; the referencing field is cleared; the subject is fully shredded', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'lookup-forget-ref-nullify-2026',
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { countries: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    const countries = vault.collection<Country>('countries', {})
    const travelers = vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries', { onDelete: 'nullify' }) },
    })
    await countries.put('US', { id: 'US', subjectId: 'subj-1', name: 'United States' })
    await travelers.put('t1', { id: 't1', country: 'US' })

    const result = await vault.forget('subj-1')

    expect(result.lookupReferencesNullified).toBe(1)
    expect(result.lookupReferencesCascaded).toBe(0)
    expect(result.recordsShredded).toBe(1)
    expect((await travelers.get('t1'))?.country).toBeNull()
    expect(await countries.get('US')).toBeNull()
  })

  it('(d) existing ForgetResult keys are byte-unchanged; the two new fields are additive and default to zero', async () => {
    interface Person extends Record<string, unknown> { id: string; subjectId: string; name: string }
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'lookup-forget-ref-plain-2026',
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { people: 'subjectId' } }),
    })
    const vault = await db.openVault('firm')
    await vault.collection<Person>('people').put('p1', { id: 'p1', subjectId: 'subj-1', name: 'Ada' })

    const result = await vault.forget('subj-1')

    expect(result.recordsShredded).toBe(1)
    expect(result.lookupReferencesCascaded).toBe(0)
    expect(result.lookupReferencesNullified).toBe(0)
    expect(result.lookupReferencesResidue).toEqual([])
    // Every pre-#650 key is still present (byte-unchanged) — the new fields
    // (incl. lookupReferencesResidue, #650 Task 5 review Important fix) are
    // strictly additive to the existing set.
    expect(Object.keys(result).sort()).toEqual([
      'blobResidueCollections', 'blobsRetainedShared', 'blobsShredded', 'collections',
      'derivedAggregatesRecomputed', 'derivedRecordsErased', 'derivedResidueFrozen',
      'historyVersionsShredded', 'indexPostingsPurged', 'indexResidue', 'ledgerEntry',
      'lookupReferencesCascaded', 'lookupReferencesNullified', 'lookupReferencesResidue',
      'recordsShredded', 'sealedCekEnvelopesPurged', 'sealedCekResidue', 'sealedFieldsShredded',
      'sealedResidue', 'subject', 'unmigratedRecords',
    ])
  })

  it('(e) taint: a lookup into a classified-field source seals the derived presentation; a lookup into a plain collection does not', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'lookup-forget-ref-taint-2026',
      classifiedStrategy: withClassified(),
    })
    const vault = await db.openVault('demo')
    interface Customer extends Record<string, unknown> { id: string; ssn: string }
    vault.collection<Customer>('customers', { classifiedFields: { ssn: classified.email() } })
    vault.collection('subjects', {
      lookupFields: {
        customer: lookup('customers', { present: { label: 'ssn' } }),
        country: lookup('countries', { present: { label: 'name' } }),
      },
    })

    const customerPosture = vault.graph.effectivePosture({ collection: 'subjects', field: 'customer' })
    expect(customerPosture?.encryptedAtRest).toBe('sealed')
    expect(customerPosture?.exportable).toBe(false)

    // A lookup into a plain (non-classified) collection folds no taint — the
    // '*' wildcard source contributes only DEFAULT_POSTURE.
    const countryPosture = vault.graph.effectivePosture({ collection: 'subjects', field: 'country' })
    expect(countryPosture).toEqual({ encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: false })
  })
})
