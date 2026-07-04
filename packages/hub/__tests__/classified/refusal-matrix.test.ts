/**
 * Refusal matrix R1-R6 — both doors (Task 13) + the Layer B confidentiality
 * regressions (Crit1 reconcile digest-only, Crit2 crdt×classified, Imp3
 * sensitive∩digest-only, Imp4 digest-only on plaintext, Imp5 R6 on all codec
 * branches, Min7 notLastN cap).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { inlineMemory } from './harness.js'
import { classified } from '../../src/with-shape/classified/presets.js'
import { ClassifiedConfigError } from '../../src/kernel/errors.js'
import { withForgetCascade } from '../../src/with-audit/forget/index.js'
import { RecordCodec, generateDEK } from '../../src/kernel/enclave/index.js'
import { NO_CRDT } from '../../src/with-commit/crdt/strategy.js'
import type { VdigFieldPolicy, EncryptedEnvelope } from '../../src/kernel/types.js'
import type { ClassifiedFieldSpec } from '../../src/with-shape/classified/descriptor.js'

type Rec = Record<string, unknown>

async function vault(secret: string) {
  const db = await createNoydb({ store: inlineMemory(), user: 'a', secret })
  return db.openVault('v1')
}

describe('Refusal matrix — door 1: collection()', () => {
  it('R1: digest-only without perRecordKeys is refused', async () => {
    const v = await vault('pw-r1')
    expect(() => v.collection<Rec>('users', {
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R2 (Crit2): digest-only × crdt is refused; recoverable × conflictPolicy is refused', async () => {
    const v = await vault('pw-r2')
    expect(() => v.collection<Rec>('a', {
      perRecordKeys: true, crdt: 'lww-map',
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
    expect(() => v.collection<Rec>('b', {
      conflictPolicy: (local: Rec) => local,
      classifiedFields: { email: classified.email() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R3: digest-only ∈ deterministicFields is refused', async () => {
    const v = await vault('pw-r3')
    expect(() => v.collection<Rec>('users', {
      perRecordKeys: true,
      deterministicFields: ['password'], acknowledgeDeterministicRisk: true,
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R4: digest-only ∈ indexes / text index / vector source is refused', async () => {
    const v = await vault('pw-r4')
    expect(() => v.collection<Rec>('a', {
      perRecordKeys: true, indexes: ['password'],
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
    expect(() => v.collection<Rec>('b', {
      perRecordKeys: true, textIndexes: ['password'],
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
    expect(() => v.collection<Rec>('c', {
      perRecordKeys: true,
      embeddings: { source: 'password', encode: async () => new Float32Array(3), dim: 3, model: 'm' },
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R4: digest-only as the forget-subject key is refused (vault plumbs subjectKeyField)', async () => {
    const db = await createNoydb({
      store: inlineMemory(), user: 'a', secret: 'pw-r4-subject',
      forgetStrategy: withForgetCascade({ subjects: { users: 'password' } }),
    })
    const v = await db.openVault('v1')
    expect(() => v.collection<Rec>('users', {
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R5 (Imp3): digest-only field also in bare sensitive[] is refused', async () => {
    const v = await vault('pw-r5')
    expect(() => v.collection<Rec>('users', {
      perRecordKeys: true, sensitive: ['password'],
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('Imp4: digest-only on a plaintext (encrypt: false) collection is refused', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'a', encrypt: false })
    const v = await db.openVault('v1')
    expect(() => v.collection<Rec>('users', {
      perRecordKeys: true,
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('Min7: a raw spec with notLastN > 8 is refused (bypasses the preset clamp)', async () => {
    const v = await vault('pw-min7')
    const rawSpec: ClassifiedFieldSpec = {
      _noydbClassified: true, preset: 'password', storage: 'digest-only',
      sensitivity: 'secret', list: { kind: 'omit' },
      verifyNormalize: 'password', notLastN: 9,
    }
    expect(() => v.collection<Rec>('users', {
      perRecordKeys: true,
      classifiedFields: { password: rawSpec },
    })).toThrow(ClassifiedConfigError)
  })

  it('a valid digest-only declaration still opens (guards are precise, not blanket)', async () => {
    const v = await vault('pw-ok')
    expect(() => v.collection<Rec>('users', {
      perRecordKeys: true,
      classifiedFields: { password: classified.password() },
    })).not.toThrow()
  })
})

describe('Refusal matrix — door 2: _applyClassifiedFields (the reconcile seam, C5)', () => {
  it('R2 second door (Crit2): a crdt collection cannot have digest-only fields bolted on later', async () => {
    const v = await vault('pw-d2')
    v.collection<Rec>('docs', { crdt: 'lww-map', perRecordKeys: true })  // first open, no classified
    expect(() => v.collection<Rec>('docs', {
      crdt: 'lww-map', perRecordKeys: true,
      classifiedFields: { password: classified.password() },            // reconcile attach
    })).toThrow(ClassifiedConfigError)
  })

  it('R1 second door: reconcile attach onto a non-perRecordKeys collection is refused', async () => {
    const v = await vault('pw-d2b')
    v.collection<Rec>('plain', {})
    expect(() => v.collection<Rec>('plain', {
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('Crit1: digest-only can NEVER retro-attach — even when every guard-row passes', async () => {
    const v = await vault('pw-crit1')
    // perRecordKeys collection, no crdt/conflict/index/sensitive — R1-R5 all
    // pass, but vdigFields is construction-frozen null, so a late digest-only
    // declaration would write the secret into _data recoverably.
    v.collection<Rec>('users', { perRecordKeys: true })
    expect(() => v.collection<Rec>('users', {
      perRecordKeys: true,
      classifiedFields: { password: classified.password() },
    })).toThrow(ClassifiedConfigError)
  })

  it('R6 session: a re-declaration that changes a field form is refused (first-wins otherwise)', async () => {
    const v = await vault('pw-r6')
    v.collection<Rec>('users', { perRecordKeys: true, classifiedFields: { password: classified.password() } })
    // identical re-declaration → first-wins no-op
    expect(() => v.collection<Rec>('users', {
      perRecordKeys: true, classifiedFields: { password: classified.password() },
    })).not.toThrow()
    // form flip digest-only → recoverable → refused
    expect(() => v.collection<Rec>('users', {
      perRecordKeys: true, classifiedFields: { password: classified.email() },
    })).toThrow(ClassifiedConfigError)
  })
})

describe('Imp5: R6 write-side fires on EVERY codec branch over a prev._sealed slot', () => {
  const pw: VdigFieldPolicy = { normalize: 'password', notLastN: 0 }

  async function makeCodec() {
    const dek = await generateDEK()
    return new RecordCodec<Rec>({
      name: 'users', actor: 'tester', storeCiphertext: true, debugPlaintext: false,
      provenance: false, sensitiveFields: new Set<string>(),
      deterministicFields: null, crdtMode: undefined,
      crdtStrategy: NO_CRDT, schema: undefined,
      getDEK: async () => dek, cekCache: null,
      vdigFields: new Map([['password', pw]]),
    } as never)
  }

  const prevWithSealed: EncryptedEnvelope = {
    _noydb: 1, _v: 1, _ts: 't', _iv: 'i', _data: 'd',
    _sealed: { password: 'iv:stale-recoverable-slot' },
  }

  it('rotate (string) branch throws', async () => {
    const codec = await makeCodec()
    const cek = await generateDEK()
    await expect(
      codec.encryptRecord({ password: 'new-password-1' }, 2, cek, undefined, undefined, { id: 'r1', prev: prevWithSealed }),
    ).rejects.toBeInstanceOf(ClassifiedConfigError)
  })

  it('carry-forward (absent) branch throws — no silent destruction of the sealed slot', async () => {
    const codec = await makeCodec()
    const cek = await generateDEK()
    await expect(
      codec.encryptRecord({ name: 'x' }, 2, cek, undefined, undefined, { id: 'r1', prev: prevWithSealed }),
    ).rejects.toBeInstanceOf(ClassifiedConfigError)
  })

  it('clear (null) branch throws — no silent destruction of the sealed slot', async () => {
    const codec = await makeCodec()
    const cek = await generateDEK()
    await expect(
      codec.encryptRecord({ password: null }, 2, cek, undefined, undefined, { id: 'r1', prev: prevWithSealed }),
    ).rejects.toBeInstanceOf(ClassifiedConfigError)
  })
})
