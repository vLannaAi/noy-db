import { describe, it, expect, beforeAll } from 'vitest'
import { encrypt, decrypt } from '../src/kernel/enclave/crypto.js'
import { buildRecordAad, type RecordIdentity } from '../src/kernel/enclave/record-aad.js'
import { TamperedError } from '../src/kernel/errors.js'

const subtle = globalThis.crypto.subtle

let dek: CryptoKey

const identity: RecordIdentity = {
  vault: 'acme',
  collection: 'invoices',
  id: 'inv-1',
  tier: 0,
  by: 'alice',
}

const body = JSON.stringify({ id: 'inv-1', amount: 4200 })

beforeAll(async () => {
  dek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
})

describe('record AAD through encrypt/decrypt (#1041)', () => {
  it('1. round-trips when the identity matches', async () => {
    const aad = buildRecordAad(identity)
    const { iv, data } = await encrypt(body, dek, aad)
    expect(await decrypt(iv, data, dek, aad)).toBe(body)
  })

  it('2. relocating to another collection fails closed', async () => {
    const { iv, data } = await encrypt(body, dek, buildRecordAad(identity))
    // The store moves the envelope into a different collection and re-serves
    // it. Body and tag are untouched — only the location changed.
    const moved = buildRecordAad({ ...identity, collection: 'payments' })
    await expect(decrypt(iv, data, dek, moved)).rejects.toThrow(TamperedError)
  })

  it('3. relocating to another vault fails closed', async () => {
    const { iv, data } = await encrypt(body, dek, buildRecordAad(identity))
    const moved = buildRecordAad({ ...identity, vault: 'other-tenant' })
    await expect(decrypt(iv, data, dek, moved)).rejects.toThrow(TamperedError)
  })

  it('4. re-pointing the envelope at another record id fails closed', async () => {
    const { iv, data } = await encrypt(body, dek, buildRecordAad(identity))
    const moved = buildRecordAad({ ...identity, id: 'inv-999' })
    await expect(decrypt(iv, data, dek, moved)).rejects.toThrow(TamperedError)
  })

  it('5. the _tier silent-hide fails closed', async () => {
    // Marking a tier-0 record as tier-1 makes every tier-0 read return null
    // (`collection.ts:1428`), hiding it with no error. Binding _tier turns
    // that into a loud tamper instead of a silent disappearance.
    const { iv, data } = await encrypt(body, dek, buildRecordAad(identity))
    const retiered = buildRecordAad({ ...identity, tier: 1 })
    await expect(decrypt(iv, data, dek, retiered)).rejects.toThrow(TamperedError)
  })

  it('6. rewriting the recorded author fails closed', async () => {
    const { iv, data } = await encrypt(body, dek, buildRecordAad(identity))
    const forged = buildRecordAad({ ...identity, by: 'mallory' })
    await expect(decrypt(iv, data, dek, forged)).rejects.toThrow(TamperedError)
  })

  it('7. dropping the AAD entirely fails closed', async () => {
    // A reader that "forgets" to pass identity must not silently succeed —
    // otherwise the binding is opt-out at the call site.
    const { iv, data } = await encrypt(body, dek, buildRecordAad(identity))
    await expect(decrypt(iv, data, dek)).rejects.toThrow(TamperedError)
  })

  it('8. adding AAD to a body sealed without it fails closed', async () => {
    const { iv, data } = await encrypt(body, dek)
    await expect(decrypt(iv, data, dek, buildRecordAad(identity)))
      .rejects.toThrow(TamperedError)
  })

  it('9. no-AAD round-trip still works (the un-migrated call sites)', async () => {
    const { iv, data } = await encrypt(body, dek)
    expect(await decrypt(iv, data, dek)).toBe(body)
  })

  it('10. an absent tier and tier 0 are interchangeable', async () => {
    const { iv, data } = await encrypt(body, dek, buildRecordAad({ ...identity, tier: undefined }))
    expect(await decrypt(iv, data, dek, buildRecordAad({ ...identity, tier: 0 }))).toBe(body)
  })
})
