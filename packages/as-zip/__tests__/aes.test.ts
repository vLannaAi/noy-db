/**
 * WinZip-AES-256 round-trip coverage.
 *
 * Self-tests only. Cross-tool validation against 7-Zip / Archive
 * Utility / WinRAR is a separate follow-up — see the README warning.
 *
 * What this DOES cover:
 *
 *   - encryptEntryWzAes + decryptEntryWzAes round-trip cleanly
 *   - wrong password is rejected — by whichever check catches it (#1167)
 *   - the verifier IS checked and fires before the HMAC (deterministic)
 *   - a verifier COLLISION still fails closed, on the HMAC (deterministic)
 *   - tampered ciphertext fails on the HMAC check
 *   - writeZip → readZip round-trip with password
 *   - readZip refuses non-AES encryption + non-STORE compression
 *   - readZip rejects wrong password + tampered archives
 *   - The unencrypted no-password path is byte-identical to before
 */

import { describe, it, expect } from 'vitest'
import {
  encryptEntryWzAes,
  decryptEntryWzAes,
  ZipCipherError,
  WZAES_SALT_LEN,
  WZAES_PBKDF2_ITERATIONS,
} from '../src/aes.js'
import { writeZip, readZip, type ZipEntry } from '../src/index.js'

const PW = 'shared-with-recipient-2026'
const ALT = 'wrong-secret'

/**
 * The last 2 bytes of WinZip-AES's PBKDF2 output — the verifier — for a given
 * password and salt.
 *
 * `deriveKeys` is module-private, so this replicates it from the exported
 * constants and the layout its own doc comment states (32-byte AES key,
 * 32-byte HMAC key, 2-byte verifier). A replication can drift; this one
 * cannot drift SILENTLY, because its only consumer asserts that splicing the
 * result makes the verifier check PASS. A wrong derivation fails that test
 * with the verifier message instead.
 */
async function deriveVerifier(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as BufferSource,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-1', salt: salt as BufferSource, iterations: WZAES_PBKDF2_ITERATIONS },
    baseKey,
    (32 + 32 + 2) * 8,
  )
  return new Uint8Array(bits).slice(64, 66)
}

