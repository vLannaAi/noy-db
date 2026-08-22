import { describe, it, expect } from 'vitest'
import {
  buildEchoBlock,
  verifyPrompt,
  resolveEchoReveal,
  verifyTypedEcho,
} from '../src/with-party/team/echo-secret.js'
import { MemoryDeviceSeal } from '../src/with-party/team/device-seal.js'
import { WrongPromptError, ValidationError } from '../src/kernel/errors.js'
import { bufferToBase64, base64ToBuffer } from '../src/kernel/enclave/index.js'

const PARTS = { prompt: 'mi chiamo vicio', echo: 'da piccolo mi chiamavano', key: 'ciccio' }
const T = 240_000 // real 600K PBKDF2, several derivations per test

/** Flip one byte of a base64 blob so it decodes to different bytes (same length). */
function tamperBase64(b64: string): string {
  const bytes = base64ToBuffer(b64)
  bytes[0] = (bytes[0]! ^ 0xff) & 0xff
  return bufferToBase64(bytes)
}

describe('echo block', () => {
  it('portable: verifies prompt, reveals echo, rejects wrong prompt', async () => {
    const block = await buildEchoBlock(PARTS, { kind: 'portable' })
    expect(block.reveal.kind).toBe('portable')
    expect(await verifyPrompt(block, PARTS.prompt)).toBe(true)
    expect(await verifyPrompt(block, 'wrong prompt entirely')).toBe(false)
    expect(await resolveEchoReveal(block, PARTS.prompt)).toBe(PARTS.echo)
  }, T)

  it('portable: prompt_salt and the reveal blob salt are independent (no key-material reuse)', async () => {
    const block = await buildEchoBlock(PARTS, { kind: 'portable' })
    if (block.reveal.kind !== 'portable') throw new Error('expected portable reveal')
    expect(block.prompt_salt).not.toBe(block.reveal.salt)
  }, T)

  it('portable: wrong prompt rejects resolveEchoReveal with WrongPromptError (no silent degrade)', async () => {
    const block = await buildEchoBlock(PARTS, { kind: 'portable' })
    await expect(resolveEchoReveal(block, 'wrong prompt entirely')).rejects.toThrow(WrongPromptError)
  }, T)

  it('sealed: reveals only with the enrolling device provider', async () => {
    const seal = new MemoryDeviceSeal({ id: 'test:mem' })
    const block = await buildEchoBlock(PARTS, { kind: 'sealed', deviceSeal: seal })
    expect(block.reveal.kind).toBe('sealed')
    expect(await resolveEchoReveal(block, PARTS.prompt, seal)).toBe(PARTS.echo)
    // foreign device (no provider) ⇒ degraded typed-echo path
    expect(await resolveEchoReveal(block, PARTS.prompt)).toBeNull()
    expect(await verifyTypedEcho(block, PARTS.echo)).toBe(true)
    expect(await verifyTypedEcho(block, 'not my echo')).toBe(false)
  }, T)

  it('sealed: a genuinely foreign provider (different id) degrades to null, not an error', async () => {
    const enrolling = new MemoryDeviceSeal({ id: 'device:enrolling' })
    const foreign = new MemoryDeviceSeal({ id: 'device:foreign' })
    const block = await buildEchoBlock(PARTS, { kind: 'sealed', deviceSeal: enrolling })
    expect(await resolveEchoReveal(block, PARTS.prompt, foreign)).toBeNull()
  }, T)

  it('sealed: same provider id but a tampered blob rejects (genuine tamper anomaly, not masked)', async () => {
    const seal = new MemoryDeviceSeal({ id: 'test:mem' })
    const block = await buildEchoBlock(PARTS, { kind: 'sealed', deviceSeal: seal })
    if (block.reveal.kind !== 'sealed') throw new Error('expected sealed reveal')
    const tampered = { ...block, reveal: { ...block.reveal, blob: tamperBase64(block.reveal.blob) } }
    await expect(resolveEchoReveal(tampered, PARTS.prompt, seal)).rejects.toThrow()
  }, T)

  it('none: never reveals, typed echo still verifiable, mask_hint carried', async () => {
    const block = await buildEchoBlock(PARTS, { kind: 'none' }, 'first-letters')
    expect(block.reveal.kind).toBe('none')
    expect(block.mask_hint).toBe('first-letters')
    expect(await resolveEchoReveal(block, PARTS.prompt)).toBeNull()
    expect(await verifyTypedEcho(block, PARTS.echo)).toBe(true)
  }, T)

  it('mask_hint is omitted (undefined), not just falsy, when not passed', async () => {
    const block = await buildEchoBlock(PARTS, { kind: 'none' })
    expect(block.mask_hint).toBeUndefined()
    expect('mask_hint' in block).toBe(false)
  }, T)

  it('verifyPrompt / verifyTypedEcho resolve false (never throw) on a corrupt base64 salt', async () => {
    const block = await buildEchoBlock(PARTS, { kind: 'none' })
    const badPromptSalt = { ...block, prompt_salt: 'not valid base64!!' }
    const badEchoSalt = { ...block, echo_salt: 'not valid base64!!' }
    await expect(verifyPrompt(badPromptSalt, PARTS.prompt)).resolves.toBe(false)
    await expect(verifyTypedEcho(badEchoSalt, PARTS.echo)).resolves.toBe(false)
  }, T)

  it('refuses to mint a block from malformed parts (encodeEchoParts chokepoint)', async () => {
    // Without the guard a missing field would be TextEncoder-coerced to the
    // literal "undefined" and a block WOULD be minted, permanently mismatched
    // with the KEK the owner can derive.
    await expect(buildEchoBlock({ prompt: 'mi chiamo vicio', key: 'ciccio' } as never, { kind: 'none' })).rejects.toThrow(
      ValidationError,
    )
  }, T)

  it('unicode parts round-trip through build → verify → reveal', async () => {
    const uni = { prompt: 'però città 🏔️', echo: '🙂 emoji echo città', key: 'chiave' }
    const block = await buildEchoBlock(uni, { kind: 'portable' })
    expect(await verifyPrompt(block, uni.prompt)).toBe(true)
    expect(await resolveEchoReveal(block, uni.prompt)).toBe(uni.echo)
    expect(await verifyTypedEcho(block, uni.echo)).toBe(true)
  }, T)
})
