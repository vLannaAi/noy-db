/**
 * #629 Task 1 (commit 2) — `ViaCryptoCtx` capability factories:
 * `makeSealedSlotCapability` (sealedSlots) and `makeReservedEnvelopes`.
 *
 * These are the kernel-side capability factories a later task wires into
 * `NoydbVia.encodeAtRest`/`decodeAtRest`/`erase` hooks. Both are built on
 * the byte-parity extraction in `sealed-slots.ts` (commit 1) and go through
 * the SAME `deriveSealedFieldKey`/`deriveSealedFieldKeyFromCek`/`encrypt`/
 * `decrypt` real crypto primitives `RecordCodec` uses — no mocking of the
 * crypto itself, only of the DEK resolver plumbing.
 */
import { describe, it, expect } from 'vitest'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import { makeSealedSlotCapability, makeReservedEnvelopes } from '../../src/kernel/enclave/record-keys/sealed-slots.js'
import { ValidationError } from '../../src/kernel/errors.js'

describe('makeSealedSlotCapability', () => {
  it('seal/unseal round-trips a field under a fixture DEK (real derivation path)', async () => {
    const dek = await generateDEK()
    const cap = makeSealedSlotCapability({ name: 'people', getDEK: async () => dek }, 'r1')

    const ref = await cap.seal('ssn', '123-45-6789')
    expect(ref.iv).toBeTruthy()
    expect(ref.data).toBeTruthy()
    expect(await cap.unseal('ssn', ref)).toBe('123-45-6789')
  })

  it('exposes no key material on the returned object (zero-knowledge)', async () => {
    const dek = await generateDEK()
    const cap = makeSealedSlotCapability({ name: 'people', getDEK: async () => dek }, 'r1', await generateDEK())

    expect(Object.keys(cap).sort()).toEqual(['delete', 'seal', 'unseal'])
    for (const value of Object.values(cap)) expect(typeof value).toBe('function')
    expect(JSON.stringify(cap)).toBe('{}')
  })

  it('unseal after delete refuses on this capability instance', async () => {
    const dek = await generateDEK()
    const cap = makeSealedSlotCapability({ name: 'people', getDEK: async () => dek }, 'r1')

    const ref = await cap.seal('ssn', '123-45-6789')
    await cap.delete('ssn')
    await expect(cap.unseal('ssn', ref)).rejects.toBeInstanceOf(ValidationError)
  })

  it('a capability bound to a different record cannot unseal another record\'s slot', async () => {
    const dek = await generateDEK()
    const cekA = await generateDEK()
    const cekB = await generateDEK()
    const capA = makeSealedSlotCapability({ name: 'people', getDEK: async () => dek }, 'r1', cekA)
    const capB = makeSealedSlotCapability({ name: 'people', getDEK: async () => dek }, 'r2', cekB)

    const ref = await capA.seal('ssn', '123-45-6789')
    await expect(capB.unseal('ssn', ref)).rejects.toThrow()
  })
})

describe('makeReservedEnvelopes', () => {
  it('refuses a prefix not in declaredPrefixes', async () => {
    const dek = await generateDEK()
    const reservedEnvelopes = makeReservedEnvelopes(async () => dek, ['_dict_'])

    expect(() => reservedEnvelopes('_undeclared_')).toThrow(ValidationError)
  })

  it("reservedEnvelopes('_dict_') refuses a collection that does not start with the prefix", async () => {
    const dek = await generateDEK()
    const reservedEnvelopes = makeReservedEnvelopes(async () => dek, ['_dict_'])
    const cap = reservedEnvelopes('_dict_')

    await expect(cap.encrypt({ collection: 'notdict_x', id: 'r1' }, '{}', 1)).rejects.toBeInstanceOf(ValidationError)

    const env = await cap.encrypt({ collection: '_dict_test', id: 'r1' }, '{}', 1)
    await expect(cap.decrypt('notdict_x', 'r1', env)).rejects.toBeInstanceOf(ValidationError)
  })

  it('encrypt/decrypt round-trips a _dict_test envelope', async () => {
    const dek = await generateDEK()
    const reservedEnvelopes = makeReservedEnvelopes(async () => dek, ['_dict_'])
    const cap = reservedEnvelopes('_dict_')

    const body = JSON.stringify({ key: 'greeting', labels: { en: 'hi' } })
    const env = await cap.encrypt({ collection: '_dict_test', id: 'r1' }, body, 1)
    expect(env._v).toBe(1)
    expect(env._iv).toBeTruthy()
    expect(env._data).toBeTruthy()

    const json = await cap.decrypt('_dict_test', 'r1', env)
    expect(JSON.parse(json)).toEqual({ key: 'greeting', labels: { en: 'hi' } })
  })
})