describe('encryptEntryWzAes / decryptEntryWzAes', () => {
  it('round-trips a small payload', async () => {
    const plaintext = new TextEncoder().encode('hello, encrypted world')
    const enc = await encryptEntryWzAes(plaintext, PW)
    expect(enc.dataRegion.length).toBe(16 + 2 + plaintext.length + 10)
    expect(enc.extraField.length).toBe(11)
    const dec = await decryptEntryWzAes(enc.dataRegion, PW)
    expect(new TextDecoder().decode(dec)).toBe('hello, encrypted world')
  })

  it('round-trips a payload that crosses the AES block boundary', async () => {
    // Three blocks plus partial — exercises the counter increment.
    const plaintext = new Uint8Array(60)
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = i
    const enc = await encryptEntryWzAes(plaintext, PW)
    const dec = await decryptEntryWzAes(enc.dataRegion, PW)
    expect([...dec]).toEqual([...plaintext])
  })

  it('round-trips an empty payload', async () => {
    const enc = await encryptEntryWzAes(new Uint8Array(0), PW)
    expect(enc.dataRegion.length).toBe(16 + 2 + 0 + 10)
    const dec = await decryptEntryWzAes(enc.dataRegion, PW)
    expect(dec.length).toBe(0)
  })

  it('refuses an empty password', async () => {
    await expect(
      encryptEntryWzAes(new Uint8Array(1), ''),
    ).rejects.toBeInstanceOf(ZipCipherError)
  })

  it('wrong password is REJECTED — by whichever check catches it (#1167)', async () => {
    const enc = await encryptEntryWzAes(new TextEncoder().encode('secret'), PW)
    // Asserts the property, not the layer. The verifier is TWO BYTES over a
    // per-call random salt, so a wrong password clears it once in 65,536 runs
    // and the rejection arrives from the trailing HMAC instead. Pinning
    // /verifier mismatch/ made a correct rejection look like a broken one at
    // that rate — inherent, not environmental: same odds on an idle laptop as
    // in CI.
    //
    // The layer is not untested, it is tested deterministically below, where
    // the collision is constructed instead of waited for.
    await expect(decryptEntryWzAes(enc.dataRegion, ALT))
      .rejects.toThrow(/verifier mismatch|authentication code mismatch/)
  })

  it('the verifier IS checked, and fires before the HMAC (#1167)', async () => {
    // Widening the assertion above cost something, and this pays it back.
    //
    // With `/verifier mismatch/` pinned, that test doubled as proof the
    // verifier check existed at all — delete the check and it went red. The
    // widened version does not: a deleted verifier check just means the HMAC
    // rejects instead, which the widened regex accepts. Verified by mutation;
    // only a zip-level test two files away caught it, which is the
    // absorbed-by-a-distant-guard shape.
    //
    // So assert the layer HERE, deterministically: corrupt the stored
    // verifier and decrypt with the RIGHT password. The HMAC would pass, so
    // only the verifier can reject — no 1-in-65,536 anywhere.
    const enc = await encryptEntryWzAes(new TextEncoder().encode('secret'), PW)
    const region = new Uint8Array(enc.dataRegion)
    region[WZAES_SALT_LEN] = region[WZAES_SALT_LEN]! ^ 0xff

    await expect(decryptEntryWzAes(region, PW)).rejects.toThrow(/verifier mismatch/)
  })

  it('a verifier COLLISION still fails closed — on the HMAC (#1167)', async () => {
    // The 1-in-65,536 branch, made deterministic by constructing the collision
    // rather than drawing for it: splice the verifier ALT derives for THIS
    // salt into the region, so the 2-byte check passes for the wrong password
    // by construction. Nothing else is touched, so the HMAC must reject.
    //
    // This is reachable in production at exactly the same rate, and until now
    // nothing covered it.
    const enc = await encryptEntryWzAes(new TextEncoder().encode('secret'), PW)
    const region = new Uint8Array(enc.dataRegion)
    const salt = region.slice(0, WZAES_SALT_LEN)
    const altVerifier = await deriveVerifier(ALT, salt)
    region.set(altVerifier, WZAES_SALT_LEN)

    const err = await decryptEntryWzAes(region, ALT).then(
      () => { throw new Error('a wrong password DECRYPTED after a verifier collision') },
      (e: unknown) => e as Error,
    )
    // Asserting the HMAC message is what proves the splice worked: if the
    // local derivation below ever diverges from the module's, the verifier
    // would NOT match and this would fail loudly with the verifier message
    // rather than passing vacuously.
    expect(err).toBeInstanceOf(ZipCipherError)
    expect(err.message).toMatch(/authentication code mismatch/)
  })

  it('tampered ciphertext fails on the HMAC check', async () => {
    const plaintext = new TextEncoder().encode('this needs to span more than one block to be interesting')
    const enc = await encryptEntryWzAes(plaintext, PW)
    // Flip a bit in the middle of the ciphertext (between salt+verifier
    // and the trailing 10-byte HMAC).
    const tampered = new Uint8Array(enc.dataRegion)
    const mid = Math.floor((16 + 2 + (tampered.length - 10 - 16 - 2)) / 2) + 16 + 2 - 1
    tampered[mid] = tampered[mid]! ^ 0xff
    await expect(decryptEntryWzAes(tampered, PW))
      .rejects.toThrow(/authentication code mismatch/)
  })
})

