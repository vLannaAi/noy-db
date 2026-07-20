/**
 * #629 Task 2 — ViaPipeline phase-B hooks: `enforceWrite`/`encodeAtRest`/
 * `decodeAtRest`/`erase` fold across bindings the same way A's hooks do
 * (`pipeline.test.ts` is the template), plus `hasAtRestHooks` — the
 * async-stack detection getter `#629 Task 3`'s codec boundary consults to
 * choose between the hook path and today's inline sealed-slot path.
 */
import { describe, it, expect } from 'vitest'
import type { ViaBinding, ViaWriteCtx, ViaEraseCtx, ViaCryptoCtx, ViaPosture } from '../../src/kernel/via/index.js'
import { ViaPipeline } from '../../src/kernel/via/pipeline.js'
import { ValidationError } from '../../src/kernel/errors.js'

const posture = (): ViaPosture => ({ encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: true })

const writeCtxFixture = (): ViaWriteCtx => ({
  id: 'test-id',
  vault: 'test-vault',
  prior: async () => null,
  emit: () => {},
})

const eraseCtxFixture = (): ViaEraseCtx => ({
  id: 'test-id',
  vault: 'test-vault',
  live: undefined,
  crypto: cryptoFixture(),
})

function cryptoFixture(): ViaCryptoCtx {
  return {
    sealedSlots: {
      seal: async () => ({ iv: 'iv', data: 'data' }),
      unseal: async () => undefined,
      delete: async () => {},
    },
    reservedEnvelopes: () => ({
      encrypt: async () => {
        throw new Error('unused in this fixture')
      },
      decrypt: async () => {
        throw new Error('unused in this fixture')
      },
    }),
  }
}

describe('ViaPipeline.enforceWrite', () => {
  it('awaits each binding in order', async () => {
    const order: string[] = []
    const a: ViaBinding = { brand: 'a', posture: posture(), enforceWrite: async () => { order.push('a') } }
    const b: ViaBinding = { brand: 'b', posture: posture(), enforceWrite: async () => { order.push('b') } }
    const p = ViaPipeline.build([a, b])!

    await p.enforceWrite({}, writeCtxFixture())

    expect(order).toEqual(['a', 'b'])
  })

  it('first throw wins — later bindings never run', async () => {
    const order: string[] = []
    const a: ViaBinding = {
      brand: 'a',
      posture: posture(),
      enforceWrite: async () => {
        order.push('a')
        throw new ValidationError('a refuses')
      },
    }
    const b: ViaBinding = { brand: 'b', posture: posture(), enforceWrite: async () => { order.push('b') } }
    const p = ViaPipeline.build([a, b])!

    await expect(p.enforceWrite({}, writeCtxFixture())).rejects.toThrow('a refuses')
    expect(order).toEqual(['a'])
  })

  it('skips bindings without enforceWrite', async () => {
    const a: ViaBinding = { brand: 'a', posture: posture() }
    const p = ViaPipeline.build([a])!

    await expect(p.enforceWrite({}, writeCtxFixture())).resolves.toBeUndefined()
  })
})

