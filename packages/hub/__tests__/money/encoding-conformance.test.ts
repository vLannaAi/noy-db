import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, withGuard, withMaterializedView, withDerivation, withOverlayedView, money, sum } from '../../src/index.js'
import { withAggregate } from '../../src/aggregate/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

// #335 — ONE canonical money encoding at every extension point. This is
// the conformance sweep: a single record with totalPaid = 10000 THB is
// pushed through every user-facing surface, and every one of them must
// observe the identical canonical decimal string. The stored scaled-int
// ('1000000') never escapes storage.

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
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
        if (vname === v) { out[cname] = out[cname] ?? {}; out[cname][id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c])) { data.set(k(v, c, i), payload[c][i]) }
      }
    },
  }
}

interface Cert extends Record<string, unknown> {
  id: string
  entity: string
  totalPaid: number | string
  sentAt: string | null
}

const CANONICAL = '10000.00'

describe('money encoding conformance — every extension point sees the same canonical value (#335)', () => {
  it('sweeps get / list / query / filter / scan / guards / MV map / computed / derivation', async () => {
    const observed: Record<string, unknown> = {}

    const guard = withGuard<Cert>({
      collection: 'certs',
      check: (incoming, ctx) => {
        const existing = ctx.existing as Cert | null
        if (existing) {
          observed['guard.incoming'] = incoming.totalPaid
          observed['guard.existing'] = existing.totalPaid
        }
      },
      onDelete: (existing) => { observed['guard.onDelete'] = existing.totalPaid },
    })

    const mv = withMaterializedView<Record<string, unknown>>({
      name: 'certTotals',
      unionSources: [
        {
          collection: 'certs',
          map: r => {
            const c = r as unknown as Cert
            observed['mv.map'] = c.totalPaid
            return { entity: c.entity, paid: Number(c.totalPaid), rows: 0 }
          },
        },
      ],
      groupBy: 'entity',
      aggregate: { paid: sum('paid') },
      rowKey: row => String(row.entity),
      refresh: 'eager',
    })

    const derivation = withDerivation<Cert, { receipt: Record<string, unknown> }>({
      source: 'certs',
      deterministic: true,
      outputs: { receipt: { shape: 'record', collection: 'cert-receipts' } },
      derive: (s) => {
        observed['derivation.source'] = s.totalPaid
        return { receipt: { certId: s.id, amount: s.totalPaid } }
      },
      lifecycle: 'eager',
    })

    const db = await createNoydb({
      store: memory(), user: 'alice',
      secret: 'money-conformance-passphrase-2026',
      guardStrategies: [guard],
      materializedViewStrategies: [mv],
      derivationStrategies: [derivation],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    const col = vault.collection<Cert>('certs', {
      schema: z.object({
        id: z.string(), entity: z.string(),
        totalPaid: z.union([z.number(), z.string()]), sentAt: z.string().nullable(),
        note: z.string().optional(),
      }),
      moneyFields: { totalPaid: money({ currency: 'THB', scale: 2 }) },
      computed: {
        note: (r) => {
          observed['computed'] = (r as Cert).totalPaid
          return 'computed-ran'
        },
      },
    })

    await col.put('c1', { id: 'c1', entity: 'e1', totalPaid: 10000, sentAt: null })

    // read surfaces
    observed['get'] = ((await col.get('c1')) as Cert).totalPaid
    observed['list'] = ((await col.list()) as Cert[])[0]!.totalPaid
    observed['query.toArray'] = (col.query().toArray() as Cert[])[0]!.totalPaid

    // user-callback clauses — filter must see the DECODED view
    const filtered = col.query().filter(r => {
      observed['query.filter'] = (r as Cert).totalPaid
      return true
    }).toArray()
    expect(filtered).toHaveLength(1)

    for await (const r of col.scan().filter(rec => {
      observed['scan.filter'] = (rec as Cert).totalPaid
      return true
    })) {
      observed['scan.yield'] = (r as Cert).totalPaid
    }

    // guard ctx (update with a spread-from-read), then delete for onDelete
    const read = (await col.get('c1')) as Cert
    await col.put('c1', { ...read, sentAt: '2026-06-12T00:00:00Z' })
    await col.delete('c1')

    expect(observed).toEqual({
      'get': CANONICAL,
      'list': CANONICAL,
      'query.toArray': CANONICAL,
      'query.filter': CANONICAL,
      'scan.filter': CANONICAL,
      'scan.yield': CANONICAL,
      'guard.incoming': CANONICAL,
      'guard.existing': CANONICAL,
      'guard.onDelete': CANONICAL,
      'mv.map': CANONICAL, // decoded since pre.13 (#322)
      'computed': CANONICAL, // canonicalized at pipeline top (#335)
      'derivation.source': CANONICAL, // decoded at dispatch boundary (#335)
    })
  })

  it('overlay virtual collection reads return canonical money (base and overlay rows)', async () => {
    const overlay = withOverlayedView({
      name: 'certs-v',
      base: 'certs',
      overlay: 'certs-overlay',
      shadowField: 'dataStatus',
      shadowValue: 'override',
    })
    const db = await createNoydb({
      store: memory(), user: 'alice',
      secret: 'money-conformance-overlay-passphrase-2026',
      overlayedViewStrategies: [overlay],
    })
    const vault = await db.openVault('books')
    const moneyOpts = {
      schema: z.object({
        id: z.string(), entity: z.string(),
        totalPaid: z.union([z.number(), z.string()]),
        sentAt: z.string().nullable(), dataStatus: z.string().optional(),
      }),
      moneyFields: { totalPaid: money({ currency: 'THB', scale: 2 }) },
    }
    const base = vault.collection<Cert>('certs', moneyOpts)
    vault.collection<Cert>('certs-overlay', moneyOpts)

    await base.put('c1', { id: 'c1', entity: 'e1', totalPaid: 10000, sentAt: null })
    const virtual = vault.collection<Cert>('certs-v')
    expect(((await virtual.get('c1')) as Cert).totalPaid).toBe(CANONICAL)

    // Shadowed read: the overlay row wins and is decoded too.
    const overlayCol = vault.collection<Cert>('certs-overlay')
    await overlayCol.put('c1', { id: 'c1', entity: 'e1', totalPaid: 20000, sentAt: null, dataStatus: 'override' })
    expect(((await virtual.get('c1')) as Cert).totalPaid).toBe('20000.00')
    const listed = (await virtual.list()) as Cert[]
    expect(listed[0]!.totalPaid).toBe('20000.00')
  })

  it('where() + filter() compose: field clause in scaled space, callback sees decoded', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice',
      secret: 'money-conformance-compose-passphrase-2026',
    })
    const vault = await db.openVault('books')
    const col = vault.collection<Cert>('certs', {
      schema: z.object({
        id: z.string(), entity: z.string(),
        totalPaid: z.union([z.number(), z.string()]), sentAt: z.string().nullable(),
      }),
      moneyFields: { totalPaid: money({ currency: 'THB', scale: 2 }) },
    })
    await col.put('lo', { id: 'lo', entity: 'e', totalPaid: 50, sentAt: null })
    await col.put('hi', { id: 'hi', entity: 'e', totalPaid: 10000, sentAt: null })

    const out = col.query()
      .where('totalPaid', '>', 100) // major units, evaluated in scaled space
      .filter(r => (r as Cert).totalPaid === CANONICAL) // decoded view
      .toArray() as Cert[]
    expect(out.map(r => r.id)).toEqual(['hi'])
  })
})
