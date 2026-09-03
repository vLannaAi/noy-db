/**
 * Pin test — `with-party/team/wrapped-deks.ts`'s `mintWrappedDeksBlob` /
 * `unwrapDeksFromBlob` are being moved onto the enclave barrel one primitive
 * at a time (milestone 59: #1315 helpers, #1316 recovery secret, #1317 DEK
 * serialization). `WrappedDeksBlob` is a PERSISTED wire format —
 * `_meta/recovery-paper`, `_meta/recovery-shamir` and tier-2 password slots
 * all extend it — and the free-format-break window is closed, so every one
 * of those steps must be byte-compatible with what is on disk today.
 *
 * A round-trip test (mint → unwrap) cannot prove that: it passes when both
 * sides change together. Same technique as `wrapped-deks-derivation-pin.test.ts`:
 * the CURRENT mint and unwrap bodies are reconstructed here verbatim as an
 * oracle, and the live functions are asserted cross-compatible with them in
 * both directions. If any step changes a byte of the blob, one direction
 * fails to authenticate and the AES-GCM decrypt throws.
 *
 * The oracle is deliberately frozen at the pre-milestone code. Do NOT update
 * it to track refactors — that is the drift this file exists to catch.
 */
import { describe, it, expect } from 'vitest'
import { mintWrappedDeksBlob, unwrapDeksFromBlob, type WrappedDeksBlob } from '../src/with-party/team/wrapped-deks.js'
import { generateDEK, type EnclaveKey } from '../src/kernel/enclave/index.js'
import { InvalidKeyError, TamperedError } from '../src/kernel/errors.js'

const subtle = globalThis.crypto.subtle

// ─── Oracle: byte-for-byte the wrapped-deks.ts code as of milestone 59 start ──

const ORACLE_PBKDF2_ITERATIONS = 600_000
const ORACLE_SALT_BYTES = 32
const ORACLE_IV_BYTES = 12

async function oracleDeriveWrappingKey(credential: string, salt: Uint8Array): Promise<CryptoKey> {
  const ikm = await subtle.importKey('raw', new TextEncoder().encode(credential), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: ORACLE_PBKDF2_ITERATIONS, hash: 'SHA-256' },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function oracleBytesToBase64(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}

function oracleBase64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

async function oracleMint(deks: Map<string, EnclaveKey>, credential: string): Promise<WrappedDeksBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(ORACLE_SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(ORACLE_IV_BYTES))
  const wrappingKey = await oracleDeriveWrappingKey(credential, salt)
  const exported: Record<string, string> = {}
  for (const [coll, dek] of deks) {
    const raw = await subtle.exportKey('raw', dek)
    exported[coll] = oracleBytesToBase64(new Uint8Array(raw))
  }
  const plaintext = new TextEncoder().encode(JSON.stringify({ deks: exported }))
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, wrappingKey, plaintext as BufferSource)
  return {
    salt: oracleBytesToBase64(salt),
    iv: oracleBytesToBase64(iv),
    wrappedDeks: oracleBytesToBase64(new Uint8Array(ciphertext)),
  }
}

async function oracleUnwrap(blob: WrappedDeksBlob, credential: string): Promise<Map<string, EnclaveKey>> {
  const wrappingKey = await oracleDeriveWrappingKey(credential, oracleBase64ToBytes(blob.salt))
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: oracleBase64ToBytes(blob.iv) as BufferSource },
    wrappingKey,
    oracleBase64ToBytes(blob.wrappedDeks) as BufferSource,
  )
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { deks: Record<string, string> }
  const deks = new Map<string, EnclaveKey>()
  for (const [coll, b64] of Object.entries(parsed.deks)) {
    const key = await subtle.importKey('raw', oracleBase64ToBytes(b64) as BufferSource, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    deks.set(coll, key)
  }
  return deks
}

// ─── Fixtures ──────────────────────────────────────────────────────────

const CREDENTIAL = 'correct horse battery staple'
const PROBE = new TextEncoder().encode('wrapped-deks blob pin — fixed probe plaintext')
const PROBE_IV = new Uint8Array(12).fill(5)

async function freshDekSet(): Promise<Map<string, EnclaveKey>> {
  return new Map([
    ['notes', await generateDEK()],
    ['contacts', await generateDEK()],
  ])
}

