/**
 * #638 Task 3 — taint propagation: the reproduced #636 leak becomes this
 * regression suite. Ground truth: `.superpowers/sdd/seam-map-formula-graph.md`
 * §6 — a classified field's plaintext, copied verbatim (or truncated) into an
 * ordinary `computed` field, used to survive `get()`/`list()`/export/query
 * completely unredacted (empirically reproduced there against real compiled
 * code). After this task the SAME config seals the derived field at rest
 * (via the new `taint` binding, the exact `ctx.sealedSlots` capability
 * classified uses), redacts it on export, and refuses it in the query DSL.
 *
 * PARITY NOTE (deviation from the task brief, recorded — see task-3-report.md):
 * the brief's Step 1 sketch names `via(computed(fn, { deps, mode: 'virtual' |
 * 'materialized' }))` sugar. That composed `via(computed(...))` grammar (and
 * the mode option) does not exist anywhere in this codebase yet — it is
 * `SERVICES.md`/spec §6's "computed becomes a via-feature" item, a LATER task
 * in this same plan (its own doc comment: "Task 7"). This suite instead uses
 * the API `computedDeps` already wires into the graph today (#638 Task 2):
 * `computed: {...}, computedDeps: {...}`. Every computed field declared this
 * way is unconditionally eager/materialized (seam map PART 4) — there is no
 * virtual grain yet (`ViaGraph.taintSealedFields`'s own doc comment: "the
 * 'materialized' filter is a no-op until Task 7 adds the 'virtual' grain") —
 * so BOTH `ssnLeak` (full copy) and `ssnLast4` (truncated copy) are sealed at
 * rest here; Task 7 is where a `mode: 'virtual'` field's redaction would
 * instead ride the `present` phase without ever touching `_sealed`.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, count, sum, FieldNotQueryableError } from '../../src/index.js'
import { withClassified } from '../../src/shape/via-classified/index.js'
import type { ClassifiedFieldSpec } from '../../src/shape/via-classified/index.js'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'
import { SealedHandle } from '../../src/index.js'
import { inlineMemory } from '../classified/harness.js'

interface Person extends Record<string, unknown> {
  id: string
  name: string
  ssn: string
  ssnLeak?: string
  ssnLast4?: string
}

/** Raw classified spec (mirrors graph-edges.test.ts's `neverSpec` idiom) — a
 *  `storage: 'recoverable'`, `sensitivity: 'secret'` field, value-format
 *  agnostic (matches the seam map §6 reproduction's raw `ssn` field). */
const ssnSpec = (): ClassifiedFieldSpec => ({
  _noydbClassified: true, preset: 'test-ssn', storage: 'recoverable',
  list: { kind: 'omit' }, sensitivity: 'secret',
})

async function leakVault(secret: string) {
  const store = inlineMemory()
  const db = await createNoydb({
    store, user: 'a', secret,
    classifiedStrategy: withClassified(), aggregateStrategy: withAggregate(),
  })
  const v = await db.openVault('v1')
  const c = v.collection<Person>('people', {
    classifiedFields: { ssn: ssnSpec() },
    computed: {
      ssnLeak: (r) => r.ssn,
      ssnLast4: (r) => (typeof r.ssn === 'string' ? r.ssn.slice(-4) : undefined),
    },
    computedDeps: { ssnLeak: ['ssn'], ssnLast4: ['ssn'] },
  })
  await c.put('r1', { id: 'r1', name: 'Alice', ssn: '123-45-6789' })
  return { db, v, c, store }
}

