/**
 * #623 Task 8 controller pin 3 — `_applyMoneyFields` PREPENDS money onto an
 * already-compiled `via` pipeline instead of appending, so a collection
 * whose FIRST `vault.collection()` call declared i18nFields (compiling
 * `via = [i18nBinding]`) and whose SECOND call reconciles moneyFields onto
 * the already-existing instance (the same "first-wins post-construction
 * attach" pattern `_applyMoneyFields`'s docstring describes for the
 * MV-precreation case) still ends up money-first (`[money, i18n]`), matching
 * `compileViaBindings`'s pinned order for a single-call declaration.
 *
 * `via` is a private field with no test-only accessor, so this asserts
 * observable behavior instead: object identity across the two calls (proof
 * the reconcile landed on the SAME instance, not a fresh one) and that both
 * money (quantize on write / decode on read) and i18n (translate/validate on
 * write / locale-resolve on read) keep working correctly post-reconcile.
 * Money and i18n operate on disjoint fields, so swapped order would not
 * itself corrupt this record — the prepend fix is about matching the pinned
 * pipeline order deterministically, not fixing an observable corruption.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { i18nText } from '../../src/via/i18n/core.js'
import { money } from '../../src/via/money/descriptor.js'
import { via } from '../../src/kernel/via-compose.js'
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
        const [vname, cname, id] = key.split('/')
        if (vname === v) { out[cname!] = out[cname!] ?? {}; out[cname!]![id!] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) { data.set(k(v, c, i), payload[c]![i]!) }
      }
    },
  }
}

interface Invoice extends Record<string, unknown> {
  id: string
  total: number | string
  memo: Record<string, string>
}

describe('_applyMoneyFields reconcile order (#623 Task 8, controller pin 3)', () => {
  it('prepends money onto a collection whose first declaration already compiled an i18n binding', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'binding-order-reconcile-2026-pilot3',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('books', { locale: 'en' })

    // First declaration: i18nFields only — compiles via = [i18nBinding].
    const first = vault.collection<Invoice>('invoices', {
      i18nFields: { memo: i18nText({ languages: ['en', 'th'], required: 'any' }) },
    })

    // Second declaration on the SAME name: moneyFields only — reconciles
    // via `_applyMoneyFields` onto the already-constructed instance.
    const second = vault.collection<Invoice>('invoices', {
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })

    // Same instance — the reconcile attached to the existing collection,
    // it did not construct a fresh one.
    expect(second).toBe(first)

    await second.put('i1', { id: 'i1', total: '10.50', memo: { en: 'Hello', th: 'สวัสดี' } })

    // Money: quantized on write, decodes back to the exact canonical decimal.
    const raw = await second.get('i1', { locale: 'raw' })
    expect(raw?.total).toBe('10.50')

    // i18n: locale resolution still applies on top of money's decode.
    const resolved = await second.get('i1', { locale: 'en' })
    expect(resolved?.total).toBe('10.50')
    expect(resolved?.memo).toBe('Hello')
  })

  it('#627: reconciles via(money(...)) declared through viaFields onto an already-constructed collection, same as moneyFields', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'binding-order-reconcile-2026-pilot3-via',
      i18nStrategy: withI18n(),
    })
    const vault = await db.openVault('books', { locale: 'en' })

    // First declaration: no money config at all (mirrors an MV-precreation
    // bare auto-create, or a plain first `vault.collection(name)` call).
    const first = vault.collection<Invoice>('invoices', {
      i18nFields: { memo: i18nText({ languages: ['en', 'th'], required: 'any' }) },
    })

    // Second declaration on the SAME name: money declared via the public
    // `viaFields: { total: via(money(...)) }` spelling — must reconcile onto
    // the existing instance exactly like the `moneyFields` sugar key does.
    const second = vault.collection<Invoice>('invoices', {
      viaFields: { total: via(money({ currency: 'EUR', scale: 2 })) },
    })

    expect(second).toBe(first)

    // describe() surfaces money metadata only when the via pipeline actually
    // compiled a money binding for `total` — the discriminating assertion
    // that the reconcile fired (not just that a pre-canonical value round-tripped).
    expect(second.describe().fields.some((f) => f.key === 'total' && 'money' in f)).toBe(true)

    // Un-canonical numeric input: only a compiled money binding quantizes
    // `10.5` up to the fixed 2-decimal-scale string `'10.50'` on write.
    await second.put('i1', { id: 'i1', total: 10.5, memo: { en: 'Hello', th: 'สวัสดี' } })

    const raw = await second.get('i1', { locale: 'raw' })
    expect(raw?.total).toBe('10.50')
  })

  it('#627 parity: viaFields-style late-attach and moneyFields-style late-attach produce identical describe()/read output', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: 'binding-order-reconcile-2026-pilot3-parity' })
    const sugarVault = await db.openVault('sugar')
    const viaVault = await db.openVault('via')

    const sugarFirst = sugarVault.collection<Invoice>('invoices', {})
    const sugarSecond = sugarVault.collection<Invoice>('invoices', {
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const viaFirst = viaVault.collection<Invoice>('invoices', {})
    const viaSecond = viaVault.collection<Invoice>('invoices', {
      viaFields: { total: via(money({ currency: 'EUR', scale: 2 })) },
    })

    expect(sugarSecond).toBe(sugarFirst)
    expect(viaSecond).toBe(viaFirst)
    expect(viaSecond.describe()).toEqual(sugarSecond.describe())

    await sugarSecond.put('a', { id: 'a', total: 123.45, memo: {} })
    await viaSecond.put('a', { id: 'a', total: 123.45, memo: {} })
    expect(await viaSecond.get('a')).toEqual(await sugarSecond.get('a'))
  })
})
