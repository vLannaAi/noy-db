/**
 * Per-layer onMissing wiring — guard & derivation layers (#285 D1).
 *
 * A field can be lenient at the app read boundary but strict (or null)
 * elsewhere. The SAME `firstName`, stored in `th` only and read under an
 * active `en` locale, resolves differently per layer:
 *
 *   onMissing: { read:'throw', guard:'substitute', derivation:'null' }
 *
 *   - ordinary get()             → throws        (read layer)
 *   - a guard reading via ctx    → 'สมชาย'        (guard layer, substitute)
 *   - a derivation reading via ctx → null         (derivation layer)
 *
 * mv/join/export layers read raw maps in the query pipeline and are tracked
 * separately (#285 D2/D3) — not covered here.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withGuard, withDerivation } from '../src/index.js'
import { withI18n } from '../src/i18n/index.js'
import { i18nText } from '../src/i18n/core.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/types.js'

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
        const [vname, cname, id] = key.split('/')
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  }
}

interface Person extends Record<string, unknown> { id: string; firstName: unknown }
interface Order extends Record<string, unknown> { id: string; personId: string }

const PERSON_I18N = {
  firstName: i18nText({
    languages: ['th', 'en'],
    required: 'any',
    substitute: ['en', 'th', 'any'],
    onMissing: { read: 'throw', guard: 'substitute', derivation: 'null' },
  }),
}

describe('per-layer onMissing — guard layer (#285)', () => {
  it("a guard reading a sibling via ctx.vault resolves at layer 'guard' (substitute)", async () => {
    let observed: unknown = '__unset__'
    const orderGuard = withGuard<Order>({
      collection: 'orders',
      check: async (incoming, ctx) => {
        const person = await ctx.vault.collection<Person>('people').get(incoming.personId)
        observed = person?.firstName
      },
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'i18n-layers-guard-passphrase-2026',
      i18nStrategy: withI18n(),
      guardStrategies: [orderGuard],
    })
    const v = await db.openVault('demo', { locale: 'en' })
    v.collection<Person>('people', { i18nFields: PERSON_I18N })

    await v.collection<Person>('people').put('p1', { id: 'p1', firstName: { th: 'สมชาย' } })
    // Triggers the guard, which reads p1 through ctx.vault at layer 'guard'.
    await v.collection<Order>('orders').put('o1', { id: 'o1', personId: 'p1' })

    // Guard layer substitutes the missing 'en' from the chain → Thai value.
    expect(observed).toBe('สมชาย')
  })

  it("the same field still throws on an ordinary get() (read layer)", async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'i18n-layers-read-passphrase-2026',
      i18nStrategy: withI18n(),
    })
    const v = await db.openVault('demo', { locale: 'en' })
    const people = v.collection<Person>('people', { i18nFields: PERSON_I18N })
    await people.put('p1', { id: 'p1', firstName: { th: 'สมชาย' } })
    await expect(people.get('p1')).rejects.toThrow(/locale/i)
  })

  it("guard layer defaults to 'substitute' even when only a read policy is declared", async () => {
    // onMissing has NO guard key — the guard layerDefault ('substitute')
    // applies, so the guard read does not hard-fail.
    let observed: unknown = '__unset__'
    const orderGuard = withGuard<Order>({
      collection: 'orders',
      check: async (incoming, ctx) => {
        observed = (await ctx.vault.collection<Person>('people').get(incoming.personId))?.firstName
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'i18n-layers-guard-default-passphrase-2026',
      i18nStrategy: withI18n(),
      guardStrategies: [orderGuard],
    })
    const v = await db.openVault('demo', { locale: 'en' })
    v.collection<Person>('people', {
      i18nFields: {
        firstName: i18nText({
          languages: ['th', 'en'],
          required: 'any',
          substitute: ['en', 'th', 'any'],
          onMissing: { read: 'throw' }, // no guard key
        }),
      },
    })
    await v.collection<Person>('people').put('p1', { id: 'p1', firstName: { th: 'สมชาย' } })
    await v.collection<Order>('orders').put('o1', { id: 'o1', personId: 'p1' })
    expect(observed).toBe('สมชาย')
  })
})

describe('per-layer onMissing — derivation layer (#285)', () => {
  it("a derivation reading a sibling via ctx.vault resolves at layer 'derivation' (null)", async () => {
    interface Summary extends Record<string, unknown> { id: string; personFound: boolean; resolvedName: unknown }
    const summarize = withDerivation<Order, { summary: Summary }>({
      source: 'orders',
      deterministic: true,
      outputs: { summary: { shape: 'record', collection: 'summaries' } },
      derive: async (order, ctx) => {
        const person = await ctx.vault.collection<Person>('people').get(order.personId)
        // derivation layer → the person IS found, but its missing-'en'
        // firstName resolves to null (the derive fn branches explicitly).
        return { summary: { id: order.id, personFound: person !== null, resolvedName: person ? person.firstName : 'NO_PERSON' } }
      },
      lifecycle: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'i18n-layers-derivation-passphrase-2026',
      i18nStrategy: withI18n(),
      derivationStrategies: [summarize],
    })
    const v = await db.openVault('demo', { locale: 'en' })
    v.collection<Person>('people', { i18nFields: PERSON_I18N })

    await v.collection<Person>('people').put('p1', { id: 'p1', firstName: { th: 'สมชาย' } })
    await v.collection<Order>('orders').put('o1', { id: 'o1', personId: 'p1' })

    const summary = await v.collection<Summary>('summaries').get('o1')
    expect(summary?.personFound).toBe(true)        // sibling read succeeded
    expect(summary?.resolvedName).toBeNull()        // firstName null at derivation layer
  })
})
