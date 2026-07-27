/**
 * #813 — `computed()` must install its own via binder.
 *
 * Every via declaration factory is the binding's opt-in unit: constructing a
 * descriptor has to leave the binder installed in whatever module instance
 * produced it. `money()` and `lookup()` always did this; `computed()` did not —
 * its binder was installed by a *different* module (`port/with/computed-strategy.ts`),
 * which the kernel spine happens to import.
 *
 * That works whenever the consumer's `computed` import and the kernel spine resolve
 * to a single module instance, and fails when they do not. A consumer running vitest
 * with `server.deps.inline: [/@noy-db\/.*​/]` hit exactly that: `isComputedDescriptor()`
 * accepted the descriptor while the binder registry consulted at bind time — a
 * different transformed instance — had no `computed` entry, yielding `VIA_NOT_LINKED`.
 * money/i18n/dictKey were immune purely because they self-link.
 *
 * The test isolates the module registry so that only the descriptor module is loaded:
 * no kernel spine, no port module. If `computed()` did not self-link, `isViaInstalled`
 * would be false here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('#813 — computed() self-links its via binder', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('installs the binder without the kernel spine or port module being loaded', async () => {
    // Fresh registry: import ONLY the via registry and the descriptor factory.
    const { isViaInstalled } = await import('../../src/kernel/via/index.js')
    const { computed } = await import('../../src/via/computed/descriptor.js')

    // Constructing the descriptor is what must install the binder.
    computed((r) => String(r.a ?? ''))

    expect(isViaInstalled('computed')).toBe(true)
  })

  it('matches the money()/lookup() precedent — those already self-linked', async () => {
    const { isViaInstalled } = await import('../../src/kernel/via/index.js')
    const { money } = await import('../../src/via/money/descriptor.js')

    money({ currency: 'THB' })

    expect(isViaInstalled('money')).toBe(true)
  })

  it('is idempotent — repeated construction keeps one first-wins binder', async () => {
    const { isViaInstalled } = await import('../../src/kernel/via/index.js')
    const { computed } = await import('../../src/via/computed/descriptor.js')

    computed(() => 1)
    computed(() => 2, { mode: 'virtual' })
    computed(() => 3, { deps: ['a'] })

    expect(isViaInstalled('computed')).toBe(true)
  })

  it('still produces a correctly branded descriptor', async () => {
    const { computed, isComputedDescriptor } = await import('../../src/via/computed/descriptor.js')

    const d = computed((r) => r.amount, { mode: 'virtual', deps: ['amount'] })

    expect(isComputedDescriptor(d)).toBe(true)
    expect(d.mode).toBe('virtual')
    expect(d.deps).toEqual(['amount'])
  })
})
