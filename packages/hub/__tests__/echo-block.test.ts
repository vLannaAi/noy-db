import { describe, it, expect } from 'vitest'
import {
  buildEchoBlock,
  verifyPrompt,
  resolveEchoReveal,
  verifyTypedEcho,
} from '../src/with-party/team/echo-secret.js'
import { MemoryDeviceSealProvider } from '../src/with-party/team/device-seal.js'

const PARTS = { prompt: 'mi chiamo vicio', echo: 'da piccolo mi chiamavano', key: 'ciccio' }
const T = 240_000 // real 600K PBKDF2, several derivations per test

describe('echo block', () => {
  it('portable: verifies prompt, reveals echo, rejects wrong prompt', async () => {
    const block = await buildEchoBlock(PARTS, { kind: 'portable' })
    expect(block.reveal.kind).toBe('portable')
    expect(await verifyPrompt(block, PARTS.prompt)).toBe(true)
    expect(await verifyPrompt(block, 'wrong prompt entirely')).toBe(false)
    expect(await resolveEchoReveal(block, PARTS.prompt)).toBe(PARTS.echo)
  }, T)

  it('sealed: reveals only with the enrolling device provider', async () => {
    const seal = new MemoryDeviceSealProvider({ id: 'test:mem' })
    const block = await buildEchoBlock(PARTS, { kind: 'sealed', deviceSeal: seal })
    expect(block.reveal.kind).toBe('sealed')
    expect(await resolveEchoReveal(block, PARTS.prompt, seal)).toBe(PARTS.echo)
    // foreign device (no provider) ⇒ degraded typed-echo path
    expect(await resolveEchoReveal(block, PARTS.prompt)).toBeNull()
    expect(await verifyTypedEcho(block, PARTS.echo)).toBe(true)
    expect(await verifyTypedEcho(block, 'not my echo')).toBe(false)
  }, T)

  it('none: never reveals, typed echo still verifiable, mask_hint carried', async () => {
    const block = await buildEchoBlock(PARTS, { kind: 'none' }, 'first-letters')
    expect(block.reveal.kind).toBe('none')
    expect(block.mask_hint).toBe('first-letters')
    expect(await resolveEchoReveal(block, PARTS.prompt)).toBeNull()
    expect(await verifyTypedEcho(block, PARTS.echo)).toBe(true)
  }, T)
})
