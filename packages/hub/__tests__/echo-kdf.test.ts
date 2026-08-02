import { describe, it, expect } from 'vitest'
import {
  encodeEchoParts,
  deriveEchoKey,
  deriveKey,
  generateSalt,
  generateDEK,
  wrapKey,
  unwrapKey,
} from '../src/kernel/enclave/index.js'

const PARTS = { prompt: 'mi chiamo vicio', echo: 'ma da piccolo mi chiamavano', key: 'ciccio' }

describe('encodeEchoParts (AG-1)', () => {
  it('is deterministic and starts with the domain context', () => {
    const a = encodeEchoParts(PARTS)
    const b = encodeEchoParts(PARTS)
    expect(a).toEqual(b)
    const ctx = new TextEncoder().encode('noydb-echo-secret-v1')
    expect(Array.from(a.slice(0, ctx.length))).toEqual(Array.from(ctx))
  })

  it('part boundaries are structural — moving a word across parts changes the encoding', () => {
    const moved = { prompt: 'mi chiamo', echo: 'vicio ma da piccolo mi chiamavano', key: 'ciccio' }
    expect(encodeEchoParts(PARTS)).not.toEqual(encodeEchoParts(moved))
  })

  it('no separator-joined string reproduces the encoding', () => {
    for (const sep of ['#', ' ', '', '\n']) {
      const joined = new TextEncoder().encode(
        [PARTS.prompt, PARTS.echo, PARTS.key].join(sep),
      )
      expect(encodeEchoParts(PARTS)).not.toEqual(joined)
    }
  })

  it('handles unicode parts', () => {
    const uni = { prompt: 'però città', echo: '🙂 emoji echo', key: 'chiave' }
    expect(encodeEchoParts(uni)).toEqual(encodeEchoParts(uni))
    expect(encodeEchoParts(uni)).not.toEqual(encodeEchoParts(PARTS))
  })

  it('length-prefixes use UTF-8 byte length, not UTF-16 code-unit length', () => {
    // 'però' is 4 UTF-16 code units but 5 UTF-8 bytes (ò is 2 bytes) — an
    // implementation that length-prefixed with `.length` instead of the
    // encoded byte length would pass every other test here while breaking
    // the self-delimiting frame (a decoder would read one byte short).
    expect('però'.length).toBe(4)
    const encoded = encodeEchoParts({ prompt: 'però', echo: 'echo text', key: 'key text' })
    const domainContextLength = new TextEncoder().encode('noydb-echo-secret-v1').length
    expect(domainContextLength).toBe(20)
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    const promptLength = view.getUint32(domainContextLength, false)
    expect(promptLength).toBe(5)
  })
})

describe('deriveEchoKey', () => {
  it('derives a working AES-KW KEK, distinct from every single-string derivation', async () => {
    const salt = generateSalt()
    const echoKek = await deriveEchoKey(PARTS, salt)
    const dek = await generateDEK()
    const wrapped = await wrapKey(dek, echoKek)
    // round-trips under the same parts
    const again = await deriveEchoKey(PARTS, salt)
    await expect(unwrapKey(wrapped, again)).resolves.toBeDefined()
    // AG-1: KDF(joined string) must NOT unwrap what KDF(parts) wrapped
    for (const sep of ['#', ' ']) {
      const joinedKek = await deriveKey([PARTS.prompt, PARTS.echo, PARTS.key].join(sep), salt)
      await expect(unwrapKey(wrapped, joinedKek)).rejects.toThrow()
    }
  }, 120_000)
})
