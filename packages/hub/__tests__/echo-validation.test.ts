import { describe, it, expect } from 'vitest'
import {
  validateEchoSecret,
  assertStrongEchoSecret,
  WeakSecretError,
} from '../src/kernel/validation.js'
import { EchoCeremonyRequiredError, WrongPromptError, WrongEchoError } from '../src/kernel/errors.js'
import { MemoryDeviceSealProvider } from '../src/with-party/team/device-seal.js'

// NOTE: the brief's literal fixture ('mi chiamo vicio' / 'da piccolo mi
// chiamavano sempre') contains 2-letter Italian words ("mi", "da") that
// violate the pre-existing DEFAULT_MIN_WORD_LENGTH = 3 floor in
// validation.ts (unrelated to this task's new echo code) — swapped for
// words meeting that floor while keeping the same 3+5+2=10 word split.
const GOOD = { prompt: 'sono chiamato vicio', echo: 'quando ero piccolo tutti chiamavano', key: 'ciccio patata' }

describe('validateEchoSecret', () => {
  it('accepts a strong 3-part secret', () => {
    expect(validateEchoSecret(GOOD)).toEqual({ ok: true, words: 10 })
  })
  it('rejects a prompt below its dedicated floor (default 3 words)', () => {
    const r = validateEchoSecret({ ...GOOD, prompt: 'mi chiamo' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('too-few-words')
  })
  it('rejects an empty part regardless of combined length', () => {
    const r = validateEchoSecret({ ...GOOD, echo: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty')
  })
  it('applies the existing whole-secret policy to the combined parts', () => {
    // 3+1+1 = 5 words total, under the default 6-word combined floor
    const r = validateEchoSecret({ prompt: 'uno due tre', echo: 'quattro', key: 'cinque' })
    expect(r.ok).toBe(false)
  })
  it('assertStrongEchoSecret throws WeakSecretError / respects allowWeakSecret', () => {
    expect(() => assertStrongEchoSecret({ prompt: 'x', echo: 'y', key: 'z' })).toThrow(WeakSecretError)
    expect(() =>
      assertStrongEchoSecret({ prompt: 'x', echo: 'y', key: 'z' }, { allowWeakSecret: true }),
    ).not.toThrow()
  })
})

describe('echo error classes', () => {
  it('carry stable codes and names', () => {
    expect(new EchoCeremonyRequiredError().code).toBe('ECHO_CEREMONY_REQUIRED')
    expect(new WrongPromptError().code).toBe('WRONG_PROMPT')
    expect(new WrongEchoError().code).toBe('WRONG_ECHO')
    expect(new EchoCeremonyRequiredError().name).toBe('EchoCeremonyRequiredError')
  })
})

describe('MemoryDeviceSealProvider', () => {
  it('round-trips and throws on tamper', async () => {
    const p = new MemoryDeviceSealProvider({ id: 'test:mem' })
    const sealed = await p.seal(new TextEncoder().encode('the echo'))
    expect(new TextDecoder().decode(await p.unseal(sealed))).toBe('the echo')
    const tampered = sealed.slice()
    tampered[tampered.length - 1]! ^= 0xff
    await expect(p.unseal(tampered)).rejects.toThrow()
  })
})
