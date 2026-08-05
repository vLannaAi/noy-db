import { describe, it, expect } from 'vitest'
import { EnclaveNotSupportedError } from '@noy-db/hub'
import type { EncryptedEnvelope } from '@noy-db/hub'
import {
  ALL_VECTORS,
  VECTOR_1_PLAIN,
  VECTOR_2_PER_RECORD_KEY,
  VECTOR_3_SEALED,
  VECTOR_3_SEALED_FIELD,
  VECTOR_SECRET,
  VECTOR_SALT_BASE64,
} from './vectors.js'

/**
 * **EnclaveModule** — the enclave conformance kit's structural view of
 * `@noy-db/hub`'s `kernel/enclave/index.ts` barrel (Enclave Contract v1,
 * C5). Deliberately NOT imported from `@noy-db/hub` — a fork's enclave is a
 * different object shape-checked structurally, never required to import
 * noy-db's types. Kept to exactly what this kit exercises (see
 * `.superpowers/sdd/task-8-brief.md`): the barrel also exports
 * `resolveStableCek`/`rewrapBodyToDek` (per-record lifecycle) and
 * `findByDet`/`queryByDet` (deterministic lookup), omitted here because they
 * take a collection-shaped context object (`StableCekDeps`/
 * `DeterministicContext`) rather than the plain key/envelope arguments a
 * generic conformance kit can construct — this kit exercises their
 * lower-level primitives instead (`wrapCek`/`unwrapCek`,
 * `encryptDeterministic`/`decryptDeterministic`).
 *
 * `K` is the opaque key type (`EnclaveKey` in noy-db's reference enclave).
 */
export interface EnclaveModule<K = unknown> {
  // ─── crypto ops + key lifecycle (unconditional core) ──────────────
  encrypt(plaintext: string, dek: K): Promise<{ iv: string; data: string }>
  decrypt(iv: string, data: string, dek: K): Promise<string>
  generateDEK(): Promise<K>
  deriveKey(secret: string, salt: Uint8Array): Promise<K>
  wrapKey(dek: K, kek: K): Promise<string>
  unwrapKey(wrapped: string, kek: K): Promise<K>

  // ─── envelope body (unconditional core, C1) ────────────────────────
  openEnvelopeJson(env: EncryptedEnvelope, key: K, opts?: { encrypted?: boolean }): Promise<string>
  writeEnvelopeBody(
    json: string,
    key: K,
    opts?: { encrypted?: boolean; perRecordKey?: boolean },
  ): Promise<Pick<EncryptedEnvelope, '_iv' | '_data' | '_cek'>>
  hasPerRecordKey(env: EncryptedEnvelope): boolean
  envelopeBodyForHash(env: EncryptedEnvelope): string

  // ─── tombstone (unconditional core) ────────────────────────────────
  isTombstone(env: EncryptedEnvelope, encrypted: boolean): boolean
  buildTombstone(version: number, actor: string): EncryptedEnvelope

  // ─── optional group: sealing ───────────────────────────────────────
  deriveSealedFieldKey(dek: K, collectionName: string, field: string): Promise<K>
  deriveSealedFieldKeyFromCek(cek: K, collectionName: string, field: string): Promise<K>

  // ─── optional group: deterministic ─────────────────────────────────
  encryptDeterministic(plaintext: string, dek: K, context: string): Promise<{ iv: string; data: string }>
  decryptDeterministic(iv: string, data: string, dek: K): Promise<string>

  // ─── optional group: per-record keys ───────────────────────────────
  wrapCek(cek: K, dek: K): Promise<string>
  unwrapCek(wrapped: string, dek: K): Promise<K>

  // ─── optional group: classify (stage-2 verify oracle primitives) ───
  encryptBytesWithAAD(data: Uint8Array, dek: K, aad: Uint8Array): Promise<{ iv: string; data: string }>
  decryptBytesWithAAD(iv: string, data: string, dek: K, aad: Uint8Array): Promise<Uint8Array>
  deriveVdigSlotKey(cek: K, collectionName: string, field: string): Promise<K>
  pbkdf2VerifyDigest(value: string, salt: Uint8Array, iterations: number): Promise<Uint8Array>
  ctEqualTags(a: Uint8Array, b: Uint8Array): boolean
  evaluateKofN(results: readonly boolean[], min: number): boolean
  deriveClassifyIndexKey(dek: K, collection: string, field: string): Promise<K>
  deriveClassifyIndexSalt(dek: K, collection: string, field: string): Promise<Uint8Array>
  mintBidxTag(normalized: string, dek: K, collection: string, field: string): Promise<string>
  computeBidxTarget(
    candidate: string,
    normalize: 'password' | 'secret-answer',
    dek: K,
    collection: string,
    field: string,
    costByte?: number,
  ): Promise<string | null>
}

