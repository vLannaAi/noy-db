/**
 * dumpSchema() — derivations, overlay views, and MV aggregate rendering.
 *
 * Covers the three introspection gaps from issue #295:
 *   1. derivations map comes back empty (DerivationRegistry lacks all())
 *   2. overlayViews map comes back empty (OverlayedViewRegistry lacks all())
 *   3. MV aggregate renders as "[object Object]" (reducers lack op/field metadata)
 */

import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/types.js'
import {
  createNoydb,
  withDerivation,
  withMaterializedView,
  withOverlayedView,
  sum,
  count,
} from '../src/index.js'
import { withAggregate } from '../src/aggregate/index.js'

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
        const parts = key.split('/')
        const vname = parts[0], cname = parts[1], id = parts[2]
        if (vname === v && cname && id) {
          out[cname] = out[cname] ?? {}
          out[cname][id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c])) {
          data.set(k(v, c, i), payload[c][i])
        }
      }
    },
  }
}

interface Invoice extends Record<string, unknown> {
  id: string
  amount: number
  status: string
}

interface InvoiceMeta extends Record<string, unknown> {
  id: string
  len: number
}

// ─── Gap 1: derivations ──────────────────────────────────────────────────────

describe('dumpSchema() — derivations (Gap 1)', () => {
  it('derivations map is non-empty after registering a derivation strategy', async () => {
    const handle = withDerivation({
      source: 'invoices',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'invoice-meta' } },
      derive: (s: Invoice) => ({ meta: { id: s.id, len: String(s.id).length } }),
      lifecycle: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'dumpschema-derivations-passphrase-2026',
      derivationStrategies: [handle],
    })
    const vault = await db.openVault('acme')

    // Write a record so the derivation fires (confirms end-to-end wiring)
    await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100, status: 'draft' })

    const snap = await vault.dumpSchema()

    // Gap 1 check: derivations must not be empty
    expect(Object.keys(snap.derivations)).not.toHaveLength(0)

    // The descriptor for the invoices derivation should have correct fields
    const entry = Object.values(snap.derivations)[0]
    expect(entry).toBeDefined()
    expect(entry!.source).toBe('invoices')
    expect(entry!.outputs).toContain('invoice-meta')
  })
})

// ─── Gap 2: overlay views ────────────────────────────────────────────────────

describe('dumpSchema() — overlay views (Gap 2)', () => {
  it('overlayViews map is non-empty after registering an overlay', async () => {
    const baseMV = withMaterializedView<Invoice>({
      name: 'invoices-base',
      sources: ['invoices'],
      query: (db) => db.collection<Invoice>('invoices').query(),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })

    const overlay = withOverlayedView({
      name: 'invoices-view',
      base: 'invoices-base',
      overlay: 'invoices-overrides',
      shadowField: 'status',
      shadowValue: 'override',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'dumpschema-overlay-passphrase-2026',
      materializedViewStrategies: [baseMV],
      overlayedViewStrategies: [overlay],
    })
    const vault = await db.openVault('acme')

    const snap = await vault.dumpSchema()

    // Gap 2 check: overlayViews must not be empty
    expect(Object.keys(snap.overlayViews)).not.toHaveLength(0)

    const entry = snap.overlayViews['invoices-view']
    expect(entry).toBeDefined()
    expect(entry!.base).toBe('invoices-base')
    expect(entry!.overlay).toBe('invoices-overrides')
  })
})

// ─── Gap 3: MV aggregate rendering ──────────────────────────────────────────

describe('dumpSchema() — MV aggregate ops (Gap 3)', () => {
  it('sum reducer renders as "sum(field)" not "[object Object]"', async () => {
    // Use UNION-form MV so that spec.aggregate is populated (the introspection
    // path reads spec.aggregate directly — query-form groupBy().aggregate()
    // embeds the spec in the query, not in the strategy).
    const mv = withMaterializedView<{ client_id: string; total: number }>({
      name: 'invoice-totals',
      unionSources: [
        {
          collection: 'invoices',
          map: (r: Record<string, unknown>) => ({
            client_id: r.client_id as string,
            total: r.amount as number,
          }),
        },
        {
          collection: 'credit-notes',
          map: (r: Record<string, unknown>) => ({
            client_id: r.client_id as string,
            total: -(r.amount as number),
          }),
        },
      ],
      groupBy: 'client_id',
      aggregate: { total: sum('total') },
      rowKey: (r) => r.client_id,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'dumpschema-aggregate-passphrase-2026',
      aggregateStrategy: withAggregate(),
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('acme')

    const snap = await vault.dumpSchema()
    const desc = snap.materializedViews['invoice-totals']
    expect(desc).toBeDefined()
    expect(desc!.aggregate).toBeDefined()
    // Gap 3 check: must be 'sum(total)', NOT '[object Object]'
    expect(desc!.aggregate!.total).toBe('sum(total)')
  })

  it('count reducer renders as "count"', async () => {
    const mv = withMaterializedView<{ client_id: string; n: number }>({
      name: 'invoice-counts',
      unionSources: [
        {
          collection: 'invoices',
          map: (r: Record<string, unknown>) => ({
            client_id: r.client_id as string,
            n: 1,
          }),
        },
        {
          collection: 'extras',
          map: (r: Record<string, unknown>) => ({
            client_id: r.client_id as string,
            n: 1,
          }),
        },
      ],
      groupBy: 'client_id',
      aggregate: { n: count() },
      rowKey: (r) => r.client_id,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'dumpschema-count-passphrase-2026',
      aggregateStrategy: withAggregate(),
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('acme')

    const snap = await vault.dumpSchema()
    const desc = snap.materializedViews['invoice-counts']
    expect(desc).toBeDefined()
    expect(desc!.aggregate).toBeDefined()
    // Gap 3 check: must be 'count', NOT '[object Object]'
    expect(desc!.aggregate!.n).toBe('count')
  })
})
