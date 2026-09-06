/**
 * #1447 — `dumpSchema()` reports which fields the datastore itself computes.
 *
 * Before this, `CollectionDescriptor` exposed `fields, indexes, refs,
 * validator, stats, meta, config` and nothing about via bindings. So a
 * consumer maintaining documentation against the live registry had no surface
 * to join tier-7 against, and the only un-driftable option was parsing their
 * own registry source.
 *
 * The cost was measured, not hypothetical: a rulebook described three
 * vault-computed fields as app-owned, including two labelled "candidates for a
 * `computed` field" while the vault had been computing them all along.
 *
 * ⭐ THE UNDERSTATING DIRECTION IS THE DANGEROUS ONE. A doc that overstates the
 * datastore gets caught the first time someone relies on absent behaviour. One
 * that understates it produces app-side reimplementation of a guarantee that
 * already exists — two computations of the same money field, coexisting with
 * no test that they agree, and silent until they diverge.
 *
 * ⛔ Two design decisions, both settled by the consumer who would read it, and
 * both pinned below:
 *
 *   1. `coveredFields` is a DECLARED SET, not `covers()`. A predicate can only
 *      answer about fields you already know to ask about, which excludes every
 *      virtual field — exactly the ones whose drift started this.
 *   2. BRAND AND FIELD ONLY, never a binding's configuration. A dump saying
 *      "this field is classified, sensitivity pii" is a map of which columns
 *      are worth attacking, in an artefact that by design leaves the vault.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { money } from '../src/via/money/index.js'
import { ViaPipeline } from '../src/kernel/via/pipeline.js'
import { moneyVia } from '../src/via/money/binding.js'

interface Row { id: string; amount: number; note: string }

const SECRET = 'issue-1447-via-introspection-secret'

async function vaultWith(config: Record<string, unknown>) {
  const db = await createNoydb({ store: memoryStore(), user: 'o', secret: SECRET })
  const vault = await db.openVault('V')
  const col = vault.collection<Row>('rows', config as never)
  await col.put('r1', { id: 'r1', amount: 100, note: 'n' })
  vault.collection<{ id: string; n: number }>('plain')
  return vault
}

describe('#1447 — dumpSchema reports via coverage', () => {
  it('reports a VIRTUAL computed field — the case a predicate cannot reach', async () => {
    const vault = await vaultWith({
      moneyFields: { amount: money({ currency: 'THB', scale: 2 }) },
      computed: { doubled: { fn: (r: Record<string, unknown>) => Number(r['amount']) * 2, mode: 'virtual' } },
    })
    const snap = await vault.dumpSchema()

    // `doubled` exists only in the binding's config — it is not a declared
    // field, so iterating declared fields and asking `covers()` never asks.
    expect(snap.collections['rows']?.via).toEqual({
      amount: ['money'],
      doubled: ['computed'],
    })
  })

  it('omits the key entirely when a collection declares no via pipeline', async () => {
    // Absence must read as "nothing declared", not "nothing reported" — an
    // empty object would be indistinguishable from a binding that declared no
    // covered set.
    const vault = await vaultWith({ moneyFields: { amount: money({ currency: 'THB', scale: 2 }) } })
    const snap = await vault.dumpSchema()
    expect(snap.collections['plain']).toBeDefined()
    expect(snap.collections['plain']?.via).toBeUndefined()
    expect('via' in (snap.collections['plain'] as object)).toBe(false)
  })

  it('reports EVERY brand covering a field, not the first', async () => {
    // A money field that is also a virtual computed field is covered twice,
    // and the datastore does both things to it. Collapsing to one would
    // misreport what happens on read.
    const vault = await vaultWith({
      moneyFields: { amount: money({ currency: 'THB', scale: 2 }) },
      computed: { amount: { fn: (r: Record<string, unknown>) => Number(r['amount']), mode: 'virtual' } },
    })
    const snap = await vault.dumpSchema()
    expect(snap.collections['rows']?.via?.['amount']).toEqual(['computed', 'money'])
  })

  it('is deterministic — fields and brands both sorted', async () => {
    const vault = await vaultWith({
      moneyFields: { zed: money({ currency: 'THB' }), alpha: money({ currency: 'THB' }) },
    })
    const snap = await vault.dumpSchema()
    expect(Object.keys(snap.collections['rows']?.via ?? {})).toEqual(['alpha', 'zed'])
  })
})

describe('#1447 — `reports` says what the emitter CAN answer, not what it found', () => {
  /**
   * ⛔ The hazard this closes, found by a consumer attempting the adoption:
   * their documentation gate runs against a hub whose `dumpSchema()` has no
   * `via` key at all. Switching from source-parsing to the live report there
   * finds nothing, reads it as "no via fields declared", and PASSES VACUOUSLY
   * — the exact failure the gate exists to prevent, reintroduced by adopting
   * the better instrument on an emitter that cannot answer.
   *
   * Absence was doing double duty: "nothing declared" AND "this hub does not
   * report". Only the second is a lie about the collection, and only
   * `reports` can tell them apart.
   */
  it('lists via even when NOT ONE collection declares any', async () => {
    // The decisive case. A content-based list would omit `via` here and
    // reproduce the ambiguity exactly: a consumer could not distinguish this
    // vault from one whose hub cannot report.
    const db = await createNoydb({ store: memoryStore(), user: 'o', secret: SECRET })
    const vault = await db.openVault('V')
    vault.collection<{ id: string; n: number }>('plain')
    const snap = await vault.dumpSchema()

    expect(snap.reports).toContain('via')
    expect(snap.collections['plain']?.via).toBeUndefined()
    // Read together, those two say: "this emitter reports via, and this
    // collection declares none" — which is the sentence a gate needs.
  })

  it('lists via when a collection does declare some', async () => {
    const vault = await vaultWith({ moneyFields: { amount: money({ currency: 'THB', scale: 2 }) } })
    const snap = await vault.dumpSchema()
    expect(snap.reports).toContain('via')
    expect(snap.collections['rows']?.via).toEqual({ amount: ['money'] })
  })

  it('adds stats only when it was actually asked for', async () => {
    const vault = await vaultWith({ moneyFields: { amount: money({ currency: 'THB', scale: 2 }) } })
    expect((await vault.dumpSchema()).reports).toEqual(['via'])
    expect((await vault.dumpSchema({ withStats: true })).reports).toEqual(['via', 'stats'])
  })

  it('is required, so `undefined` can never mean "old emitter"', async () => {
    // An optional field would move the same ambiguity one level up.
    const vault = await vaultWith({})
    const snap = await vault.dumpSchema()
    expect(snap.reports).toBeDefined()
    expect(Array.isArray(snap.reports)).toBe(true)
    expect(snap._noydb_snapshot).toBe(2)
  })
})