describe('ViaPipeline.encodeAtRest', () => {
  it('folds the record and accumulates sealed maps across bindings', async () => {
    const a: ViaBinding = {
      brand: 'a',
      posture: posture(),
      encodeAtRest: async (r) => ({ record: { ...r, aTouched: true }, sealed: { fieldA: { iv: 'ivA', data: 'dataA' } } }),
    }
    const b: ViaBinding = {
      brand: 'b',
      posture: posture(),
      encodeAtRest: async (r) => ({ record: { ...r, bTouched: true }, sealed: { fieldB: { iv: 'ivB', data: 'dataB' } } }),
    }
    const p = ViaPipeline.build([a, b])!

    const result = await p.encodeAtRest({}, cryptoFixture())

    expect(result.record).toEqual({ aTouched: true, bTouched: true })
    expect(result.sealed).toEqual({
      fieldA: { iv: 'ivA', data: 'dataA' },
      fieldB: { iv: 'ivB', data: 'dataB' },
    })
  })

  it('a brand-keyed collision on the same sealed field throws', async () => {
    const a: ViaBinding = {
      brand: 'a',
      posture: posture(),
      encodeAtRest: async (r) => ({ record: r, sealed: { x: { iv: '1', data: '1' } } }),
    }
    const b: ViaBinding = {
      brand: 'b',
      posture: posture(),
      encodeAtRest: async (r) => ({ record: r, sealed: { x: { iv: '2', data: '2' } } }),
    }
    const p = ViaPipeline.build([a, b])!

    await expect(p.encodeAtRest({}, cryptoFixture())).rejects.toBeInstanceOf(ValidationError)
  })

  it('returns sealed undefined when no binding seals anything', async () => {
    const a: ViaBinding = { brand: 'a', posture: posture(), encodeAtRest: async (r) => ({ record: r }) }
    const p = ViaPipeline.build([a])!

    const result = await p.encodeAtRest({ foo: 'bar' }, cryptoFixture())

    expect(result).toEqual({ record: { foo: 'bar' } })
  })

  it('skips bindings without encodeAtRest, leaving the record untouched', async () => {
    const a: ViaBinding = { brand: 'a', posture: posture() }
    const p = ViaPipeline.build([a])!

    const result = await p.encodeAtRest({ foo: 'bar' }, cryptoFixture())

    expect(result).toEqual({ record: { foo: 'bar' } })
  })
})

describe('ViaPipeline.decodeAtRest', () => {
  it('folds in order', async () => {
    const a: ViaBinding = { brand: 'a', posture: posture(), decodeAtRest: async (r) => ({ ...r, aSeen: true }) }
    const b: ViaBinding = { brand: 'b', posture: posture(), decodeAtRest: async (r) => ({ ...r, bSeen: true }) }
    const p = ViaPipeline.build([a, b])!

    const result = await p.decodeAtRest({}, {}, cryptoFixture(), { asHandles: false })

    expect(result).toEqual({ aSeen: true, bSeen: true })
  })

  it('passes the sealed map and opts through to every binding', async () => {
    const seen: Array<{ sealed: unknown; asHandles: boolean }> = []
    const a: ViaBinding = {
      brand: 'a',
      posture: posture(),
      decodeAtRest: async (r, sealed, _crypto, opts) => {
        seen.push({ sealed, asHandles: opts.asHandles })
        return r
      },
    }
    const p = ViaPipeline.build([a])!
    const sealedMap = { x: { iv: 'iv', data: 'data' } }

    await p.decodeAtRest({}, sealedMap, cryptoFixture(), { asHandles: true })

    expect(seen).toEqual([{ sealed: sealedMap, asHandles: true }])
  })

  it('skips bindings without decodeAtRest', async () => {
    const a: ViaBinding = { brand: 'a', posture: posture() }
    const p = ViaPipeline.build([a])!

    const result = await p.decodeAtRest({ foo: 'bar' }, {}, cryptoFixture(), { asHandles: false })

    expect(result).toEqual({ foo: 'bar' })
  })
})

