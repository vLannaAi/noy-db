import { describe, it, expect } from 'vitest'
import { EnclaveNotSupportedError } from '@noy-db/hub'
import type { EncryptedEnvelope } from '@noy-db/hub'
import {
  ALL_VECTORS,
  VECTOR_1_PLAIN,
  VECTOR_2_PER_RECORD_KEY,
  VECTOR_3_SEALED,
  VECTOR_3_SEALED_FIELD,
  VECTOR_PASSPHRASE,
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
  deriveKey(passphrase: string, salt: Uint8Array): Promise<K>
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
}

export interface EnclaveConformanceOptions {
  readonly supports: {
    readonly sealing: boolean
    readonly deterministic: boolean
    readonly perRecordKeys: boolean
  }
}

/** The stable code every `EnclaveNotSupportedError` (or fork subclass) carries. */
const NOT_SUPPORTED_CODE = new EnclaveNotSupportedError('sealing').code

async function expectNotSupported(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toMatchObject({ code: NOT_SUPPORTED_CODE })
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
 * fork) must satisfy. See `docs/superpowers/specs/2026-07-03-enclave-contract-v1-design.md`
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
        const kek = await enclave.deriveKey('a fixed passphrase', new Uint8Array(32).fill(7))
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
          const dek = await enclave.generateDEK()
          await expectNotSupported(() => enclave.deriveSealedFieldKey(dek, 'c', 'f'))
          await expectNotSupported(() => enclave.deriveSealedFieldKeyFromCek(dek, 'c', 'f'))
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
          const dek = await enclave.generateDEK()
          await expectNotSupported(() => enclave.encryptDeterministic('v', dek, 'c/f'))
          await expectNotSupported(() => enclave.decryptDeterministic('iv', 'data', dek))
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
          const dek = await enclave.generateDEK()
          const cek = await enclave.generateDEK()
          await expectNotSupported(() => enclave.wrapCek(cek, dek))
          await expectNotSupported(() => enclave.unwrapCek('bogus', dek))
        })
      }
    })

    describe('known-answer vectors (structure + decryptability, no leaks)', () => {
      it('every vector envelope decrypts to its known plaintext under the re-derived DEK', async () => {
        const salt = Uint8Array.from(atob(VECTOR_SALT_BASE64), (c) => c.charCodeAt(0))
        const kek = await enclave.deriveKey(VECTOR_PASSPHRASE, salt)

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
          const kek = await enclave.deriveKey(VECTOR_PASSPHRASE, salt)
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