/** Two DEK sets hold the same key material iff each pair can decrypt the other's ciphertext. */
async function expectSameDeks(a: Map<string, EnclaveKey>, b: Map<string, EnclaveKey>): Promise<void> {
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort())
  for (const [coll, dekA] of a) {
    const dekB = b.get(coll)!
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv: PROBE_IV as BufferSource }, dekA, PROBE as BufferSource)
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: PROBE_IV as BufferSource }, dekB, ct)
    expect(new Uint8Array(pt)).toEqual(PROBE)
  }
}

async function rawBase64(dek: EnclaveKey): Promise<string> {
  return oracleBytesToBase64(new Uint8Array(await subtle.exportKey('raw', dek)))
}

// ─── Pins ──────────────────────────────────────────────────────────────

describe('WrappedDeksBlob — byte-compatible with the pre-milestone-59 wire format', () => {
  it('a blob minted by the ORACLE unwraps under the LIVE unwrapDeksFromBlob', async () => {
    const deks = await freshDekSet()
    const blob = await oracleMint(deks, CREDENTIAL)
    const recovered = await unwrapDeksFromBlob(blob, CREDENTIAL)
    await expectSameDeks(deks, recovered)
  })

  it('a blob minted by the LIVE mintWrappedDeksBlob unwraps under the ORACLE', async () => {
    const deks = await freshDekSet()
    const blob = await mintWrappedDeksBlob(deks, CREDENTIAL)
    const recovered = await oracleUnwrap(blob, CREDENTIAL)
    await expectSameDeks(deks, recovered)
  })

  it('the LIVE blob keeps the oracle field shape: 32-byte salt, 12-byte IV, base64 throughout', async () => {
    const blob = await mintWrappedDeksBlob(await freshDekSet(), CREDENTIAL)
    expect(Object.keys(blob).sort()).toEqual(['iv', 'salt', 'wrappedDeks'])
    expect(oracleBase64ToBytes(blob.salt).length).toBe(ORACLE_SALT_BYTES)
    expect(oracleBase64ToBytes(blob.iv).length).toBe(ORACLE_IV_BYTES)
  })

  it('the LIVE blob body is `{ deks: { coll: base64(rawDek) } }` — the encoding #1317 must reproduce', async () => {
    // Opened with the oracle's key so the assertion is about the bytes the
    // live mint wrote, not about what the live unwrap can read.
    const deks = await freshDekSet()
    const blob = await mintWrappedDeksBlob(deks, CREDENTIAL)
    const key = await oracleDeriveWrappingKey(CREDENTIAL, oracleBase64ToBytes(blob.salt))
    const body = await subtle.decrypt(
      { name: 'AES-GCM', iv: oracleBase64ToBytes(blob.iv) as BufferSource },
      key,
      oracleBase64ToBytes(blob.wrappedDeks) as BufferSource,
    )
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { deks: Record<string, string> }
    expect(Object.keys(parsed)).toEqual(['deks'])
    for (const [coll, dek] of deks) {
      expect(parsed.deks[coll]).toBe(await rawBase64(dek))
    }
  })

  it('sanity: a wrong credential is refused by BOTH sides (the pin is not vacuous)', async () => {
    const deks = await freshDekSet()
    const fromOracle = await oracleMint(deks, CREDENTIAL)
    const fromLive = await mintWrappedDeksBlob(deks, CREDENTIAL)
    await expect(unwrapDeksFromBlob(fromOracle, 'wrong credential')).rejects.toThrow()
    await expect(oracleUnwrap(fromLive, 'wrong credential')).rejects.toThrow()
  })

  it('a wrong credential surfaces InvalidKeyError, never TamperedError (#1318, lanna-db #4 rule 3)', async () => {
    // TamperedError means exactly "AEAD failed under THIS key" and is the
    // enclave's to throw. A recovery code / password / share set that does
    // not match the blob is a wrong KEY, and reporting it as tampering is the
    // misdiagnosis #1288 reported from a consumer. The barrel's decryptBytes
    // does throw TamperedError on auth failure; wrapped-deks catches it and
    // rethrows the class whose own docstring already says "wrong secret or
    // corrupted keyring" — as on-password does one layer up.
    const blob = await mintWrappedDeksBlob(await freshDekSet(), CREDENTIAL)
    const err = await unwrapDeksFromBlob(blob, 'wrong credential').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidKeyError)
    expect(err).not.toBeInstanceOf(TamperedError)
  })
})
