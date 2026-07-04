import { describe, it, expect } from 'vitest'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import {
  VDIG_SALT_DOMAIN, buildVdigAad, deriveVdigSlotKey,
  sealVdigPayload, openVdigPayload, type VdigPayload,
} from '../../src/kernel/enclave/classify/vdig.js'
import { TamperedError } from '../../src/kernel/errors.js'

const payload: VdigPayload = {
  v: 1, alg: 'PBKDF2-SHA256', iter: 600_000,
  cur: { salt: 'c2FsdA==', hash: 'aGFzaA==', at: '2026-07-04T00:00:00.000Z' },
}

describe('vdig slot seal/open', () => {
  it('pins the salt domain literal', () => {
    expect(VDIG_SALT_DOMAIN).toBe('noydb-classify-vdig')
  })

  it('AAD is the injective JSON-array encoding, version-independent', () => {
    const aad = new TextDecoder().decode(buildVdigAad('users', 'r1', 'password'))
    expect(aad).toBe('["noydb-classify-vdig","users","r1","password"]')
  })

  it('round-trips under the record CEK with matching AAD coordinates', async () => {
    const cek = await generateDEK()
    const blob = await sealVdigPayload(payload, cek, 'users', 'r1', 'password')
    expect(blob).toMatch(/^[^:]+:.+$/) // iv:data shape
    const back = await openVdigPayload(blob, cek, 'users', 'r1', 'password')
    expect(back).toEqual(payload)
  })

  it('C1: a blob spliced from ANOTHER RECORD fails the GCM auth tag (TamperedError)', async () => {
    const cek = await generateDEK()
    const blob = await sealVdigPayload(payload, cek, 'users', 'r1', 'password')
    await expect(openVdigPayload(blob, cek, 'users', 'r2', 'password')).rejects.toBeInstanceOf(TamperedError)
  })

  it('C1: a blob spliced from ANOTHER FIELD fails the GCM auth tag (TamperedError)', async () => {
    const cek = await generateDEK()
    const blob = await sealVdigPayload(payload, cek, 'users', 'r1', 'password')
    await expect(openVdigPayload(blob, cek, 'users', 'r1', 'pin')).rejects.toBeInstanceOf(TamperedError)
  })

  it('a different CEK cannot open the slot (CEK-only key, I3)', async () => {
    const cek = await generateDEK()
    const other = await generateDEK()
    const blob = await sealVdigPayload(payload, cek, 'users', 'r1', 'password')
    await expect(openVdigPayload(blob, other, 'users', 'r1', 'password')).rejects.toThrow()
  })

  it('slot keys are domain-separated per field', async () => {
    const cek = await generateDEK()
    const k1 = await deriveVdigSlotKey(cek, 'users', 'password')
    const k2 = await deriveVdigSlotKey(cek, 'users', 'pin')
    expect(k1).not.toBe(k2) // distinct non-extractable key handles
  })
})
