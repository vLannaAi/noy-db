import { describe, it, expect } from 'vitest'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import { normalizeForVerify } from '../../src/kernel/enclave/classify/normalize.js'
import {
  CLASSIFY_INDEX_KEY_DOMAIN, CLASSIFY_INDEX_SALT_DOMAIN, COST_BYTE_V1, CURRENT_COST_BYTE,
  iterationsForCostByte, deriveClassifyIndexKey, deriveClassifyIndexSalt, mintBidxTag,
} from '../../src/kernel/enclave/classify/bidx.js'

const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

describe('bidx salt/key domains + discriminator', () => {
  it('pins the two HKDF salt-domain literals and the v1 cost byte', () => {
    expect(CLASSIFY_INDEX_KEY_DOMAIN).toBe('noydb-classify-index-v1')
    expect(CLASSIFY_INDEX_SALT_DOMAIN).toBe('noydb-classify-index-salt-v1')
    expect(COST_BYTE_V1).toBe(0x01)
    expect(CURRENT_COST_BYTE).toBe(0x01)
    expect(iterationsForCostByte(0x01)).toBe(600_000)
    expect(iterationsForCostByte(0x7f)).toBeNull() // unknown tier → cheap non-match
  })

  it('salt is 32 raw bytes and separated per (collection, field)', async () => {
    const dek = await generateDEK()
    const s1 = await deriveClassifyIndexSalt(dek, 'users', 'password')
    const s2 = await deriveClassifyIndexSalt(dek, 'users', 'pin')
    const s3 = await deriveClassifyIndexSalt(dek, 'admins', 'password')
    expect(s1.length).toBe(32)
    expect([...s1]).not.toEqual([...s2]) // per-field
    expect([...s1]).not.toEqual([...s3]) // per-collection
  })
})

describe('mintBidxTag slow-tag (COST_BYTE ‖ HMAC(K_idx, PBKDF2(...)))', () => {
  it('equal normalized values → equal 33-byte tags (equatability); cost byte prefix', async () => {
    const dek = await generateDEK()
    const n = normalizeForVerify('secret-answer', 'Fluffy The Cat')
    const t1 = await mintBidxTag(n, dek, 'users', 'answer')
    const t2 = await mintBidxTag(n, dek, 'users', 'answer')
    expect(t1).toBe(t2)                              // deterministic ⇒ equatable
    const raw = b64(t1)
    expect(raw.length).toBe(33)                      // 1-byte discriminator ‖ 32-byte MAC
    expect(raw[0]).toBe(CURRENT_COST_BYTE)
  }, 30_000)

  it('join-attack separation: same value, different field OR collection → different tags', async () => {
    const dek = await generateDEK()
    const n = normalizeForVerify('password', 'correct horse battery')
    const a = await mintBidxTag(n, dek, 'users', 'password')
    const b = await mintBidxTag(n, dek, 'users', 'pin')       // different field
    const c = await mintBidxTag(n, dek, 'admins', 'password') // different collection
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  }, 30_000)

  it('different DEK → different tag (key-less store cannot mint)', async () => {
    const d1 = await generateDEK(); const d2 = await generateDEK()
    const n = normalizeForVerify('password', 'hunter2-hunter2')
    expect(await mintBidxTag(n, d1, 'users', 'password'))
      .not.toBe(await mintBidxTag(n, d2, 'users', 'password'))
  }, 30_000)
})
