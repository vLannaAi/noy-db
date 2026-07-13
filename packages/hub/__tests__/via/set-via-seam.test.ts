/**
 * #666 — `Collection._setVia` writer seam: the typed replacement for
 * `via-graph-wiring.ts`'s untyped `coll as { via; codec: { setVia } }` cast.
 *
 * Contract: `_setVia(pipeline)` must do BOTH of the cast site's two old
 * steps — reassign the live `this.via` AND resync `this.codec`'s own
 * captured `via` reference (`RecordCodec.setVia`) — or the codec's at-rest
 * hooks (`hasAtRestHooks`/`encodeAtRest`/`decodeAtRest`) keep reading a
 * stale pre-setVia pipeline: the codec holds its OWN `ctx.via`, not a live
 * view of `Collection.via` (`__tests__/via/codec-boundary.test.ts` documents
 * why). A put+get round trip is the only way to observe the codec half of
 * the contract — reading `coll._via` alone only proves the assignment half.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, SealedHandle } from '../../src/index.js'
import { ViaPipeline } from '../../src/kernel/via-pipeline.js'
import { taintBinding } from '../../src/kernel/via-taint-binding.js'
import { inlineMemory } from '../classified/harness.js'

interface Item extends Record<string, unknown> {
  id: string
  secret: string
  open: string
}

async function plainVault(secret: string) {
  const store = inlineMemory()
  const db = await createNoydb({ store, user: 'a', secret })
  const v = await db.openVault('v1')
  const c = v.collection<Item>('items')
  return { c }
}

describe('Collection._setVia writer seam (#666)', () => {
  it('a freshly-opened plain collection has no via pipeline', async () => {
    const { c } = await plainVault('setvia-0')
    expect(c._via).toBeUndefined()
  })

  it('assigns the pipeline AND resyncs the codec — a sealed field round-trips as a SealedHandle', async () => {
    const { c } = await plainVault('setvia-1')
    const pipeline = ViaPipeline.build([taintBinding(new Set(['secret']))])!
    expect(pipeline.hasAtRestHooks).toBe(true)

    c._setVia(pipeline)

    // (a) the assignment itself, observable via the existing `_via` getter.
    expect(c._via).toBe(pipeline)

    // (b) the codec resync — observable ONLY through at-rest behavior: put +
    // get must actually seal `secret`, which requires the CODEC's own
    // `ctx.via` (not just `Collection.via`) to see the new pipeline.
    await c.put('r1', { id: 'r1', secret: 'hunter2', open: 'visible' })
    const rec = await c.get('r1')
    expect(rec?.secret).toBeInstanceOf(SealedHandle)
    expect(rec?.open).toBe('visible')
    await expect((rec?.secret as unknown as SealedHandle<unknown>).reveal()).resolves.toBe('hunter2')
  })

  it('_setVia(undefined) clears the pipeline back off, codec included', async () => {
    const { c } = await plainVault('setvia-2')
    const pipeline = ViaPipeline.build([taintBinding(new Set(['secret']))])!
    c._setVia(pipeline)
    expect(c._via).toBe(pipeline)

    c._setVia(undefined)
    expect(c._via).toBeUndefined()

    // codec resynced too: a field the old pipeline would have sealed now
    // round-trips as a plain value.
    await c.put('r2', { id: 'r2', secret: 'nolongersealed', open: 'x' })
    const rec = await c.get('r2')
    expect(rec?.secret).toBe('nolongersealed')
  })
})
