import { describe, it, expect } from 'vitest'
import { RecordCodec, generateDEK, buildTombstone } from '../../src/kernel/enclave/index.js'
import { NO_CRDT } from '../../src/with-commit/crdt/strategy.js'
import type { VdigFieldPolicy } from '../../src/kernel/types.js'

type Rec = Record<string, unknown>

async function makeCodec(vdigFields: ReadonlyMap<string, VdigFieldPolicy> | null) {
  const dek = await generateDEK()
  const codec = new RecordCodec<Rec>({
    name: 'users', actor: 'tester', storeCiphertext: true, debugPlaintext: false,
    provenance: false, sensitiveFields: new Set<string>(),
    deterministicFields: null, crdtMode: undefined,
    crdtStrategy: NO_CRDT, schema: undefined,
    getDEK: async () => dek, cekCache: null,
    vdigFields,
  } as never)
  return { codec, dek }
}

const eq: VdigFieldPolicy = { normalize: 'password', notLastN: 0, equatable: true }

describe('forget + classifySealedShred (_bidx)', () => {
  it('classifySealedShred reports the _bidx slot as live-shreddable+dekResidue-in-backups', async () => {
    const { codec } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const env = await codec.encryptRecord({ collection: 'c', id: 'r1' }, 
      { password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null },
    )
    expect(env._vdig?.password).toBeDefined()
    expect(env._bidx?.password).toBeDefined()   // invariant _bidx ⇒ _vdig
    expect(env._cek).toBeDefined()

    const report = await codec.classifySealedShred(env)
    expect(report.slots).toContainEqual({
      field: 'password',
      class: 'live-shreddable+dekResidue-in-backups',
    })
  }, 30_000)

  it('tombstone drops _bidx from the live envelope', async () => {
    const { codec } = await makeCodec(new Map([['password', eq]]))
    const cek = await generateDEK()
    const env = await codec.encryptRecord({ collection: 'c', id: 'r1' }, 
      { password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null },
    )
    expect(env._bidx?.password).toBeDefined()
    const tomb = buildTombstone({ collection: 'c', id: 'r' }, env._v, 'actor')
    expect(tomb._bidx).toBeUndefined()
  }, 30_000)
})
