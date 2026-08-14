import { describe, it, expect } from 'vitest'
import { RecordCodec, generateDEK } from '../../src/kernel/enclave/index.js'
import { computeBidxTarget } from '../../src/kernel/enclave/classify/find.js'
import { NO_CRDT } from '../../src/with-commit/crdt/strategy.js'
import type { VdigFieldPolicy } from '../../src/kernel/types.js'

type Rec = Record<string, unknown>

async function makeCodec(vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null, extras: Partial<Record<string, unknown>> = {}) {
  const dek = await generateDEK()
  const codec = new RecordCodec<Rec>({
    name: 'users', actor: 'tester', storeCiphertext: true, debugPlaintext: false,
    provenance: false, sensitiveFields: new Set<string>(),
    deterministicFields: null, crdtMode: undefined,
    crdtStrategy: NO_CRDT, schema: undefined,
    getDEK: async () => dek, cekCache: null,
    vdigFields,
    ...extras,
  } as never)
  return { codec, dek }
}

const eq: VdigFieldPolicy = { normalize: 'password', notLastN: 0, equatable: true }
const noEq: VdigFieldPolicy = { normalize: 'password', notLastN: 0, equatable: false }

describe('encryptRecord _bidx branches (C6 mirror)', () => {
  it('rotate: string value → _bidx tag present AND matches computeBidxTarget; _bidx ⇒ _vdig', async () => {
    const { codec, dek } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const env = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    expect(env._vdig?.password).toBeDefined()
    expect(env._bidx?.password).toBeDefined()             // invariant _bidx ⇒ _vdig
    const target = await computeBidxTarget('hunter2-hunter2', 'password', dek, 'users', 'password')
    expect(env._bidx!.password).toBe(target)
  }, 30_000)

  it('monotonic carry: field absent → prev._bidx copied BYTE-VERBATIM, even from a non-equatable handle (I-3)', async () => {
    const { codec } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'hunter2-hunter2', name: 'A' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    // a later write by a handle with equatable OFF, field absent → tag preserved
    const { codec: codecNoEq } = await makeCodec(new Map([['password', noEq]]))
    const v2 = await codecNoEq.encryptRecord({ collection: 'c', id: 'r1' }, { name: 'B' }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._bidx?.password).toBe(v1._bidx?.password)   // verbatim, not scrubbed
  }, 30_000)

  it('branch-2 non-equatable rotate: field present, knob OFF → stale tag DROPPED (plan decision)', async () => {
    const { codec } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'old-secret-1234' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const { codec: codecNoEq } = await makeCodec(new Map([['password', noEq]]))
    const v2 = await codecNoEq.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'new-secret-5678' }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._vdig?.password).toBeDefined()              // digest rotates as usual
    expect(v2._bidx?.password).toBeUndefined()            // no mint (knob off), no stale carry
  }, 30_000)

  it('clear: field null → both _vdig and _bidx dropped', async () => {
    const { codec } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const v2 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: null }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._vdig?.password).toBeUndefined()
    expect(v2._bidx?.password).toBeUndefined()
  }, 30_000)

  it('carry-forward byte-stability: unrelated put on an equatable handle leaves tag bytes unchanged', async () => {
    const { codec } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'hunter2-hunter2', name: 'A' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const v2 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { name: 'B' }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._bidx?.password).toBe(v1._bidx?.password)
  }, 30_000)
})
