/**
 * #629 Task 5 — the classified `ViaBinding`, unit-tested directly (the
 * binding is DORMANT: no compile entry, no collection ever compiles it in
 * this task). Mirrors `via/money-binding.test.ts` and `via/i18n-binding.test.ts`
 * — construct a config by hand, exercise each hook.
 */
import { describe, it, expect, vi } from 'vitest'
import { classifiedBinding, type ClassifiedViaConfig, type ClassifiedShredSlot } from '../../src/shape/via-classified/binding.js'
import { classified } from '../../src/shape/via-classified/presets.js'
import type { ClassifiedGuardCtx } from '../../src/shape/via-classified/guards.js'
import { ClassifiedConfigError } from '../../src/kernel/errors.js'
import { ClassifiedNeverStoredError, ClassifiedValidationError } from '../../src/shape/via-classified/errors.js'
import type { ViaCryptoCtx, ViaWriteCtx, ViaEraseCtx } from '../../src/kernel/via.js'
import { SealedHandle } from '../../src/kernel/types.js'

function guardCtx(over: Partial<ClassifiedGuardCtx> = {}): ClassifiedGuardCtx {
  return {
    perRecordKeys: false,
    crdt: false,
    hasConflictPolicy: false,
    storeCiphertext: true,
    deterministicFields: null,
    indexedFields: new Set(),
    textIndexFields: new Set(),
    vectorSourceFields: new Set(),
    subjectKeyField: undefined,
    bareSensitiveFields: new Set(),
    acknowledgeEquatableRisk: false,
    ...over,
  }
}

const writeCtxFixture = (): ViaWriteCtx => ({
  id: 'r1',
  vault: 'test-vault',
  prior: async () => null,
  emit: () => {},
})

/** In-memory sealed-slots fixture: real seal/unseal round-trip + real delete-blocks-unseal semantics (mirrors makeSealedSlotCapability's contract, not its crypto). */
function fixtureCrypto() {
  const store = new Map<string, unknown>()
  const deletedFields = new Set<string>()
  let counter = 0
  const crypto: ViaCryptoCtx = {
    sealedSlots: {
      async seal(field, plaintext) {
        const ref = { iv: `iv${counter}`, data: `data${counter}` }
        counter += 1
        store.set(`${field}:${ref.iv}:${ref.data}`, plaintext)
        deletedFields.delete(field)
        return ref
      },
      async unseal(field, ref) {
        if (deletedFields.has(field)) throw new Error(`sealed field "${field}" was deleted`)
        return store.get(`${field}:${ref.iv}:${ref.data}`)
      },
      async delete(field) {
        deletedFields.add(field)
      },
    },
    reservedEnvelopes: () => ({
      encrypt: async () => { throw new Error('unused in this fixture') },
      decrypt: async () => { throw new Error('unused in this fixture') },
    }),
  }
  return { crypto, deletedFields }
}

const eraseCtxFixture = (crypto: ViaCryptoCtx, live: unknown = undefined): ViaEraseCtx => ({
  id: 'r1',
  vault: 'test-vault',
  live,
  crypto,
})

