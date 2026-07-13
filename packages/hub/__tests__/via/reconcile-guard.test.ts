/**
 * #664 Part 1 — the late-attach reconcile-path collision guard. Two probe recipes from the
 * round-2 fable review (2026-07-13):
 *
 *   (a) incoming×incoming — a SECOND `vault.collection()` call names the SAME field in two
 *       different via-binding families (e.g. `moneyFields`+`blobFields` both claiming
 *       `"amount"`). Pre-#664: money reconciled and quantized while blob was silently dropped —
 *       no guard fired on the reconcile path (only fresh construction refused this).
 *   (b) existing×incoming — an EARLIER call already compiled a binding for a field (here:
 *       `classifiedFields`), and a LATER call's incoming family map claims the SAME field for a
 *       DIFFERENT family (`moneyFields`). Pre-#664: silently accepted, producing mutually
 *       unsatisfiable write enforcement (a "write-brick" — every subsequent `put()` throws one
 *       way or the other) instead of refusing at declare time.
 *
 * Plus the #631 exemption ({computed,money}/{computed,i18n}/{computed,lookup}) must stay legal
 * when SPLIT across two `vault.collection()` calls, not just within one.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { ValidationError } from '../../src/kernel/errors.js'
import { money } from '../../src/shape/via-money/descriptor.js'
import { classified } from '../../src/shape/via-classified/presets.js'
import { via } from '../../src/kernel/via-compose.js'
import { inlineMemory } from '../classified/harness.js'

interface Card extends Record<string, unknown> {
  id: string
  amount: number | string
  qty?: number
  total?: number | string
}

interface Person extends Record<string, unknown> {
  id: string
  ssn: string
}

describe('#664 Part 1 — late-attach reconcile collision guard', () => {
  it('recipe (a) incoming×incoming: moneyFields + blobFields naming the same field on a late-attach call refuses', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-reconcile-guard-1' })
    const vault = await db.openVault('v1')

    // First call: bare collection (no via declarations) — mirrors an MV-precreation
    // auto-create, or a plain first `vault.collection(name)` call.
    vault.collection<Card>('cards', {})

    // Second call: moneyFields + blobFields both claim "amount" — fresh-construct would
    // refuse this outright; the late-attach reconcile path must refuse it identically.
    expect(() => vault.collection<Card>('cards', {
      moneyFields: { amount: money({ currency: 'USD', scale: 2 }) },
      blobFields: { amount: {} },
    })).toThrow(ValidationError)
    expect(() => vault.collection<Card>('cards', {
      moneyFields: { amount: money({ currency: 'USD', scale: 2 }) },
      blobFields: { amount: {} },
    })).toThrow(/"amount"/)
  })

  it('recipe (a), viaFields spelling: via(money(...)) + blobFields naming the same field on a late-attach call refuses', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-reconcile-guard-1b' })
    const vault = await db.openVault('v1')
    vault.collection<Card>('cards', {})

    expect(() => vault.collection<Card>('cards', {
      viaFields: { amount: via(money({ currency: 'USD', scale: 2 })) },
      blobFields: { amount: {} },
    })).toThrow(ValidationError)
  })

  it('recipe (b) existing×incoming (the write-brick recipe): call-1 classifiedFields, call-2 moneyFields on the SAME field refuses at declare time', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-reconcile-guard-2' })
    const vault = await db.openVault('v1')

    // call-1: fresh construct declares "ssn" classified.
    vault.collection<Person>('people', {
      classifiedFields: { ssn: classified.email() },
    })

    // call-2: late-attach declares "ssn" money — a DIFFERENT family claiming a field the
    // live collection's compiled bindings already own. Pre-#664 this was silently accepted
    // (money reconciled onto the classified field) and every subsequent put() would throw
    // one way or the other (mutually unsatisfiable write enforcement) — now it refuses
    // loudly at declare time instead.
    expect(() => vault.collection<Person>('people', {
      moneyFields: { ssn: money({ currency: 'USD', scale: 2 }) },
    })).toThrow(ValidationError)
    expect(() => vault.collection<Person>('people', {
      moneyFields: { ssn: money({ currency: 'USD', scale: 2 }) },
    })).toThrow(/"ssn"/)
  })

  it('control: a {computed,money} composition split across two calls (computed fresh, money late-attached) stays legal', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-reconcile-guard-3' })
    const vault = await db.openVault('v1')

    // call-1: fresh construct declares a VIRTUAL computed field on "total" — compiles a real
    // 'computed' via binding covering it (materialized-mode computed fields compile no via
    // binding at all, so only virtual mode exercises the guard's existing-family lookup here).
    const first = vault.collection<Card>('cards', {
      computed: { total: { fn: (r) => (r['qty'] as number) * 2, deps: ['qty'], mode: 'virtual' } },
    })

    // call-2: late-attach moneyFields on the SAME field — legal fresh (the #631 exemption,
    // `via(computed(...), money(...))` composing on one field), must stay legal split across
    // two `vault.collection()` calls.
    const second = vault.collection<Card>('cards', {
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    expect(second).toBe(first)
  })

  it('control: same-family re-declaration (money then money again) on the same field is first-wins, not a collision', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-reconcile-guard-4' })
    const vault = await db.openVault('v1')
    vault.collection<Card>('cards', {
      moneyFields: { amount: money({ currency: 'USD', scale: 2 }) },
    })
    expect(() => vault.collection<Card>('cards', {
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })).not.toThrow()
  })
})
