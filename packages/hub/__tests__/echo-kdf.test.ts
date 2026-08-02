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
import { ValidationError } from '../src/kernel/errors.js'

const PARTS = { prompt: 'mi chiamo vicio', echo: 'ma da piccolo mi chiamavano', key: 'ciccio' }

/** The shipped domain context: 0xFF (invalid UTF-8 lead byte) + the label. */
const CONTEXT = new Uint8Array([0xff, ...new TextEncoder().encode('noydb-echo-secret-v1')])

describe('encodeEchoParts (AG-1)', () => {
  it('is deterministic and starts with the domain context', () => {
    const a = encodeEchoParts(PARTS)
    const b = encodeEchoParts(PARTS)
    expect(a).toEqual(b)
    expect(Array.from(a.slice(0, CONTEXT.length))).toEqual(Array.from(CONTEXT))
  })

  it('starts with 0xFF — an encoding no string’s UTF-8 form can produce', () => {
    expect(encodeEchoParts(PARTS)[0]).toBe(0xff)
    // 0xFF is not a legal UTF-8 lead byte, so decoding replaces it with
    // U+FFFD and re-encoding can never round-trip to the original bytes.
    const encoded = encodeEchoParts(PARTS)
    const roundTripped = new TextEncoder().encode(new TextDecoder().decode(encoded))
    expect(Array.from(roundTripped)).not.toEqual(Array.from(encoded))
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
    // 1 domain byte (0xFF) + the 20-byte label.
    expect(CONTEXT.length).toBe(21)
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    const promptLength = view.getUint32(CONTEXT.length, false)
    expect(promptLength).toBe(5)
  })

  it('refuses a parts object whose fields are not all strings (type chokepoint)', () => {
    expect(() => encodeEchoParts({} as never)).toThrow(ValidationError)
    expect(() => encodeEchoParts({ prompt: 'a', echo: 'b' } as never)).toThrow(/three strings/)
    expect(() => encodeEchoParts({ prompt: 'a', echo: 1, key: 'c' } as never)).toThrow(ValidationError)
    expect(() => encodeEchoParts(undefined as never)).toThrow(ValidationError)
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

  it('AG-1 is information-theoretic: even the decoded encoding, re-typed as a string, cannot unwrap', async () => {
    // The strongest single-string candidate an attacker has is the AG-1
    // encoding itself read back as text. Because byte 0 is 0xFF (never
    // emitted by TextEncoder), that text re-encodes to different bytes and
    // its standard-mode KEK cannot open what deriveEchoKey wrapped.
    const salt = generateSalt()
    const echoKek = await deriveEchoKey(PARTS, salt)
    const wrapped = await wrapKey(await generateDEK(), echoKek)
    const asString = new TextDecoder().decode(encodeEchoParts(PARTS))
    const stringKek = await deriveKey(asString, salt)
    await expect(unwrapKey(wrapped, stringKek)).rejects.toThrow()
  }, 120_000)
})