describe('#636 regression — computed-from-classified taint (GREEN after #638 Task 3)', () => {
  it('(a) get()/list(): both derived fields come back sealed, not plaintext', async () => {
    const { c } = await leakVault('taint-a-1')
    const rec = await c.get('r1')
    expect(rec?.ssn).toBeInstanceOf(SealedHandle)
    expect(rec?.ssnLeak).toBeInstanceOf(SealedHandle)
    expect(rec?.ssnLast4).toBeInstanceOf(SealedHandle)
    expect(JSON.stringify(rec?.ssnLeak)).toBe('"[sealed]"')
    expect(JSON.stringify(rec?.ssnLast4)).toBe('"[sealed]"')
    expect(rec?.name).toBe('Alice') // untainted field unaffected

    const list = await c.list()
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list[0]?.ssnLeak)).toBe('"[sealed]"')
    expect(JSON.stringify(list[0]?.ssnLast4)).toBe('"[sealed]"')
  })

  it('(b) the raw stored envelope seals ssnLeak/ssnLast4 into `_sealed` — never inline in `_data`', async () => {
    const { store } = await leakVault('taint-b-1')
    const envelope = store._dump('v1', 'people', 'r1')
    expect(envelope).toBeDefined()
    expect(envelope!._sealed).toBeDefined()
    expect(envelope!._sealed!.ssn).toMatch(/^.+:.+$/)
    expect(envelope!._sealed!.ssnLeak).toMatch(/^.+:.+$/)
    expect(envelope!._sealed!.ssnLast4).toMatch(/^.+:.+$/)
    // Peeled OUT of `_data` — the plaintext SSN appears nowhere in the
    // encrypted body's plaintext-adjacent metadata (structural proof: a
    // sealed field is deleted from the record before `_data` is built).
    expect(envelope!._data).not.toContain('123-45-6789')
    expect(envelope!._data).not.toContain('6789')
  })

  it('(c) .where()/.aggregate() refuse both derived fields — FieldNotQueryableError', async () => {
    const { c } = await leakVault('taint-c-1')
    expect(() => c.query().where('ssnLeak', '==', '123-45-6789')).toThrow(FieldNotQueryableError)
    expect(() => c.query().where('ssnLast4', '==', '6789')).toThrow(FieldNotQueryableError)
    expect(() => c.query().aggregate({ n: sum('ssnLast4') })).toThrow(FieldNotQueryableError)
    expect(() => c.query().aggregate({ n: count() })).not.toThrow() // count() has no .field to gate
    // The SOURCE classified field itself keeps today's PARITY behavior
    // (det-exact stays out of .where() — matches, never throws).
    expect(await c.query().where('ssn', '==', '123-45-6789').toArray()).toEqual([])
  })

  it('(d) exportJSON()/exportStream() redact both derived fields', async () => {
    const { v } = await leakVault('taint-d-1')
    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as { collections: Record<string, { records: Array<Record<string, unknown>> }> }
    const rec = parsed.collections.people!.records[0]!
    expect(rec.ssn).toBe('[sealed]')
    expect(rec.ssnLeak).toBe('[sealed]')
    expect(rec.ssnLast4).toBe('[sealed]')
    expect(rec.name).toBe('Alice')

    const chunks: { collection: string; records: unknown[] }[] = []
    for await (const chunk of v.exportStream()) chunks.push(chunk)
    const peopleChunk = chunks.find((ch) => ch.collection === 'people')!
    const serialized = JSON.parse(JSON.stringify(peopleChunk.records)) as Array<Record<string, unknown>>
    expect(serialized[0]!.ssnLeak).toBe('[sealed]')
    expect(serialized[0]!.ssnLast4).toBe('[sealed]')
  })

  it('(e) describe() reports effective posture sealed, provenance forcedBy ssn', async () => {
    const { c } = await leakVault('taint-e-1')
    const desc = c.describe()
    const leak = desc.fields.find((f) => f.key === 'ssnLeak')
    const last4 = desc.fields.find((f) => f.key === 'ssnLast4')
    expect(leak?.taint?.posture.encryptedAtRest).toBe('sealed')
    expect(leak?.taint?.posture.exportable).toBe(false)
    expect(leak?.taint?.posture.queryable).toBe('none')
    expect(leak?.taint?.forcedBy).toEqual(['ssn'])
    expect(last4?.taint?.posture.encryptedAtRest).toBe('sealed')
    expect(last4?.taint?.forcedBy).toEqual(['ssn'])
    // An untainted computed/plain field carries no taint block.
    const name = desc.fields.find((f) => f.key === 'name')
    expect(name?.taint).toBeUndefined()
  })
})
