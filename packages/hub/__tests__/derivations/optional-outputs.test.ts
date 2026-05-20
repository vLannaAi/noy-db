import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, DerivationOutputShapeError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

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
        if (vname === v) {
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

interface Allocation extends Record<string, unknown> {
  id: string
  paymentId: string
  appliedAmount: number
  servicesNetPortion: number
}
interface Receipt extends Record<string, unknown> {
  id: string
  paymentId: string
  appliedAmount: number
}

describe('withDerivation — optional outputs (#144)', () => {
  it('omits the output entirely when derive returns null for an optional key', async () => {
    // RCT-TRIGGER-001: receipts only exist for services-touching allocations
    const strategy = withDerivation<Allocation, { receipt: Receipt }>({
      source: 'allocations',
      deterministic: true,
      outputs: { receipt: { shape: 'record', collection: 'receipts', optional: true } },
      derive: (alloc) => ({
        receipt: alloc.servicesNetPortion > 0
          ? { id: alloc.id, paymentId: alloc.paymentId, appliedAmount: alloc.appliedAmount }
          : null,
        // Type assertion: TS sees the union via the runtime branch above.
      }) as { receipt: Receipt | null },
      lifecycle: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-optional-outputs-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')

    // Services-touching → receipt emitted
    await v.collection<Allocation>('allocations').put('a1', {
      id: 'a1', paymentId: 'p1', appliedAmount: 500, servicesNetPortion: 400,
    })
    expect(await v.collection<Receipt>('receipts').get('a1')).toMatchObject({
      id: 'a1', appliedAmount: 500,
    })

    // Expense-only (servicesNetPortion === 0) → no receipt
    await v.collection<Allocation>('allocations').put('a2', {
      id: 'a2', paymentId: 'p1', appliedAmount: 100, servicesNetPortion: 0,
    })
    expect(await v.collection<Receipt>('receipts').get('a2')).toBeNull()
  })

  it('deletes a previously-emitted output when the next derivation returns null', async () => {
    const strategy = withDerivation<Allocation, { receipt: Receipt }>({
      source: 'allocations',
      deterministic: true,
      outputs: { receipt: { shape: 'record', collection: 'receipts', optional: true } },
      derive: (alloc) => ({
        receipt: alloc.servicesNetPortion > 0
          ? { id: alloc.id, paymentId: alloc.paymentId, appliedAmount: alloc.appliedAmount }
          : null,
      }) as { receipt: Receipt | null },
      lifecycle: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-optional-delete-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')

    // First put: emits receipt
    await v.collection<Allocation>('allocations').put('a1', {
      id: 'a1', paymentId: 'p1', appliedAmount: 500, servicesNetPortion: 400,
    })
    expect(await v.collection<Receipt>('receipts').get('a1')).not.toBeNull()

    // Update: flips to expense-only → receipt should be deleted
    await v.collection<Allocation>('allocations').put('a1', {
      id: 'a1', paymentId: 'p1', appliedAmount: 500, servicesNetPortion: 0,
    })
    expect(await v.collection<Receipt>('receipts').get('a1')).toBeNull()
  })

  it('returning null for a NON-optional output still throws DerivationOutputShapeError', async () => {
    interface Pdf extends Record<string, unknown> { id: string; body: string }
    interface PdfMeta extends Record<string, unknown> { len: number }
    const strategy = withDerivation<Pdf, { meta: PdfMeta }>({
      source: 'pdfs',
      deterministic: true,
      // optional NOT set — defaults to required
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => ({ meta: null as unknown as PdfMeta }),
      lifecycle: 'eager',
      strict: true,
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-required-null-rejects-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await expect(
      v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hello' }),
    ).rejects.toBeInstanceOf(DerivationOutputShapeError)
  })

  it('lazy lifecycle: skipped output reads as null + a prior emission is removed on re-resolve', async () => {
    const strategy = withDerivation<Allocation, { receipt: Receipt }>({
      source: 'allocations',
      deterministic: true,
      outputs: { receipt: { shape: 'record', collection: 'receipts', optional: true } },
      derive: (alloc) => ({
        receipt: alloc.servicesNetPortion > 0
          ? { id: alloc.id, paymentId: alloc.paymentId, appliedAmount: alloc.appliedAmount }
          : null,
      }) as { receipt: Receipt | null },
      lifecycle: 'lazy',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-optional-lazy-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')

    // Emission: services-touching
    await v.collection<Allocation>('allocations').put('a1', {
      id: 'a1', paymentId: 'p1', appliedAmount: 500, servicesNetPortion: 400,
    })
    expect(await v.collection<Receipt>('receipts').get('a1')).not.toBeNull()

    // Flip to skipped: lazy mode marks stale; re-derive on read should
    // delete the prior receipt.
    await v.collection<Allocation>('allocations').put('a1', {
      id: 'a1', paymentId: 'p1', appliedAmount: 500, servicesNetPortion: 0,
    })
    expect(await v.collection<Receipt>('receipts').get('a1')).toBeNull()
  })
})
