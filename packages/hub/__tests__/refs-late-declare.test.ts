/**
 * #1141 — `refs` declared on an already-constructed collection.
 *
 * The declaration fan-out (`populateCollectionRegistries`) runs only on a cache
 * MISS, so before this fix any earlier touch of the collection silently discarded
 * a later `refs` declaration: strict FK enforcement never engaged and `.join()`
 * kept reporting "no ref() declared". Both halves are asserted here, because the
 * join half is the visible symptom and the enforcement half is the dangerous one.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ref, RefIntegrityError } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

function toMemory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, e) { data.set(k(v, c, i), e) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) { const p = `${v}/${c}/`; return [...data.keys()].filter(x => x.startsWith(p)).map(x => x.slice(p.length)) },
    async loadAll(v) {
      const o: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, e] of data) {
        const [vn, cn, id] = key.split('/') as [string, string, string]
        if (vn === v) { o[cn] = o[cn] ?? {}; o[cn][id] = e }
      }
      return o
    },
    async saveAll(v, p) { for (const c of Object.keys(p)) for (const i of Object.keys(p[c]!)) data.set(k(v, c, i), p[c]![i]!) },
  }
}

interface Entity extends Record<string, unknown> { id: string; name: string }
interface Bill extends Record<string, unknown> { id: string; entityId: string; amount: number }

async function openVault(): Promise<Awaited<ReturnType<Awaited<ReturnType<typeof createNoydb>>['openVault']>>> {
  const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'refs-late-declare-secret-2026' })
  return db.openVault('books')
}

describe('#1141 — refs declared after the collection was already constructed', () => {
  it('enforces a strict ref declared on a collection that was touched bare first', async () => {
    const vault = await openVault()
    vault.collection<Entity>('entities')
    vault.collection<Bill>('bills')                                            // early touch
    vault.collection<Bill>('bills', { refs: { entityId: ref('entities') } })   // declaration

    const bills = vault.collection<Bill>('bills')
    await expect(bills.put('b1', { id: 'b1', entityId: 'ghost', amount: 10 }))
      .rejects.toThrow(RefIntegrityError)

    // ...and the same declaration still admits a valid target.
    await vault.collection<Entity>('entities').put('e1', { id: 'e1', name: 'Entity One' })
    await bills.put('b2', { id: 'b2', entityId: 'e1', amount: 20 })
    expect(await bills.get('b2')).toMatchObject({ entityId: 'e1' })
  })

  it('resolves .join() through a late-declared ref', async () => {
    const vault = await openVault()
    vault.collection<Entity>('entities')
    vault.collection<Bill>('bills')
    vault.collection<Bill>('bills', { refs: { entityId: ref('entities') } })

    const entities = vault.collection<Entity>('entities')
    const bills = vault.collection<Bill>('bills')
    await entities.put('e1', { id: 'e1', name: 'Entity One' })
    await bills.put('b1', { id: 'b1', entityId: 'e1', amount: 100 })

    const rows = await bills.query().join('entityId', { as: 'entity' }).toArray()
    expect(rows).toHaveLength(1)
    expect((rows[0] as Record<string, unknown>).entity).toMatchObject({ id: 'e1', name: 'Entity One' })
  })

  it('surfaces the late-declared ref through describe()', async () => {
    const vault = await openVault()
    vault.collection<Entity>('entities')
    vault.collection<Bill>('bills')
    vault.collection<Bill>('bills', { refs: { entityId: ref('entities') } })

    const described = await vault.collection<Bill>('bills').describe()
    expect(described.fields.find(f => f.key === 'entityId')?.ref).toMatchObject({ target: 'entities', mode: 'strict' })
  })

  it('still refuses a CONFLICTING redeclaration — late attach does not loosen the rule', async () => {
    const vault = await openVault()
    vault.collection<Entity>('entities')
    vault.collection('others')
    vault.collection<Bill>('bills', { refs: { entityId: ref('entities') } })
    expect(() => vault.collection<Bill>('bills', { refs: { entityId: ref('others') } }))
      .toThrow(/conflicting ref declarations/)
  })

  it('an identical redeclaration is a no-op', async () => {
    const vault = await openVault()
    vault.collection<Entity>('entities')
    vault.collection<Bill>('bills', { refs: { entityId: ref('entities') } })
    expect(() => vault.collection<Bill>('bills', { refs: { entityId: ref('entities') } })).not.toThrow()
    const described = await vault.collection<Bill>('bills').describe()
    expect(described.fields.find(f => f.key === 'entityId')?.ref).toMatchObject({ target: 'entities' })
  })
})
