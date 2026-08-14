import { describe, it, expect } from 'vitest'
import { RecordCodec } from '../../src/kernel/enclave/index.js'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import { openVdigPayload } from '../../src/kernel/enclave/classify/vdig.js'
import { NO_CRDT } from '../../src/with-commit/crdt/strategy.js'
import type { VdigFieldPolicy, EncryptedEnvelope } from '../../src/kernel/types.js'
import { ClassifiedConfigError, ClassifiedRotationError, ValidationError } from '../../src/kernel/errors.js'

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

const pw: VdigFieldPolicy = { normalize: 'password', notLastN: 0, equatable: false }

describe('encryptRecord digest-only branches (C6)', () => {
  it('rotate branch: string value → _vdig slot, field stripped from _data, no _sealed', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    const env = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { name: 'Nok', password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    expect(env._vdig?.password).toMatch(/^[^:]+:.+$/)
    expect(env._sealed?.password).toBeUndefined()          // I4 mutual exclusion
    const payload = await openVdigPayload(env._vdig!.password!, cek, 'users', 'r1', 'password')
    expect(payload.v).toBe(1)
    expect(payload.iter).toBe(600_000)
    // decrypt _data and prove the plaintext is gone
    const back = await codec.decryptRecord(env, { id: 'r1' })
    expect(back).toEqual({ name: 'Nok' })
  }, 30_000)

  it('carry-forward branch: field absent → prev._vdig copied BYTE-VERBATIM', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { name: 'Nok', password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const v2 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { name: 'Somchai' }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._vdig?.password).toBe(v1._vdig?.password)    // verbatim bytes (ledger determinism)
  }, 30_000)

  it('clear branch: explicit null drops the slot and emits nothing into _data', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'hunter2-hunter2' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const v2 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: null }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    expect(v2._vdig?.password).toBeUndefined()
    expect(await codec.decryptRecord(v2, { id: 'r1' })).toEqual({})
  }, 30_000)

  it('validate branch: non-string non-null value is a loud ValidationError', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    await expect(
      codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 42 }, 1, cek, undefined, undefined, { id: 'r1', prev: null }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('fail-loud: vdig ctx omitted on a digest-only collection (any missed call site = C6 wipe)', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    await expect(codec.encryptRecord({ collection: 'c', id: 'r1' }, { name: 'x' }, 1, cek)).rejects.toThrow(/silently destroy _vdig|digest-only/)
  })

  it('R6 write-side: rotating a field that still has prev._sealed[field] throws ClassifiedConfigError', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]))
    const cek = await generateDEK()
    const prev: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: 't', _iv: 'i', _data: 'd',
      _sealed: { password: 'iv:stale-recoverable-slot' },
    }
    await expect(
      codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'new-password-1' }, 2, cek, undefined, undefined, { id: 'r1', prev }),
    ).rejects.toBeInstanceOf(ClassifiedConfigError)
  })

  it('I5: digest-only fields are excluded from _det even when declared deterministic', async () => {
    const { codec } = await makeCodec(new Map([['password', pw]]), { deterministicFields: new Set(['password', 'city']) })
    const cek = await generateDEK()
    const env = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'hunter2-hunter2', city: 'CNX' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    expect(env._det?.password).toBeUndefined()
    expect(env._det?.city).toBeDefined()
  }, 30_000)
})

describe('notLastN ring (real 600K PBKDF2 — slow test)', () => {
  it('reuse of cur or a ring entry throws ClassifiedRotationError; ring trims to notLastN', async () => {
    const ringPw: VdigFieldPolicy = { normalize: 'password', notLastN: 2, equatable: false }
    const { codec } = await makeCodec(new Map([['password', ringPw]]))
    const cek = await generateDEK()
    const v1 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'password-one!' }, 1, cek, undefined, undefined, { id: 'r1', prev: null })
    const v2 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'password-two!' }, 2, cek, undefined, undefined, { id: 'r1', prev: v1 })
    // reuse of the immediately-previous value → refused
    await expect(
      codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'password-one!' }, 3, cek, undefined, undefined, { id: 'r1', prev: v2 }),
    ).rejects.toBeInstanceOf(ClassifiedRotationError)
    // a fresh value is fine, and the ring holds ≤ notLastN entries
    const v3 = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { password: 'password-three!' }, 3, cek, undefined, undefined, { id: 'r1', prev: v2 })
    const payload = await openVdigPayload(v3._vdig!.password!, cek, 'users', 'r1', 'password')
    expect((payload.ring ?? []).length).toBeLessThanOrEqual(2)
  }, 120_000)
})
