import { describe, it, expect } from 'vitest'
import type { EncryptedEnvelope, VdigFieldPolicy, ClassifiedVerdict } from '../../src/kernel/types.js'
import {
  ClassifiedConfigError, ClassifiedRevealError, ClassifiedVerifyError, ClassifiedRotationError,
} from '../../src/kernel/errors.js'
import {
  ClassifiedConfigError as ShimConfig, ClassifiedRevealError as ShimReveal,
} from '../../src/with-shape/classified/errors.js'
import type { ClassifiedFieldSpec } from '../../src/with-shape/classified/descriptor.js'

describe('stage-2 spine', () => {
  it('EncryptedEnvelope accepts a _vdig ciphertext map', () => {
    const env: EncryptedEnvelope = {
      _noydb: 1, _v: 1, _ts: 't', _iv: 'i', _data: 'd',
      _vdig: { password: 'iv:data' },
    }
    expect(env._vdig?.password).toBe('iv:data')
  })

  it('VdigFieldPolicy + ClassifiedVerdict + digest-only spec typecheck', () => {
    const p: VdigFieldPolicy = { normalize: 'password', notLastN: 3, rotateDays: 90, equatable: false }
    const v: ClassifiedVerdict = { ok: true, mustRotate: true }
    const spec: ClassifiedFieldSpec = {
      _noydbClassified: true, preset: 'password', storage: 'digest-only',
      sensitivity: 'secret', list: { kind: 'omit' },
      verifyNormalize: 'password', notLastN: 3,
    }
    expect(p.notLastN + Number(v.ok) + spec.preset.length).toBeGreaterThan(0)
  })

  it('new error classes carry collection/field and stable names', () => {
    const e1 = new ClassifiedVerifyError('users', 'password', 'field is not classified')
    const e2 = new ClassifiedRotationError('users', 'password', 'password was used recently')
    expect(e1.name).toBe('ClassifiedVerifyError')
    expect(e2.message).toContain('used recently')
  })

  it('with-shape errors.ts re-exports the moved kernel classes (same identity)', () => {
    expect(ShimConfig).toBe(ClassifiedConfigError)
    expect(ShimReveal).toBe(ClassifiedRevealError)
  })
})
