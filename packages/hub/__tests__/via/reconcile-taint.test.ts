/**
 * #671 item 4 — money-only (and classified-only) late-attach reconcile calls
 * must not drop the graph's taint overlay off `coll._via.taint`. Distinct
 * from `taint.test.ts` (#638 Task 3's general taint-propagation suite,
 * including its own reconcile-path coverage for a COMBINED classified+computed
 * late-attach) — this file is scoped to the #671 item 4 residual:
 * `_applyMoneyFields`/`_applyClassifiedFields` (`kernel/collection.ts`)
 * rebuild `this.via` via the bare one-arg `ViaPipeline.build(bindings)` call,
 * silently defaulting `taint` to `undefined` and dropping any already-
 * materialized overlay.
 *
 * The money-only path is the confirmed, reproducible bug: the
 * `reconcilePlan`/`applyTaintOverlay` re-run (`kernel/via/reconcile.ts:420,
 * 437-440`) is gated by `plan.computed || plan.classifiedFields` —
 * `moneyFields` never trips that condition, so nothing patches the drop back
 * up. The classified-only path has the identical code-level omission but was
 * already masked by that same re-run (`plan.classifiedFields` IS part of the
 * gate) — the second describe block below pins that it STAYS green now that
 * `_applyClassifiedFields` threads taint directly too.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, FieldNotQueryableError, SealedHandle } from '../../src/index.js'
import { withClassified } from '../../src/via/classified/index.js'
import type { ClassifiedFieldSpec } from '../../src/via/classified/index.js'
import { money } from '../../src/via/money/descriptor.js'
import { inlineMemory } from '../classified/harness.js'

interface Person extends Record<string, unknown> {
  id: string
  ssn: string
  ssnLeak?: string
  amount?: string
  amountCopy?: string
}

const ssnSpec = (): ClassifiedFieldSpec => ({
  _noydbClassified: true, preset: 'test-ssn', storage: 'recoverable',
  list: { kind: 'omit' }, sensitivity: 'secret',
})

describe('#671 item 4 — money-only late-attach preserves the taint overlay', () => {
  it('a SECOND vault.collection() call adding ONLY moneyFields keeps coll._via.taint defined, and postureFor/redactForExport still enforce the derived-taint postures', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret: 'money-only-late-attach-1', classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v1')

    // Fresh construction: classified + computed — the taint overlay materializes here
    // (applyTaintOverlay's unconditional fresh-construction call, vault.ts:1173).
    const c = v.collection<Person>('people', {
      classifiedFields: { ssn: ssnSpec() },
      computed: { ssnLeak: { fn: (r) => r.ssn, deps: ['ssn'] } },
    })
    await c.put('r1', { id: 'r1', ssn: '123-45-6789' })
    expect(c._via?.taint).toBeDefined()
    const before = await c.get('r1')
    expect(before?.ssnLeak).toBeInstanceOf(SealedHandle)

    // SECOND vault.collection() call, same collection name, adding ONLY moneyFields.
    const c2 = v.collection<Person>('people', {
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })

    // The bug: `_applyMoneyFields`'s rebuild called `ViaPipeline.build([...])` with no
    // second arg, defaulting `taint` to undefined and silently dropping it.
    expect(c2._via?.taint).toBeDefined()

    // postureFor/redactForExport still reflect the derived-taint postures post-attach.
    const after = await c2.get('r1')
    expect(after?.ssnLeak).toBeInstanceOf(SealedHandle)
    expect(JSON.stringify(after?.ssnLeak)).toBe('"[sealed]"')
    expect(() => c2.query().where('ssnLeak', '==', '123-45-6789')).toThrow(FieldNotQueryableError)

    const json = await v.exportJSON()
    const parsed = JSON.parse(json) as { collections: Record<string, { records: Array<Record<string, unknown>> }> }
    expect(parsed.collections.people!.records[0]!.ssnLeak).toBe('[sealed]')
  })
})

describe('#671 item 4 regression — classified-only late-attach also keeps the taint overlay (already masked by the reconcilePlan/applyTaintOverlay re-run; must STAY green now that _applyClassifiedFields threads taint directly too)', () => {
  it('a SECOND vault.collection() call declaring classifiedFields for the FIRST time does not drop a pre-existing money-sourced taint overlay', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'a', secret: 'classified-only-late-attach-1', classifiedStrategy: withClassified(),
    })
    const v = await db.openVault('v1')

    // Fresh construction: money + computed (materialized), plus `sensitive: ['ssn']` to
    // pre-freeze `ssn` into `sensitiveFields` — the ONLY way a `storage: 'recoverable'`
    // classified field is later accepted via late-attach (mirrors taint.test.ts's own
    // reconcile-path idiom). Money's own posture (envelope/ordered/exportable/
    // forgettable:true — via/money/binding.ts:42) differs from DEFAULT_POSTURE
    // (forgettable:false), so the derived field's fold is non-default and the taint
    // overlay materializes WITHOUT any classified field in play yet.
    const c = v.collection<Person>('accounts', {
      sensitive: ['ssn'],
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
      computed: { amountCopy: { fn: (r) => r.amount, deps: ['amount'] } },
    })
    expect(c._via?.taint).toBeDefined()
    const beforePosture = c._via?.taint?.postures.get('amountCopy')
    expect(beforePosture).toBeDefined()

    // SECOND call — classifiedFields declared for the FIRST time (`this.classified`
    // was undefined) — the classified-only late-attach door.
    const c2 = v.collection<Person>('accounts', {
      classifiedFields: { ssn: ssnSpec() },
    })

    expect(c2._via?.taint).toBeDefined()
    expect(c2._via?.taint?.postures.get('amountCopy')).toEqual(beforePosture)
  })
})