export interface EnclaveConformanceOptions {
  readonly supports: {
    readonly sealing: boolean
    readonly deterministic: boolean
    readonly perRecordKeys: boolean
    readonly classify: boolean
  }
}

/** The stable code every `EnclaveNotSupportedError` (or fork subclass) carries. */
const NOT_SUPPORTED_CODE = new EnclaveNotSupportedError('sealing').code

/** One of the optional groups the enclave contract lets a fork refuse. */
export type ConformanceGroup = 'sealing' | 'deterministic' | 'per-record-keys' | 'classify'

/** True iff `err` is an `EnclaveNotSupportedError` (or fork subclass) refusal. */
function isNotSupportedRefusal(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === NOT_SUPPORTED_CODE
}

/**
 * Assert the group-consistency guarantee for one optional group: every
 * function in the group either refuses (`EnclaveNotSupportedError`) or none
 * do — never a mix. Returns the names of any functions that did NOT refuse
 * (empty = fully consistent refusal). Exercises the group with placeholder
 * arguments — it only cares whether the call refuses, not what it would
 * otherwise return.
 *
 * Extracted so both `runEnclaveConformance`'s registered assertions and the
 * kit's own self-test (`self-test.test.ts`) share one implementation — the
 * self-test proves a MIXED group (one function silently works while its
 * sibling refuses) is actually caught, not just the fully-consistent cases.
 */
export async function assertGroupRefuses<K>(
  enclave: EnclaveModule<K>,
  group: ConformanceGroup,
): Promise<string[]> {
  const dek = await enclave.generateDEK()
  const cek = await enclave.generateDEK()
  const checks: Record<ConformanceGroup, ReadonlyArray<readonly [string, () => Promise<unknown>]>> = {
    sealing: [
      ['deriveSealedFieldKey', () => enclave.deriveSealedFieldKey(dek, 'c', 'f')],
      ['deriveSealedFieldKeyFromCek', () => enclave.deriveSealedFieldKeyFromCek(dek, 'c', 'f')],
    ],
    deterministic: [
      ['encryptDeterministic', () => enclave.encryptDeterministic('v', dek, 'c/f')],
      ['decryptDeterministic', () => enclave.decryptDeterministic('iv', 'data', dek)],
    ],
    'per-record-keys': [
      ['wrapCek', () => enclave.wrapCek(cek, dek)],
      ['unwrapCek', () => enclave.unwrapCek('bogus', dek)],
    ],
    classify: [
      ['deriveVdigSlotKey', () => enclave.deriveVdigSlotKey(cek, 'c', 'f')],
      ['pbkdf2VerifyDigest', () => enclave.pbkdf2VerifyDigest('v', new Uint8Array(32), 1_000)],
      ['deriveClassifyIndexKey', () => enclave.deriveClassifyIndexKey(dek, 'c', 'f')],
      ['deriveClassifyIndexSalt', () => enclave.deriveClassifyIndexSalt(dek, 'c', 'f')],
      ['mintBidxTag', () => enclave.mintBidxTag('v', dek, 'c', 'f')],
      ['computeBidxTarget', () => enclave.computeBidxTarget('v', 'password', dek, 'c', 'f')],
    ],
  }

  const didNotRefuse: string[] = []
  for (const [name, fn] of checks[group]) {
    try {
      await fn()
      didNotRefuse.push(name) // resolved — did not refuse at all
    } catch (err) {
      if (!isNotSupportedRefusal(err)) didNotRefuse.push(name) // refused, but not via EnclaveNotSupportedError
    }
  }
  return didNotRefuse
}

const HEADER_FIXTURE = {
  _by: 'user-1',
  _source: 'src-1',
  _sourceTs: '2026-01-01T00:00:00.000Z',
  _tier: 2,
  _elevatedBy: 'user-2',
} as const

/**
 * Registers the enclave contract as an executable vitest spec against
 * `enclave` — the contract every `kernel/enclave/index.ts` (reference or
 * fork) must satisfy. See `docs/foundations/enclave-contract.md`
 * (C5) for the design.
 */