describe('classifiedBinding (#629 Task 5)', () => {
  it('declares the classified brand + posture', () => {
    const b = classifiedBinding({
      entries: { pan: classified.creditCard({ pan: 'pan' }) },
      collectionName: 'cards',
      guardCtx: guardCtx(),
    })
    expect(b.brand).toBe('classified')
    expect(b.posture).toEqual({
      encryptedAtRest: 'sealed',
      queryable: 'det-exact',
      exportable: false,
      forgettable: true,
    })
  })

  describe('declare (door 1: resolveClassifiedFields + guardClassifiedCompat)', () => {
    it('throws ClassifiedConfigError on a duplicate field claim', () => {
      const cfg: ClassifiedViaConfig = {
        entries: {
          dob: classified.birthDate(),
          card: { _noydbClassifiedGroup: true, preset: 'g', members: { dob: classified.email() } },
        },
        collectionName: 'people',
        guardCtx: guardCtx(),
      }
      expect(() => classifiedBinding(cfg)).toThrow(ClassifiedConfigError)
    })

    it('throws ClassifiedConfigError (R1) when a digest-only field is declared without perRecordKeys', () => {
      const cfg: ClassifiedViaConfig = {
        entries: { secret: classified.password() },
        collectionName: 'users',
        guardCtx: guardCtx({ perRecordKeys: false }),
      }
      expect(() => classifiedBinding(cfg)).toThrow(ClassifiedConfigError)
    })

    it('succeeds when the guard context satisfies the declared fields', () => {
      const cfg: ClassifiedViaConfig = {
        entries: { secret: classified.password() },
        collectionName: 'users',
        guardCtx: guardCtx({ perRecordKeys: true }),
      }
      expect(() => classifiedBinding(cfg)).not.toThrow()
    })
  })

  describe('enforceWrite', () => {
    it('throws ClassifiedNeverStoredError when a storage:\'never\' field carries a value', async () => {
      const b = classifiedBinding({
        entries: { card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
      })
      await expect(
        b.enforceWrite!({ pan: '4242424242424242', cvc: '123' }, writeCtxFixture()),
      ).rejects.toBeInstanceOf(ClassifiedNeverStoredError)
    })

    it('throws ClassifiedValidationError when a preset validator rejects the value', async () => {
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
      })
      await expect(
        b.enforceWrite!({ pan: 'not-a-luhn-number' }, writeCtxFixture()),
      ).rejects.toBeInstanceOf(ClassifiedValidationError)
    })

    it('passes a valid write through (resolves)', async () => {
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
      })
      await expect(
        b.enforceWrite!({ pan: '4242424242424242' }, writeCtxFixture()),
      ).resolves.toBeUndefined()
    })
  })

  describe('encodeAtRest / decodeAtRest (via ctx.sealedSlots)', () => {
    it('encodeAtRest seals a recoverable field and peels it out of the record', async () => {
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
      })
      const { crypto } = fixtureCrypto()

      const result = await b.encodeAtRest!({ pan: '4242424242424242', open: 'visible' }, crypto)

      expect(result.record).toEqual({ open: 'visible' })
      expect(result.sealed).toBeDefined()
      expect(result.sealed!.pan).toEqual({ iv: 'iv0', data: 'data0' })
    })

    it('encodeAtRest leaves storage:\'never\'/digest-only fields untouched (only recoverable fields are sealed)', async () => {
      const b = classifiedBinding({
        entries: {
          secret: classified.password(),
          card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }),
        },
        collectionName: 'mixed',
        guardCtx: guardCtx({ perRecordKeys: true }),
      })
      const { crypto } = fixtureCrypto()

      // cvc (storage:'never') would be rejected by enforceWrite in the real
      // pipeline before encodeAtRest ever runs — here we exercise encodeAtRest
      // in isolation and confirm it doesn't seal fields it doesn't own.
      const result = await b.encodeAtRest!({ pan: '4242424242424242', secret: 'hunter2' }, crypto)

      expect(result.sealed).toEqual({ pan: { iv: 'iv0', data: 'data0' } })
      expect(result.record.secret).toBe('hunter2') // digest-only: untouched here (codec-inline elsewhere)
      expect('pan' in result.record).toBe(false)
    })

    it('encodeAtRest is a no-op (no sealed map) when no recoverable field is present', async () => {
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
      })
      const { crypto } = fixtureCrypto()

      const result = await b.encodeAtRest!({ other: 'x' }, crypto)

      expect(result).toEqual({ record: { other: 'x' } })
    })

    it('encodeAtRest ALSO seals bare sensitive[] fields (guardCtx.bareSensitiveFields) — #629 Task 6 union', async () => {
      // Once this binding is compiled in, hasAtRestHooks retires the codec's
      // inline sensitiveFields path for the WHOLE collection — a bare
      // sensitive[] field (unrelated to classifiedFields) must still seal,
      // or it would silently stop being sealed at all.
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx({ bareSensitiveFields: new Set(['ssn']) }),
      })
      const { crypto } = fixtureCrypto()

      const result = await b.encodeAtRest!({ pan: '4242424242424242', ssn: '123-45-6789', open: 'visible' }, crypto)

      expect(result.sealed).toEqual({
        pan: { iv: 'iv0', data: 'data0' },
        ssn: { iv: 'iv1', data: 'data1' },
      })
      expect(result.record).toEqual({ open: 'visible' })
    })

    it('decodeAtRest round-trips a bare sensitive[] field sealed via the union', async () => {
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx({ bareSensitiveFields: new Set(['ssn']) }),
      })
      const { crypto } = fixtureCrypto()

      const encoded = await b.encodeAtRest!({ pan: '4242424242424242', ssn: '123-45-6789' }, crypto)
      const decoded = await b.decodeAtRest!(encoded.record, encoded.sealed!, crypto, { asHandles: false })

      expect(decoded).toEqual({ pan: '4242424242424242', ssn: '123-45-6789' })
    })

    it('decodeAtRest round-trips the sealed field back to plaintext (asHandles: false)', async () => {
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
      })
      const { crypto } = fixtureCrypto()

      const encoded = await b.encodeAtRest!({ pan: '4242424242424242', open: 'visible' }, crypto)
      const decoded = await b.decodeAtRest!(encoded.record, encoded.sealed!, crypto, { asHandles: false })

      expect(decoded).toEqual({ pan: '4242424242424242', open: 'visible' })
    })

    it('decodeAtRest honors asHandles: yields a lazy SealedHandle that reveals the same value and never leaks via JSON.stringify', async () => {
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
      })
      const { crypto } = fixtureCrypto()

      const encoded = await b.encodeAtRest!({ pan: '4242424242424242', open: 'visible' }, crypto)
      const decoded = await b.decodeAtRest!(encoded.record, encoded.sealed!, crypto, { asHandles: true })

      expect(decoded.pan).toBeInstanceOf(SealedHandle)
      expect(JSON.stringify(decoded.pan)).toBe('"[sealed]"')
      await expect((decoded.pan as SealedHandle<unknown>).reveal()).resolves.toBe('4242424242424242')
      expect(decoded.open).toBe('visible')
    })
  })

  describe('erase (classifySealedShred + sealed-CEK prefix-delete participation)', () => {
    it('reports zero shredded/residue when no closure is wired (dormant default)', async () => {
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
      })
      const { crypto } = fixtureCrypto()

      const report = await b.erase!(eraseCtxFixture(crypto))

      expect(report).toEqual({ shredded: 0, residue: [] })
    })

    it('shreds "shreddable" slots (marks them deleted on the capability) and counts them', async () => {
      const { crypto, deletedFields } = fixtureCrypto()
      const slots: ClassifiedShredSlot[] = [{ field: 'pan', class: 'shreddable' }]
      const classifySealedShred = vi.fn(async () => ({ slots }))
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
        classifySealedShred,
      })

      const report = await b.erase!(eraseCtxFixture(crypto, { _sealed: { pan: 'iv0:data0' } }))

      expect(classifySealedShred).toHaveBeenCalledWith({ _sealed: { pan: 'iv0:data0' } })
      expect(report).toEqual({ shredded: 1, residue: [] })
      expect(deletedFields.has('pan')).toBe(true)
    })

    it('reports "dekResidue" slots as residue without counting them shredded or deleting the capability field', async () => {
      const { crypto, deletedFields } = fixtureCrypto()
      const slots: ClassifiedShredSlot[] = [{ field: 'pan', class: 'dekResidue' }]
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
        classifySealedShred: async () => ({ slots }),
      })

      const report = await b.erase!(eraseCtxFixture(crypto))

      expect(report).toEqual({ shredded: 0, residue: [{ kind: 'classified-sealed-dek-residue', field: 'pan' }] })
      expect(deletedFields.has('pan')).toBe(false)
    })

    it('a "live-shreddable+dekResidue-in-backups" slot counts BOTH shredded and residue (dual accounting)', async () => {
      const { crypto, deletedFields } = fixtureCrypto()
      const slots: ClassifiedShredSlot[] = [{ field: 'secret', class: 'live-shreddable+dekResidue-in-backups' }]
      const b = classifiedBinding({
        entries: { secret: classified.password() },
        collectionName: 'users',
        guardCtx: guardCtx({ perRecordKeys: true }),
        classifySealedShred: async () => ({ slots }),
      })

      const report = await b.erase!(eraseCtxFixture(crypto))

      expect(report).toEqual({ shredded: 1, residue: [{ kind: 'classified-sealed-dek-residue', field: 'secret' }] })
      expect(deletedFields.has('secret')).toBe(true)
    })

    it('folds the sealed-CEK purge count into shredded alongside slot classification', async () => {
      const { crypto } = fixtureCrypto()
      const b = classifiedBinding({
        entries: { pan: classified.creditCard({ pan: 'pan' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
        classifySealedShred: async () => ({ slots: [{ field: 'pan', class: 'shreddable' }] }),
        purgeSealedCekEnvelopes: async (id) => (id === 'r1' ? 2 : 0),
      })

      const report = await b.erase!(eraseCtxFixture(crypto))

      expect(report).toEqual({ shredded: 3, residue: [] }) // 1 slot + 2 purged envelopes
    })
  })

  describe('describeFragment', () => {
    it('reports each declared field\'s storage + sensitivity', () => {
      const b = classifiedBinding({
        entries: { card: classified.creditCard({ pan: 'pan', cvc: 'cvc' }) },
        collectionName: 'cards',
        guardCtx: guardCtx(),
      })

      expect(b.describeFragment!()).toEqual({
        classifiedFields: {
          pan: { storage: 'recoverable', sensitivity: 'secret' },
          cvc: { storage: 'never', sensitivity: 'secret' },
        },
      })
    })
  })
})
