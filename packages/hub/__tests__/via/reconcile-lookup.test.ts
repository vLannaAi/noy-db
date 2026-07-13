/**
 * #664 Part 2b — the lookup()/enumOf()/dict() late-attach reconcile machinery, tier-scoped.
 * Pre-#664, `lookupFields` on a SECOND-OR-LATER `vault.collection()` call was silently ignored —
 * only the fresh-construction branch ever wired it (no `_applyLookupFields` existed). `via-
 * reconcile.ts`'s `reconcileLookupFields` closes that gap:
 *
 *  - enum (`backing:'static'`, no `table`) / static (`+table`) — self-contained, clean attach.
 *  - reserved (`dict()`) — additionally wires the SAME vault registries (`dictKeyFieldRegistry`/
 *    `reservedLookupCollections`) the fresh path populates.
 *  - matrix (`backing:'collection'`) — refuses with a `ValidationError` unless the backing
 *    collection is already open (this vault session) AND prefetch-enabled.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { i18nText } from '../../src/via/i18n/core.js'
import { staticDict } from '../../src/via/i18n/dictionary.js'
import { lookup, enumOf, dict } from '../../src/via/lookup/descriptor.js'
import { money } from '../../src/via/money/descriptor.js'
import { UnknownLookupKeyError, UnknownDictCodeError, DictKeyInUseError, ValidationError } from '../../src/kernel/errors.js'
import { inlineMemory } from '../classified/harness.js'

interface Order extends Record<string, unknown> { id: string; status: string }
interface Country extends Record<string, unknown> { id: string; name: string }
interface Traveler extends Record<string, unknown> { id: string; country: string }
interface Item extends Record<string, unknown> { id: string; amount: number }
interface Ticket extends Record<string, unknown> { id: string; memo?: Record<string, string>; status?: string; category?: string }

const CIVIL_STATUS = { single: { en: 'Single', th: 'โสด' }, married: { en: 'Married', th: 'สมรส' } } as const

const STATUS_TABLE = { paid: { en: 'Paid' }, due: { en: 'Due' } } as const

describe('#664 Part 2b — enum/static tier lookup late-attach reconcile', () => {
  it('bare enumOf(): closed-vocab refusal activates post-attach; a declared key still passes', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-enum-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('v1')

    const first = vault.collection<Order>('tickets', {})
    await first.put('t0', { id: 't0', status: 'anything-goes' }) // pre-attach: unenforced

    const second = vault.collection<Order>('tickets', {
      lookupFields: { status: enumOf(['open', 'closed']) },
    })
    expect(second).toBe(first)

    await expect(second.put('t1', { id: 't1', status: 'bogus' })).rejects.toThrow(UnknownLookupKeyError)
    await expect(second.put('t2', { id: 't2', status: 'open' })).resolves.not.toThrow()
  })

  it('static tier (table-bearing): closed-vocab refusal, altKeys normalize, and <field>Label dresses on read — all live post-attach', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-static-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('v2', { locale: 'en' })

    const first = vault.collection<Order>('orders', {})
    await first.put('o0', { id: 'o0', status: 'whatever' }) // pre-attach: unenforced, no Label

    const second = vault.collection<Order>('orders', {
      lookupFields: {
        status: lookup('billingStatus', { backing: 'static', table: STATUS_TABLE, altKeys: ['en'], vocabulary: 'closed' }),
      },
    })
    expect(second).toBe(first)

    // altKeys normalize: the English label text 'Paid' is a declared altKey candidate for 'paid'.
    await second.put('o1', { id: 'o1', status: 'Paid' })
    const stored1 = await second._getStoredRecord('o1')
    expect(stored1?.status).toBe('paid')

    // closed-vocab refusal is live post-attach.
    await expect(second.put('o2', { id: 'o2', status: 'unknown-code' })).rejects.toThrow(UnknownLookupKeyError)

    // <field>Label dresses on read.
    const o1 = await second.get('o1', { locale: 'en' })
    expect(o1?.['statusLabel']).toBe('Paid')
  })
})

describe('#664 Part 2b — reserved (dict) tier lookup late-attach reconcile', () => {
  it('closed-vocab refusal + <field>Label dressing activate post-attach; reservedLookupCollections registry is updated', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-dict-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('v3', { locale: 'en' })
    await vault.dictionary('billing-status').put('paid', { en: 'Paid' })

    const first = vault.collection<Order>('invoices', {})
    await first.put('i0', { id: 'i0', status: 'anything-goes' }) // pre-attach: unenforced

    const second = vault.collection<Order>('invoices', {
      lookupFields: { status: dict('billing-status', { vocabulary: 'closed' }) },
    })
    expect(second).toBe(first)

    // Registry pin (per the brief's escape hatch — a full two-instance sync test is
    // disproportionate here; this asserts the SAME `reservedLookupCollections` registry the sync
    // engine's `_reservedLookupCollectionNames()` reads was populated by the late-attach, not just
    // by fresh construction).
    expect(vault._reservedLookupCollectionNames()).toContain('_dict_billing-status')

    // closed-vocab refusal is live post-attach.
    await expect(second.put('i1', { id: 'i1', status: 'not-a-key' })).rejects.toThrow(UnknownLookupKeyError)

    // A valid write dresses <field>Label on read.
    await second.put('i2', { id: 'i2', status: 'paid' })
    const i2 = await second.get('i2', { locale: 'en' })
    expect(i2?.['statusLabel']).toBe('Paid')
  })

  it('dictKeyFieldRegistry is populated by the late-attach — proven via LookupHandle.rename()\'s referencing-record rewrite (choke-point participation)', async () => {
    // Open vocabulary here (dict()'s default) — a CLOSED field's rename interacts with
    // LookupHandle.rename()'s own cache-update ordering (the new key's write-through cache entry
    // lands AFTER the referencing-record rewrite step) independently of #664; open vocabulary
    // isolates the one thing this test is proving — that the late-attach wired
    // `dictKeyFieldRegistry`, the registry `findAndUpdateReferences`/`updateReferencingRecords`
    // reads to find which collections reference this dictionary.
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-dict-2', i18nStrategy: withI18n() })
    const vault = await db.openVault('v3b')
    await vault.dictionary('billing-status-2').put('paid', { en: 'Paid' })

    const first = vault.collection<Order>('invoices2', {})
    const second = vault.collection<Order>('invoices2', {
      lookupFields: { status: dict('billing-status-2') },
    })
    expect(second).toBe(first)
    await second.put('i1', { id: 'i1', status: 'paid' })

    // If the late-attach had silently skipped `dictKeyFieldRegistry`, "invoices2" would not be
    // among the collections `updateReferencingRecords` scans, and i1's status would stay 'paid'.
    await vault.dictionary('billing-status-2').rename('paid', 'paid-v2')
    const i1After = await second.get('i1')
    expect(i1After?.status).toBe('paid-v2')
  })
})

describe('#664 Part 2b — matrix (collection) tier lookup late-attach reconcile', () => {
  it('refuses with a ValidationError naming the field/dimension/remedy when the backing dimension is not open', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-matrix-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('v4')
    vault.collection<Traveler>('travelers', {})

    expect(() => vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries') },
    })).toThrow(ValidationError)
    expect(() => vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries') },
    })).toThrow(/matrix field "country".*dimension "countries".*not open/)
  })

  it('refuses with a ValidationError naming the remedy when the backing dimension is open but lazy (prefetch:false)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-matrix-2', i18nStrategy: withI18n() })
    const vault = await db.openVault('v5')
    vault.collection<Country>('countries', { prefetch: false, cache: { maxRecords: 10 } })
    vault.collection<Traveler>('travelers', {})

    expect(() => vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries') },
    })).toThrow(ValidationError)
    expect(() => vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries') },
    })).toThrow(/lazy mode/)
  })

  it('succeeds when the backing dimension is already open and prefetch-enabled — closed-vocab refusal + <field>Label dressing activate post-attach', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-matrix-3', i18nStrategy: withI18n() })
    const vault = await db.openVault('v6', { locale: 'en' })
    const countries = vault.collection<Country>('countries', {})
    await countries.put('US', { id: 'US', name: 'United States' })

    const first = vault.collection<Traveler>('travelers', {})
    await first.put('t0', { id: 't0', country: 'anything-goes' }) // pre-attach: unenforced

    const second = vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries', { present: { label: 'name' }, vocabulary: 'closed' }) },
    })
    expect(second).toBe(first)

    await expect(second.put('t1', { id: 't1', country: 'ZZ' })).rejects.toThrow(UnknownLookupKeyError)

    await second.put('t2', { id: 't2', country: 'US' })
    const t2 = await second.get('t2', { locale: 'en' })
    expect(t2?.['countryLabel']).toBe('United States')
  })
})

describe('#664 Part 2b — graph ref edges are live immediately post-attach (ViaGraph.referencingEdgesOf)', () => {
  it('matrix tier, restrict (default): deleting a referenced backing row throws DictKeyInUseError post-attach', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-edges-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('v7')
    const countries = vault.collection<Country>('countries', {})
    await countries.put('US', { id: 'US', name: 'United States' })

    const travelers = vault.collection<Traveler>('travelers', {})
    await travelers.put('t0', { id: 't0', country: 'unrelated' })

    // Late-attach — the ref edge (travelers.country -> countries.*) must be registered NOW,
    // not just at fresh construction.
    vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries') }, // default onDelete: 'restrict'
    })
    await travelers.put('t1', { id: 't1', country: 'US' })

    await expect(countries.delete('US')).rejects.toThrow(DictKeyInUseError)
    await travelers.delete('t1')
    await expect(countries.delete('US')).resolves.not.toThrow()
  })

  it('reserved tier, cascade: deleting the dictionary row tombstones the referencing record post-attach', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-edges-2', i18nStrategy: withI18n() })
    const vault = await db.openVault('v8')
    await vault.dictionary('status-cascade').put('paid', { en: 'Paid' })

    const orders = vault.collection<Order>('orders-cascade', {})
    await orders.put('o0', { id: 'o0', status: 'unrelated' })

    vault.collection<Order>('orders-cascade', {
      lookupFields: { status: dict('status-cascade', { onDelete: 'cascade' }) },
    })
    await orders.put('o1', { id: 'o1', status: 'paid' })

    await vault.dictionary('status-cascade').delete('paid')

    expect(await orders.get('o1')).toBeNull()
  })
})

describe('#664 Part 2b — lookup late-attach respects the #664 collision guard automatically', () => {
  it('control: attaching a lookupFields entry onto a field already owned by money refuses', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-guard-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('v9')
    vault.collection<Item>('items', { moneyFields: { amount: money({ currency: 'USD' }) } })

    expect(() => vault.collection<Item>('items', {
      lookupFields: { amount: enumOf(['a', 'b']) },
    })).toThrow(ValidationError)
  })
})

describe('#664 Part 2b — first-wins: a second, later lookupFields call is a no-op', () => {
  it('the family attaches at most once — a differently-configured third call does not reattach', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-lookup-firstwins-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('v10')
    vault.collection<Order>('tasks', {})
    const second = vault.collection<Order>('tasks', {
      lookupFields: { status: enumOf(['open', 'closed']) },
    })
    expect(() => vault.collection<Order>('tasks', {
      lookupFields: { status: enumOf(['different', 'keys']) },
    })).not.toThrow()
    // The FIRST config won — 'open' (not a member of the third call's key set) still passes.
    await expect(second.put('t1', { id: 't1', status: 'open' })).resolves.not.toThrow()
  })
})

describe('t8r1 — combined single-call late-attach (i18n/dictKey + lookup on DIFFERENT fields): pins the separate-if dispatch', () => {
  // `reconcileViaAttach` (via/reconcile.ts) dispatches i18n/dictKey and lookup through two
  // SEPARATE `if` statements, deliberately not chained as an else-if (see its own doc comment) —
  // because a single vault.collection() call may legally declare i18nFields/dictKeyFields on one
  // field AND lookupFields on a DIFFERENT field in the SAME call. A future collapse onto a shared
  // else-if ladder would silently drop whichever half runs second — these tests exercise BOTH
  // halves activating from ONE call, so such a regression fails loudly.
  it('(i) i18nFields (field A: memo) + lookupFields (field B: status) in ONE late-attach call: BOTH function afterward', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-t8r1-i18n-lookup-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('t8r1-a', { locale: 'en' })

    const first = vault.collection<Ticket>('tickets-combo', {})
    await first.put('t0', { id: 't0', memo: { en: 'pre' }, status: 'anything-goes' }) // pre-attach: unenforced

    const second = vault.collection<Ticket>('tickets-combo', {
      i18nFields: { memo: i18nText({ languages: ['en', 'th'], required: 'any' }) },
      lookupFields: { status: enumOf(['open', 'closed']) },
    })
    expect(second).toBe(first)

    // i18n half: memo resolves per-locale on a NEW write.
    await second.put('t1', { id: 't1', memo: { en: 'Hello', th: 'สวัสดี' }, status: 'open' })
    const t1 = await second.get('t1', { locale: 'th' })
    expect(t1?.memo).toBe('สวัสดี')

    // lookup half: status vocabulary enforces on a NEW write.
    await expect(second.put('t2', { id: 't2', memo: { en: 'x' }, status: 'bogus' })).rejects.toThrow(UnknownLookupKeyError)
    await expect(second.put('t3', { id: 't3', memo: { en: 'x' }, status: 'closed' })).resolves.not.toThrow()
  })

  it('(ii) dictKeyFields (field A: status) + lookupFields (field B: category) in ONE late-attach call: BOTH function afterward', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-t8r1-dictkey-lookup-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('t8r1-b', { locale: 'th' })

    const first = vault.collection<Ticket>('tickets-combo-2', {})
    await first.put('t0', { id: 't0', status: 'anything-goes', category: 'anything-goes' }) // pre-attach: unenforced

    const second = vault.collection<Ticket>('tickets-combo-2', {
      dictKeyFields: { status: staticDict('t8r1-civil-status', CIVIL_STATUS) },
      lookupFields: { category: enumOf(['bug', 'feature']) },
    })
    expect(second).toBe(first)

    // dictKey half: closed-vocab enforcement + <field>Label dressing.
    await expect(second.put('t1', { id: 't1', status: 'not-a-key', category: 'bug' })).rejects.toThrow(UnknownDictCodeError)
    await second.put('t2', { id: 't2', status: 'married', category: 'bug' })
    const t2 = await second.get('t2', { locale: 'th' })
    expect(t2?.['statusLabel']).toBe('สมรส')

    // lookup half: category vocabulary enforces.
    await expect(second.put('t3', { id: 't3', status: 'married', category: 'not-a-category' })).rejects.toThrow(UnknownLookupKeyError)
    await expect(second.put('t4', { id: 't4', status: 'married', category: 'feature' })).resolves.not.toThrow()
  })
})