export function runEnclaveConformance<K>(enclave: EnclaveModule<K>, opts: EnclaveConformanceOptions): void {
  describe('Enclave Conformance', () => {
    describe('envelope body round-trip', () => {
      it('encrypted body: write -> open recovers identical JSON; header fields untouched', async () => {
        const dek = await enclave.generateDEK()
        const json = JSON.stringify({ hello: 'world', n: 42 })
        const body = await enclave.writeEnvelopeBody(json, dek)
        const env: EncryptedEnvelope = {
          _noydb: 1,
          _v: 1,
          _ts: '2026-01-01T00:00:00.000Z',
          ...HEADER_FIXTURE,
          ...body,
        }

        const recovered = await enclave.openEnvelopeJson(env, dek)
        expect(recovered).toBe(json)

        // The body helpers must never touch the protocol header.
        expect(env._by).toBe(HEADER_FIXTURE._by)
        expect(env._source).toBe(HEADER_FIXTURE._source)
        expect(env._sourceTs).toBe(HEADER_FIXTURE._sourceTs)
        expect(env._tier).toBe(HEADER_FIXTURE._tier)
        expect(env._elevatedBy).toBe(HEADER_FIXTURE._elevatedBy)
      })

      it('plaintext body (encrypted: false): write -> open recovers identical JSON', async () => {
        const dek = await enclave.generateDEK()
        const json = JSON.stringify({ hello: 'plain' })
        const body = await enclave.writeEnvelopeBody(json, dek, { encrypted: false })
        expect(body._iv).toBe('')
        expect(body._data).toBe(json)

        const env: EncryptedEnvelope = { _noydb: 1, _v: 1, _ts: '2026-01-01T00:00:00.000Z', ...body }
        const recovered = await enclave.openEnvelopeJson(env, dek, { encrypted: false })
        expect(recovered).toBe(json)
      })
    })

    describe('body helper discriminants', () => {
      it('hasPerRecordKey reflects `_cek` presence', () => {
        expect(enclave.hasPerRecordKey(VECTOR_1_PLAIN.envelope)).toBe(false)
        expect(enclave.hasPerRecordKey(VECTOR_2_PER_RECORD_KEY.envelope)).toBe(true)
      })

      it('envelopeBodyForHash: no `_sealed` -> `_data` alone', () => {
        expect(enclave.envelopeBodyForHash(VECTOR_1_PLAIN.envelope)).toBe(VECTOR_1_PLAIN.envelope._data)
      })

      it('envelopeBodyForHash: `_sealed` present -> canonical {_data,_sealed} JSON, sorted keys', () => {
        const env = VECTOR_3_SEALED.envelope
        const sealed = env._sealed ?? {}
        const sealedKeys = Object.keys(sealed).sort()
        const sealedParts = sealedKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(sealed[k])}`)
        const expected = `{"_data":${JSON.stringify(env._data)},"_sealed":{${sealedParts.join(',')}}}`
        expect(enclave.envelopeBodyForHash(env)).toBe(expected)
      })
    })

    describe('tombstone semantics', () => {
      it('buildTombstone -> isTombstone is true on an encrypted collection', () => {
        const tombstone = enclave.buildTombstone(3, 'user-1')
        expect(enclave.isTombstone(tombstone, true)).toBe(true)
      })

      it('a live envelope -> isTombstone is false', async () => {
        const dek = await enclave.generateDEK()
        const body = await enclave.writeEnvelopeBody(JSON.stringify({ a: 1 }), dek)
        const env: EncryptedEnvelope = { _noydb: 1, _v: 1, _ts: '2026-01-01T00:00:00.000Z', ...body }
        expect(enclave.isTombstone(env, true)).toBe(false)
      })

      it('plaintext-mode collections: isTombstone is always false', () => {
        const tombstone = enclave.buildTombstone(1, 'user-1')
        expect(enclave.isTombstone(tombstone, false)).toBe(false)
      })
    })

    describe('key lifecycle', () => {
      it('deriveKey -> wrapKey -> unwrapKey round trip recovers a usable DEK', async () => {
        const kek = await enclave.deriveKey('a fixed secret', new Uint8Array(32).fill(7))
        const dek = await enclave.generateDEK()
        const wrapped = await enclave.wrapKey(dek, kek)
        const recovered = await enclave.unwrapKey(wrapped, kek)

        const json = JSON.stringify({ ok: true })
        const encrypted = await enclave.encrypt(json, dek)
        expect(await enclave.decrypt(encrypted.iv, encrypted.data, recovered)).toBe(json)
      })
    })

    describe('sealing (optional group)', () => {
      if (opts.supports.sealing) {
        it('deriveSealedFieldKey / deriveSealedFieldKeyFromCek derive usable keys', async () => {
          const dek = await enclave.generateDEK()
          const fieldKey = await enclave.deriveSealedFieldKey(dek, 'customers', 'taxId')
          const enc = await enclave.encrypt('secret-value', fieldKey)
          expect(await enclave.decrypt(enc.iv, enc.data, fieldKey)).toBe('secret-value')

          const cek = await enclave.generateDEK()
          const cekFieldKey = await enclave.deriveSealedFieldKeyFromCek(cek, 'customers', 'taxId')
          const enc2 = await enclave.encrypt('secret-value-2', cekFieldKey)
          expect(await enclave.decrypt(enc2.iv, enc2.data, cekFieldKey)).toBe('secret-value-2')
        })
      } else {
        it('every sealing function throws EnclaveNotSupportedError — never a mix', async () => {
          expect(await assertGroupRefuses(enclave, 'sealing')).toEqual([])
        })
      }
    })

    describe('deterministic (optional group)', () => {
      if (opts.supports.deterministic) {
        it('encryptDeterministic is stable for the same input', async () => {
          const dek = await enclave.generateDEK()
          const a = await enclave.encryptDeterministic('same-value', dek, 'coll/field')
          const b = await enclave.encryptDeterministic('same-value', dek, 'coll/field')
          expect(a).toEqual(b)
          expect(await enclave.decryptDeterministic(a.iv, a.data, dek)).toBe('same-value')
        })
      } else {
        it('every deterministic function throws EnclaveNotSupportedError — never a mix', async () => {
          expect(await assertGroupRefuses(enclave, 'deterministic')).toEqual([])
        })
      }
    })

    describe('per-record keys (optional group)', () => {
      if (opts.supports.perRecordKeys) {
        it('wrapCek / unwrapCek round trip', async () => {
          const dek = await enclave.generateDEK()
          const cek = await enclave.generateDEK()
          const wrapped = await enclave.wrapCek(cek, dek)
          const recovered = await enclave.unwrapCek(wrapped, dek)

          const json = JSON.stringify({ per: 'record' })
          const encrypted = await enclave.encrypt(json, cek)
          expect(await enclave.decrypt(encrypted.iv, encrypted.data, recovered)).toBe(json)
        })
      } else {
        it('every per-record-key function throws EnclaveNotSupportedError — never a mix', async () => {
          expect(await assertGroupRefuses(enclave, 'per-record-keys')).toEqual([])
        })
      }
    })

    describe('classify (stage-2 verify primitives)', () => {
      if (!opts.supports.classify) {
        it('refuses the group with EnclaveNotSupportedError', () => {
          expect(() => enclave.ctEqualTags(new Uint8Array(32), new Uint8Array(32)))
            .toThrowError(expect.objectContaining({ code: NOT_SUPPORTED_CODE }))
        })
        return
      }

      it('pbkdf2VerifyDigest: 32 bytes, deterministic, salt-separated', async () => {
        const salt = new Uint8Array(32).fill(3)
        const a = await enclave.pbkdf2VerifyDigest('candidate', salt, 1_000)
        const b = await enclave.pbkdf2VerifyDigest('candidate', salt, 1_000)
        const c = await enclave.pbkdf2VerifyDigest('candidate', new Uint8Array(32).fill(4), 1_000)
        expect(a.length).toBe(32)
        expect([...a]).toEqual([...b])
        expect([...a]).not.toEqual([...c])
      })

      it('ctEqualTags: equal/unequal verdicts + exact-32 precondition', () => {
        const t = new Uint8Array(32).fill(9)
        expect(enclave.ctEqualTags(t, new Uint8Array(32).fill(9))).toBe(true)
        const off = new Uint8Array(32).fill(9); off[0] = 8
        expect(enclave.ctEqualTags(t, off)).toBe(false)
        expect(() => enclave.ctEqualTags(new Uint8Array(31), t)).toThrow()
      })

      it('evaluateKofN truth table + bounds', () => {
        expect(enclave.evaluateKofN([true, false, true], 2)).toBe(true)
        expect(enclave.evaluateKofN([true, false, false], 2)).toBe(false)
        expect(() => enclave.evaluateKofN([true], 0)).toThrow()
        expect(() => enclave.evaluateKofN([true], 2)).toThrow()
      })

      it('vdig slot key: AAD-bound round-trip + cross-record/field splice rejection (C1)', async () => {
        const cek = await enclave.generateDEK()
        const key = await enclave.deriveVdigSlotKey(cek, 'users', 'password')
        const aad = (rid: string, f: string) =>
          new TextEncoder().encode(JSON.stringify(['noydb-classify-vdig', 'users', rid, f]))
        const sealed = await enclave.encryptBytesWithAAD(
          new TextEncoder().encode('{"v":1}'), key as never, aad('r1', 'password'))
        const back = await enclave.decryptBytesWithAAD(sealed.iv, sealed.data, key as never, aad('r1', 'password'))
        expect(new TextDecoder().decode(back)).toBe('{"v":1}')
        await expect(enclave.decryptBytesWithAAD(sealed.iv, sealed.data, key as never, aad('r2', 'password')))
          .rejects.toThrow() // spliced to another record
        const keyOtherField = await enclave.deriveVdigSlotKey(cek, 'users', 'pin')
        await expect(enclave.decryptBytesWithAAD(sealed.iv, sealed.data, keyOtherField as never, aad('r1', 'pin')))
          .rejects.toThrow() // spliced to another field (key AND aad domain-separated)
      })

      it('bidx tag: round-trip + per-field/collection separation', async () => {
        const dek = await enclave.generateDEK()
        const n = 'correct horse'
        const tag = await enclave.mintBidxTag(n, dek, 'users', 'password')
        expect(await enclave.computeBidxTarget('correct horse', 'password', dek, 'users', 'password')).toBe(tag)
        expect(await enclave.mintBidxTag(n, dek, 'users', 'pin')).not.toBe(tag)
        expect(await enclave.mintBidxTag(n, dek, 'admins', 'password')).not.toBe(tag)
      })

      it('Oracle #4: unknown discriminator → computeBidxTarget null', async () => {
        const dek = await enclave.generateDEK()
        expect(await enclave.computeBidxTarget('x', 'password', dek, 'u', 'a', 0x7f)).toBeNull()
      })
    })

    describe('known-answer vectors (structure + decryptability, no leaks)', () => {
      it('every vector envelope decrypts to its known plaintext under the re-derived DEK', async () => {
        const salt = Uint8Array.from(atob(VECTOR_SALT_BASE64), (c) => c.charCodeAt(0))
        const kek = await enclave.deriveKey(VECTOR_SECRET, salt)

        for (const vector of ALL_VECTORS) {
          const dek = await enclave.unwrapKey(vector.wrappedDek, kek)
          const recovered = await enclave.openEnvelopeJson(vector.envelope, dek)
          expect(recovered).toBe(vector.plaintext)

          // No-leak: the recovered plaintext must not carry the envelope's
          // own protected-body key material.
          expect(recovered).not.toContain(vector.envelope._iv)
          if (vector.envelope._cek !== undefined) {
            expect(recovered).not.toContain(vector.envelope._cek)
          }
        }
      })

      if (opts.supports.sealing) {
        it('the sealed-shaped vector\'s `_sealed` slot decrypts under deriveSealedFieldKey', async () => {
          const salt = Uint8Array.from(atob(VECTOR_SALT_BASE64), (c) => c.charCodeAt(0))
          const kek = await enclave.deriveKey(VECTOR_SECRET, salt)
          const dek = await enclave.unwrapKey(VECTOR_3_SEALED.wrappedDek, kek)
          const fieldKey = await enclave.deriveSealedFieldKey(
            dek,
            VECTOR_3_SEALED_FIELD.collectionName,
            VECTOR_3_SEALED_FIELD.field,
          )
          const slot = VECTOR_3_SEALED.envelope._sealed?.[VECTOR_3_SEALED_FIELD.field]
          if (!slot) throw new Error('vectors.ts: VECTOR_3_SEALED is missing its _sealed.taxId slot')
          const [iv, data] = slot.split(':')
          if (!iv || !data) throw new Error('vectors.ts: malformed _sealed slot (expected "iv:data")')
          expect(await enclave.decrypt(iv, data, fieldKey)).toBe(VECTOR_3_SEALED_FIELD.value)
        })
      }
    })
  })
}