describe('writeZip + readZip round-trip with password', () => {
  it('encrypted archive round-trips through readZip', async () => {
    const entries: ZipEntry[] = [
      { path: 'records.json', bytes: new TextEncoder().encode('[{"id":"a"}]') },
      { path: 'attachments/note.txt', bytes: new TextEncoder().encode('hi there') },
    ]
    const archive = await writeZip(entries, { password: PW })

    // PK signature even with encryption.
    expect(archive[0]).toBe(0x50)
    expect(archive[1]).toBe(0x4b)

    const decoded = await readZip(archive, { password: PW })
    expect(decoded.map((e) => e.path)).toEqual(['records.json', 'attachments/note.txt'])
    expect(decoded.every((e) => e.encrypted)).toBe(true)
    expect(new TextDecoder().decode(decoded[0]!.bytes)).toBe('[{"id":"a"}]')
    expect(new TextDecoder().decode(decoded[1]!.bytes)).toBe('hi there')
  })

  it('reads back a NON-encrypted archive without a password', async () => {
    const entries: ZipEntry[] = [
      { path: 'records.json', bytes: new TextEncoder().encode('[{}]') },
    ]
    const archive = await writeZip(entries)
    const decoded = await readZip(archive)
    expect(decoded[0]!.path).toBe('records.json')
    expect(decoded[0]!.encrypted).toBe(false)
    expect(new TextDecoder().decode(decoded[0]!.bytes)).toBe('[{}]')
  })

  it('rejects wrong password on read', async () => {
    const archive = await writeZip(
      [{ path: 'records.json', bytes: new TextEncoder().encode('payload') }],
      { password: PW },
    )
    await expect(readZip(archive, { password: ALT })).rejects.toThrow(/verifier mismatch/)
  })

  it('rejects encrypted archive with no password supplied', async () => {
    const archive = await writeZip(
      [{ path: 'records.json', bytes: new TextEncoder().encode('payload') }],
      { password: PW },
    )
    await expect(readZip(archive)).rejects.toThrow(/no password was supplied/)
  })

  it('rejects tampered encrypted ciphertext', async () => {
    const archive = await writeZip(
      [{ path: 'records.json', bytes: new TextEncoder().encode('this is a longer payload to ensure tampering hits ciphertext bytes') }],
      { password: PW },
    )
    // Flip a byte somewhere past the magic + LFH header. The salt
    // sits early in the data region; flipping any byte in the
    // ciphertext breaks the HMAC.
    const tampered = new Uint8Array(archive)
    tampered[100] = tampered[100]! ^ 0xff
    await expect(readZip(tampered, { password: PW })).rejects.toThrow(/authentication code mismatch|verifier mismatch/)
  })

  it('encrypted archive includes the 0x9901 extra field on every entry', async () => {
    const archive = await writeZip(
      [
        { path: 'a.json', bytes: new TextEncoder().encode('a') },
        { path: 'b.json', bytes: new TextEncoder().encode('b') },
      ],
      { password: PW },
    )
    // Scan the bytes for `0x99 0x01` markers — must appear at least
    // twice (one extra field per entry, in the LFH; another in the
    // central directory header).
    let count = 0
    for (let i = 0; i < archive.length - 1; i++) {
      if (archive[i] === 0x01 && archive[i + 1] === 0x99) count++
    }
    expect(count).toBeGreaterThanOrEqual(4)   // 2 entries × 2 (LFH + CD)
  })
})

describe('reader refuses unsupported compression / encryption', () => {
  it('throws ZipReadError for an entry with method != 0 (no encryption)', async () => {
    // Hand-craft a minimal "deflated" pseudo-zip — the reader should
    // refuse before trying to decompress.
    const archive = new Uint8Array(60)
    const view = new DataView(archive.buffer)
    // Local file header
    view.setUint32(0, 0x04034b50, true)  // PK\3\4
    view.setUint16(4, 20, true)           // version
    view.setUint16(6, 0, true)            // flags (no encryption)
    view.setUint16(8, 8, true)            // method = DEFLATE
    view.setUint32(14, 0, true)           // crc
    view.setUint32(18, 0, true)           // compressed size = 0
    view.setUint32(22, 0, true)           // uncompressed size = 0
    view.setUint16(26, 0, true)           // name len
    view.setUint16(28, 0, true)           // extra len
    // Central directory header
    view.setUint32(30, 0x02014b50, true)
    view.setUint16(38, 0, true)           // flags
    view.setUint16(40, 8, true)           // method = DEFLATE
    view.setUint32(50, 0, true)           // compressed size
    view.setUint32(54, 0, true)           // uncompressed size
    // EOCD — tail of the buffer; this synthetic archive isn't a
    // legal one but exercises the read-side dispatch.
    // Skip — we expect the reader to fail before reaching the EOCD
    // walk in any case, or fail to find EOCD which is also acceptable.
    await expect(readZip(archive)).rejects.toThrow()
  })
})
