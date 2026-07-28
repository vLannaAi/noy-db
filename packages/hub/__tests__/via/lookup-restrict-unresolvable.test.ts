/**
 * #654 policy — the two remaining vault-facade silent-skip sites (spec §2 / seam-map-
 * consolidation.md Part 2d, Part 7 surprise 3). A `restrict` edge whose live compare-key
 * resolve fails (matrix custom-key row unreadable — corruption class) previously silently
 * `continue`d past the check, letting the delete/forget through unchecked. The ordinary-delete
 * propagation path (`applyLookupRefsPropagation`) previously bare-`continue`d on the same
 * failure with no report channel at all. Controller-ruled policy: restrict fails CLOSED
 * (`RestrictRefUnresolvableError`); propagation residue-reports via a `lookup:propagation-
 * residue` event (mirroring the forget path's `ForgetResult.lookupReferencesResidue` channel,
 * which is untouched by this task).
 *
 * RED (pre-Task-4): the restrict-direction assertions fail because nothing throws — the corrupt
 * row deletes/forgets silently. The propagation-direction assertion fails because no
 * `lookup:propagation-residue` event ever fires.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withForget } from '../../src/with-audit/forget/index.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { lookup } from '../../src/via/lookup/descriptor.js'
import { DictKeyInUseError, RestrictRefUnresolvableError, ConflictError } from '../../src/kernel/errors.js'
import type { Noydb } from '../../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

// Same in-memory store shape as lookup-direct-read-key.test.ts / lookup-ref-semantics.test.ts.
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) {
        const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r
      }
      return s
    },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

async function freshDb(name: string): Promise<Noydb> {
  return createNoydb({ store: toMemory(), user: 'a', secret: `lookup-restrict-unresolvable-${name}-2026` })
}

interface CountryRow extends Record<string, unknown> { id: string; iso2?: string; subjectId?: string; name: string }
interface OrderRow extends Record<string, unknown> { id: string; country: string }

describe('restrict direction: unresolvable compare-key fails closed (#654)', () => {
  it('ordinary delete of a corrupt backing row (missing iso2) REFUSES with RestrictRefUnresolvableError naming orders.country', async () => {
    const db = await freshDb('restrict-delete')
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    vault.collection<OrderRow>('orders', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'restrict' }) },
    })
    // Corrupt: no `iso2` field at all — the restrict edge's compare-key cannot be resolved.
    await countries.put('row-broken', { id: 'row-broken', name: 'Nowhere' })

    let caught: unknown
    try {
      await countries.delete('row-broken')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RestrictRefUnresolvableError)
    const err = caught as RestrictRefUnresolvableError
    expect(err.dimension).toBe('countries')
    expect(err.key).toBe('row-broken')
    expect(err.referencing).toBe('orders.country')

    // Fail-closed — the delete never went through.
    expect(await countries.get('row-broken')).not.toBeNull()
  })

  it('forget() of a corrupt backing row (missing iso2) REFUSES with RestrictRefUnresolvableError before any shred', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'a', secret: 'lookup-restrict-unresolvable-forget-2026',
      forgetStrategy: withForget({ subjects: { countries: 'subjectId' } }),
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    vault.collection<OrderRow>('orders', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'restrict' }) },
    })
    await countries.put('row-broken', { id: 'row-broken', subjectId: 'subj-1', name: 'Nowhere' })

    await expect(vault.forget('subj-1')).rejects.toThrow(RestrictRefUnresolvableError)

    // Refused BEFORE any shred.
    expect(await countries.get('row-broken')).not.toBeNull()
  })

  it('a RESOLVABLE restrict edge still throws DictKeyInUseError when a referencer exists (no regression)', async () => {
    const db = await freshDb('restrict-resolvable-in-use')
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    const orders = vault.collection<OrderRow>('orders', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'restrict' }) },
    })
    await countries.put('row-US', { id: 'row-US', iso2: 'US', name: 'United States' })
    await orders.put('o1', { id: 'o1', country: 'US' })

    await expect(countries.delete('row-US')).rejects.toThrow(DictKeyInUseError)
    expect(await countries.get('row-US')).not.toBeNull()
  })

  it('a RESOLVABLE restrict edge still SUCCEEDS when no referencer exists (no regression)', async () => {
    const db = await freshDb('restrict-resolvable-unused')
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    vault.collection<OrderRow>('orders', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'restrict' }) },
    })
    await countries.put('row-FR', { id: 'row-FR', iso2: 'FR', name: 'France' })

    await expect(countries.delete('row-FR')).resolves.not.toThrow()
    expect(await countries.get('row-FR')).toBeNull()
  })
})

describe('propagation direction: unresolvable compare-key residue-reports, never silent (#654)', () => {
  it('ordinary delete of a corrupt backing row (missing iso2) proceeds and emits lookup:propagation-residue for the un-propagated cascade edge', async () => {
    const db = await freshDb('propagation-cascade-unresolvable')
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    vault.collection<OrderRow>('orders', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'cascade' }) },
    })
    await countries.put('row-broken', { id: 'row-broken', name: 'Nowhere' })

    const events: Array<{ vault: string; dimension: string; key: string; residue: readonly string[] }> = []
    db.on('lookup:propagation-residue', (e) => events.push(e))

    await expect(countries.delete('row-broken')).resolves.not.toThrow()

    // Never silent.
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      vault: 'v',
      dimension: 'countries',
      key: 'row-broken',
      residue: ['countries:row-broken:orders.country'],
    })
  })

  it('a RESOLVABLE cascade edge still propagates and counts (no regression)', async () => {
    const db = await freshDb('propagation-cascade-resolvable')
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    const orders = vault.collection<OrderRow>('orders', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'cascade' }) },
    })
    await countries.put('row-US', { id: 'row-US', iso2: 'US', name: 'United States' })
    await orders.put('o1', { id: 'o1', country: 'US' })

    const events: unknown[] = []
    db.on('lookup:propagation-residue', (e) => events.push(e))

    await countries.delete('row-US')

    expect(await orders.get('o1')).toBeNull()
    expect(events).toHaveLength(0)
  })

  it('a RESOLVABLE nullify edge still propagates and counts (no regression)', async () => {
    const db = await freshDb('propagation-nullify-resolvable')
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    const orders = vault.collection<OrderRow>('orders', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'nullify' }) },
    })
    await countries.put('row-US', { id: 'row-US', iso2: 'US', name: 'United States' })
    await orders.put('o1', { id: 'o1', country: 'US' })

    await countries.delete('row-US')

    const after = await orders.get('o1') as OrderRow | null
    expect(after?.country).toBeNull()
  })
})
