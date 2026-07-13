/**
 * #629 Task 6 (review fix wave 1) — record `id` threaded through the
 * classified READ paths.
 *
 * Task 6 threaded `id` into every `RecordCodec.encryptRecord` call site (the
 * write side) but missed several `decryptRecord` call sites in
 * `collection.ts` (the read side). Any sealed classified collection (a
 * recoverable field, e.g. `classified.creditCard()`) hits
 * `RecordCodec.decryptRecord`'s explicit "caller bug" throw
 * (`record-codec.ts`, the `hasAtRestHooks && opts.id === undefined` guard) on
 * every un-threaded read path — this suite proves each one round-trips
 * instead of throwing.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { memoryStore } from '../../src/kernel/memory-store.js'
import { classified } from '../../src/via/classified/presets.js'
import { SealedHandle } from '../../src/kernel/types.js'
import { withHistory } from '../../src/with-commit/history/index.js'
import { inlineMemory } from './harness.js'
import type { GatePutEvent } from '../../src/port/with/service-bus.js'

const PAN_1 = '4242424242424242'
const PAN_2 = '4000056655665556'
const PAN_3 = '4111111111111111'

describe('#629 Task 6 fix wave 1 — classified read-path id threading', () => {
  it('listPage() fallback path (adapter with no native listPage) round-trips a sealed classified record', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-rd-1' })
    const v = await db.openVault('v1')
    const c = v.collection('cards', { classifiedFields: { card: classified.creditCard({ pan: 'pan' }) } })
    await c.put('r1', { pan: PAN_1, name: 'Nok' })

    const { items } = await c.listPage()

    expect(items).toHaveLength(1)
    const record = items[0] as Record<string, unknown>
    expect(record.name).toBe('Nok')
    expect(record.pan).toBeInstanceOf(SealedHandle)
    await expect((record.pan as SealedHandle<unknown>).reveal()).resolves.toBe(PAN_1)
    await db.close()
  })

  it('scan() (native adapter listPage → decryptPage) round-trips a sealed classified record', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'a', secret: 'pw-rd-2' })
    const v = await db.openVault('v2')
    const c = v.collection('cards', { classifiedFields: { card: classified.creditCard({ pan: 'pan' }) } })
    await c.put('r1', { pan: PAN_1, name: 'Nok' })

    const out: Record<string, unknown>[] = []
    for await (const rec of c.scan()) out.push(rec as Record<string, unknown>)

    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('Nok')
    expect(out[0]!.pan).toBeInstanceOf(SealedHandle)
    await expect((out[0]!.pan as SealedHandle<unknown>).reveal()).resolves.toBe(PAN_1)
    await db.close()
  })

  it('history() decrypts every version of a sealed classified record after an update', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-rd-3', historyStrategy: withHistory() })
    const v = await db.openVault('v3')
    const c = v.collection('cards', { classifiedFields: { card: classified.creditCard({ pan: 'pan' }) } })
    await c.put('r1', { pan: PAN_1, name: 'Nok' })
    await c.put('r1', { pan: PAN_2, name: 'Nok' })
    await c.put('r1', { pan: PAN_3, name: 'Nok' })

    const entries = await c.history('r1')

    expect(entries.length).toBeGreaterThanOrEqual(2)
    const pans = entries.map((e) => (e.record as Record<string, unknown>).pan)
    expect(pans).toContain(PAN_1)
    expect(pans).toContain(PAN_2)
    await db.close()
  })

  it('getVersion() reads a past version of a sealed classified record', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-rd-4', historyStrategy: withHistory() })
    const v = await db.openVault('v4')
    const c = v.collection('cards', { classifiedFields: { card: classified.creditCard({ pan: 'pan' }) } })
    await c.put('r1', { pan: PAN_1, name: 'Nok' })
    await c.put('r1', { pan: PAN_2, name: 'Nok' })

    const v1 = await c.getVersion('r1', 1)

    expect((v1 as Record<string, unknown> | null)?.pan).toBe(PAN_1)
    await db.close()
  })

  it('a beforePut gate handler sees the decrypted PRIOR of a sealed classified record (resolveGatePrior)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', secret: 'pw-rd-5' })
    const v = await db.openVault('v5')
    const c = v.collection('cards', { classifiedFields: { card: classified.creditCard({ pan: 'pan' }) } })
    await c.put('r1', { pan: PAN_1, name: 'Nok' })

    const seen: GatePutEvent[] = []
    db._subsystemBus.registerGate('beforePut', (e) => { seen.push(e) })
    await c.put('r1', { pan: PAN_2, name: 'Nok' })

    expect(seen).toHaveLength(1)
    // Pre-fix: resolveGatePrior's un-threaded decryptRecord throws, the
    // throw is swallowed by its try/catch, and `existing` silently degrades
    // to null instead of surfacing the prior record.
    expect(seen[0]!.existing).not.toBeNull()
    expect((seen[0]!.existing as Record<string, unknown>).pan).toBe(PAN_1)
    await db.close()
  })
})