describe('#1447 — the report carries no configuration', () => {
  it('names the field and the brand, and nothing else', async () => {
    const vault = await vaultWith({
      moneyFields: { amount: money({ currency: 'THB', scale: 2 }) },
    })
    const snap = await vault.dumpSchema()
    const via = snap.collections['rows']?.via

    // Brands are bare strings. Nothing here can carry a currency, a scale, a
    // sensitivity label, a dictionary name or a lookup target.
    expect(via).toEqual({ amount: ['money'] })
    const serialised = JSON.stringify(via)
    expect(serialised).not.toMatch(/THB/)
    expect(serialised).not.toMatch(/scale/)
    for (const brands of Object.values(via ?? {})) {
      for (const b of brands) expect(typeof b).toBe('string')
    }
  })
})

describe('#1447 — fieldCoverage contract', () => {
  it('omits a binding that declares no covered set, rather than reporting it as empty', () => {
    const declaring = moneyVia({ amount: money({ currency: 'THB', scale: 2 }) })
    const silent = { brand: 'silent', covers: () => true } // no coveredFields
    const via = ViaPipeline.build([declaring, silent as never])!

    const coverage = via.fieldCoverage()
    expect(coverage).toEqual({ amount: ['money'] })
    // ⛔ Not `{ ...: ['silent'] }` and not an empty entry: a binding that has
    // not declared its set is unknown, not known-to-cover-nothing.
    expect(JSON.stringify(coverage)).not.toMatch(/silent/)
  })

  it('every shipped binding declares its covered set', async () => {
    // The report is only as complete as the declarations. A binding added
    // later without one is silently missing from every dump, so this asserts
    // the shipped set rather than trusting review.
    const { computedVia } = await import('../src/via/computed/binding.js')
    const declared = [
      moneyVia({ f: money({ currency: 'THB' }) }),
      computedVia({ virtualFields: new Map([['g', { fn: () => 1, mode: 'virtual' }]]) } as never),
    ]
    for (const b of declared) {
      expect(b.coveredFields, `${b.brand} declares no coveredFields`).toBeDefined()
      expect(b.coveredFields!.length).toBeGreaterThan(0)
    }
  })
})
