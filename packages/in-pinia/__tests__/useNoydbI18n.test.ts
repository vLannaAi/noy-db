/**
 * useNoydbI18n — reactive active-locale store.
 *
 * State-only by default; vault.setLocale only on explicit opt-in;
 * bindTo follows an external ref one-way and never touches a vault.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ref } from 'vue'
import { useNoydbI18n } from '../src/useNoydbI18n.js'

beforeEach(() => setActivePinia(createPinia()))

describe('useNoydbI18n', () => {
  it('defaults to en + [en, any]', () => {
    const i = useNoydbI18n()
    expect(i.locale).toBe('en')
    expect(i.fallback).toEqual(['en', 'any'])
  })

  it('setLocale updates state (state-only, no vault touched)', () => {
    const i = useNoydbI18n()
    i.setLocale('th')
    expect(i.locale).toBe('th')
  })

  it('setFallback updates the chain', () => {
    const i = useNoydbI18n()
    i.setFallback(['th', 'any'])
    expect(i.fallback).toEqual(['th', 'any'])
  })

  it('setLocale with syncVault calls vault.setLocale on the given vault(s)', () => {
    const i = useNoydbI18n()
    const v1 = { setLocale: vi.fn() }
    const v2 = { setLocale: vi.fn() }
    i.setLocale('th', { syncVault: [v1, v2] })
    expect(v1.setLocale).toHaveBeenCalledWith('th')
    expect(v2.setLocale).toHaveBeenCalledWith('th')
    expect(i.locale).toBe('th')
  })

  it('bindTo mirrors an external ref one-way and never syncs a vault', () => {
    const i = useNoydbI18n()
    const ext = ref('ja')
    const stop = i.bindTo(ext) // immediate by default
    expect(i.locale).toBe('ja')
    ext.value = 'th'
    expect(i.locale).toBe('th')
    stop()
    ext.value = 'en'
    expect(i.locale).toBe('th') // stopped — no longer follows
  })
})