describe('ViaPipeline.erase', () => {
  it('runs every binding and concatenates reports', async () => {
    const a: ViaBinding = { brand: 'a', posture: posture(), erase: async () => ({ shredded: 1, residue: ['a-residue'] }) }
    const b: ViaBinding = { brand: 'b', posture: posture(), erase: async () => ({ shredded: 2, residue: ['b-residue'] }) }
    const p = ViaPipeline.build([a, b])!

    const result = await p.erase(eraseCtxFixture())

    expect(result).toEqual({ shredded: 3, residue: ['a-residue', 'b-residue'] })
  })

  it('skips bindings without erase', async () => {
    const a: ViaBinding = { brand: 'a', posture: posture() }
    const b: ViaBinding = { brand: 'b', posture: posture(), erase: async () => ({ shredded: 1, residue: [] }) }
    const p = ViaPipeline.build([a, b])!

    const result = await p.erase(eraseCtxFixture())

    expect(result).toEqual({ shredded: 1, residue: [] })
  })

  it('returns a zero report when no binding implements erase', async () => {
    const a: ViaBinding = { brand: 'a', posture: posture() }
    const p = ViaPipeline.build([a])!

    const result = await p.erase(eraseCtxFixture())

    expect(result).toEqual({ shredded: 0, residue: [] })
  })

  it('#629 Task 10 — skips a binding declaring forgettable: false even if it defines erase', async () => {
    const notForgettable: ViaBinding = {
      brand: 'a', posture: { ...posture(), forgettable: false }, erase: async () => ({ shredded: 9, residue: ['should-not-appear'] }),
    }
    const b: ViaBinding = { brand: 'b', posture: posture(), erase: async () => ({ shredded: 1, residue: [] }) }
    const p = ViaPipeline.build([notForgettable, b])!

    const result = await p.erase(eraseCtxFixture())

    expect(result).toEqual({ shredded: 1, residue: [] })
  })

  it('#629 Task 10 — sums retainedShared across bindings, present only when > 0', async () => {
    const a: ViaBinding = { brand: 'a', posture: posture(), erase: async () => ({ shredded: 1, residue: [], retainedShared: 2 }) }
    const b: ViaBinding = { brand: 'b', posture: posture(), erase: async () => ({ shredded: 1, residue: [], retainedShared: 3 }) }
    const p = ViaPipeline.build([a, b])!

    const result = await p.erase(eraseCtxFixture())

    expect(result).toEqual({ shredded: 2, residue: [], retainedShared: 5 })
  })
})

describe('ViaPipeline.eraseSealed (#629 Task 10 — forget()\'s sealed-posture-only fold)', () => {
  it('folds ONLY bindings whose posture is encryptedAtRest: "sealed", ignoring others', async () => {
    const sealed: ViaBinding = { brand: 'classified', posture: { ...posture(), encryptedAtRest: 'sealed' }, erase: async () => ({ shredded: 1, residue: ['sealed-residue'] }) }
    const notSealed: ViaBinding = { brand: 'blob', posture: posture(), erase: async () => ({ shredded: 99, residue: ['should-not-appear'] }) }
    const p = ViaPipeline.build([sealed, notSealed])!

    const result = await p.eraseSealed(eraseCtxFixture())

    expect(result).toEqual({ shredded: 1, residue: ['sealed-residue'] })
  })

  it('returns undefined when no binding declares sealed posture', async () => {
    const a: ViaBinding = { brand: 'a', posture: posture(), erase: async () => ({ shredded: 1, residue: [] }) }
    const p = ViaPipeline.build([a])!

    expect(await p.eraseSealed(eraseCtxFixture())).toBeUndefined()
  })
})

describe('ViaPipeline.hasAtRestHooks (async-stack detection)', () => {
  it('is false for a stack with only sync hooks — the sync-stack rule', () => {
    const money: ViaBinding = {
      brand: 'a',
      posture: posture(),
      ingest: (r) => r,
      canonicalizeStored: (r) => r,
      encodeWrite: async (r) => r,
      present: async (r) => r,
    }
    const p = ViaPipeline.build([money])!

    expect(p.hasAtRestHooks).toBe(false)
  })

  it('is true when any binding declares encodeAtRest', () => {
    const a: ViaBinding = { brand: 'a', posture: posture(), encodeAtRest: async (r) => ({ record: r }) }
    const p = ViaPipeline.build([a])!

    expect(p.hasAtRestHooks).toBe(true)
  })

  it('is true when any binding declares decodeAtRest', () => {
    const a: ViaBinding = { brand: 'a', posture: posture(), decodeAtRest: async (r) => r }
    const p = ViaPipeline.build([a])!

    expect(p.hasAtRestHooks).toBe(true)
  })

  it('is true when only one of several bindings declares an at-rest hook', () => {
    const sync: ViaBinding = { brand: 'a', posture: posture(), ingest: (r) => r }
    const atRest: ViaBinding = { brand: 'b', posture: posture(), decodeAtRest: async (r) => r }
    const p = ViaPipeline.build([sync, atRest])!

    expect(p.hasAtRestHooks).toBe(true)
  })
})
