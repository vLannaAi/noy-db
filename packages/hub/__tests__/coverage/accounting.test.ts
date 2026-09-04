/**
 * Coverage accounting + set-completion alerts (#1363).
 *
 * ⛔⛔ Telemetry, not a control: against an insider holding the device and
 * local keys this prevents nothing, it makes bulk extraction visible early,
 * attributable and loud. Key custody is the remediation. Every assertion below
 * is about a SIGNAL; there is no refusal to test because there is none to
 * build.
 */

import { describe, it, expect, vi } from 'vitest'
import { CoverageRegistry } from '../../src/with-audit/coverage/accounting.js'
import { NO_COVERAGE } from '../../src/port/with/coverage-strategy.js'
import type { CoverageEvent } from '../../src/port/with/coverage-strategy.js'

function harness(opts: ConstructorParameters<typeof CoverageRegistry>[0] = {}, meta: Record<string, { bulk?: 'sensitive' }> = { taxId13: { bulk: 'sensitive' } }) {
  const events: CoverageEvent[] = []
  const registry = new CoverageRegistry(opts)
  const observe = registry.observer('acme', 'clients', 'alice', () => meta, { emit: (_e, d) => { events.push(d) } }, false)
  return { registry, events, observe }
}

describe('who is accounted', () => {
  it('accounts a collection that declares bulk: sensitive', () => {
    const { registry, observe } = harness()
    observe!('c1')
    expect(registry.stats()[0]?.served).toBe(1)
  })

  it('does NOT account a collection with no bulk field and no declared policy', () => {
    const { registry, observe } = harness({}, { name: {} })
    observe!('c1')
    expect(registry.stats()).toEqual([])
  })

  it('accounts a collection named in `collections` even without a bulk field', () => {
    const { registry, observe } = harness({ collections: { clients: { corpusSize: 10 } } }, { name: {} })
    observe!('c1')
    expect(registry.stats()[0]?.served).toBe(1)
  })

  it('resolves the bulk declaration LAZILY — fieldMeta can be attached after construction', () => {
    const events: CoverageEvent[] = []
    const registry = new CoverageRegistry()
    let meta: Record<string, { bulk?: 'sensitive' }> | undefined
    const observe = registry.observer('acme', 'clients', 'alice', () => meta, { emit: (_e, d) => { events.push(d) } }, false)
    meta = { taxId13: { bulk: 'sensitive' } }   // _applyFieldMeta, post-construction
    observe!('c1')
    expect(registry.stats()[0]?.served).toBe(1)
  })

  it('keys accounting by (principal, vault, collection)', () => {
    const registry = new CoverageRegistry()
    const meta = () => ({ taxId13: { bulk: 'sensitive' as const } })
    const emit = { emit: () => {} }
    registry.observer('acme', 'clients', 'alice', meta, emit, false)!('c1')
    registry.observer('acme', 'clients', 'bob', meta, emit, false)!('c1')
    registry.observer('other', 'clients', 'alice', meta, emit, false)!('c1')
    expect(registry.stats()).toHaveLength(3)
  })

  it('⛔ refuses to account an EAGER bulk collection, loudly — hydration decrypts the whole corpus', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const registry = new CoverageRegistry({ collections: { clients: { corpusSize: 30 } } })
    const observe = registry.observer('acme', 'clients', 'alice', () => ({ taxId13: { bulk: 'sensitive' as const } }), { emit: () => {} }, true)
    observe!('c1')
    observe!('c2')
    expect(registry.stats()).toEqual([])                       // nothing accounted
    expect(warn).toHaveBeenCalledTimes(1)                      // and said so, once
    expect(warn.mock.calls[0]?.[0]).toContain('prefetch: false')
    warn.mockRestore()
  })

  it('NO_COVERAGE — the un-opted-in floor — resolves no observer at all', () => {
    expect(NO_COVERAGE.observer('acme', 'clients', 'alice', () => ({ t: { bulk: 'sensitive' } }), { emit: () => {} }, false))
      .toBeUndefined()
  })
})

describe('coverage, novelty and burstiness', () => {
  it('counts distinct-ever, not calls — 50 re-reads of one record is coverage 1/1000', () => {
    const { registry, observe } = harness({ collections: { clients: { corpusSize: 1_000 } } })
    for (let i = 0; i < 50; i++) observe!('c1')
    const s = registry.stats()[0]!
    expect(s.served).toBe(50)
    expect(s.distinct).toBe(1)
    expect(s.coverage).toBeCloseTo(0.001, 5)
  })

  it('novelty separates the working-subset reader from the extractor at equal volume', () => {
    const worker = harness({ collections: { clients: { corpusSize: 1_000 } } })
    const extractor = harness({ collections: { clients: { corpusSize: 1_000 } } })
    for (let i = 0; i < 500; i++) worker.observe!(`c${i % 10}`)     // 500 reads, 10 records
    for (let i = 0; i < 500; i++) extractor.observe!(`c${i}`)       // 500 reads, 500 records
    expect(worker.registry.stats()[0]?.novelInWindow).toBe(10)
    expect(extractor.registry.stats()[0]?.novelInWindow).toBeGreaterThan(490)
    expect(worker.registry.stats()[0]?.served).toBe(extractor.registry.stats()[0]?.served)
  })

  it('the coverage horizon does NOT reset with the novelty window', () => {
    let now = 0
    const { registry, observe } = harness({ windowMs: 1_000, now: () => now, collections: { clients: { corpusSize: 100 } } })
    for (let i = 0; i < 40; i++) observe!(`c${i}`)
    now = 10_000                                  // many windows later
    for (let i = 40; i < 80; i++) observe!(`c${i}`)
    const s = registry.stats()[0]!
    expect(s.distinct).toBeGreaterThanOrEqual(78) // ~80, not ~40
    expect(s.novelInWindow).toBeLessThanOrEqual(41) // novelty DID reset
  })

  it('burstiness compares this window against the mean of the closed ones', () => {
    let now = 0
    const { registry, observe } = harness({ windowMs: 1_000, now: () => now })
    for (let i = 0; i < 10; i++) observe!(`a${i}`)   // window 1: 10 reads
    now = 2_000
    for (let i = 0; i < 100; i++) observe!(`b${i}`)  // window 2: 100 reads
    expect(registry.stats()[0]?.burstiness).toBeCloseTo(10, 5)
  })

  it('leaves coverage undefined when no corpusSize is declared — and then never alerts', () => {
    const { registry, events, observe } = harness()
    for (let i = 0; i < 500; i++) observe!(`c${i}`)
    expect(registry.stats()[0]?.coverage).toBeUndefined()
    expect(events).toEqual([])
  })
})

describe('set-completion alerts', () => {
  it('emits at each declared threshold, once, with the agreed event shape', () => {
    const { events, observe } = harness({ collections: { clients: { corpusSize: 1_000, alertAt: [0.6, 0.9] } } })
    for (let i = 0; i < 1_000; i++) observe!(`c${i}`)
    expect(events).toHaveLength(2)
    const [first] = events
    expect(Object.keys(first!).sort()).toEqual(
      ['collection', 'coverage', 'novel', 'principal', 'served', 'source', 'vault', 'window'],
    )
    expect(first!.principal).toBe('alice')
    expect(first!.vault).toBe('acme')
    expect(first!.collection).toBe('clients')
    expect(first!.source).toBe('hub/coverage')
    expect(first!.coverage).toBeGreaterThanOrEqual(0.6)
    expect(events[1]!.coverage).toBeGreaterThanOrEqual(0.9)
    expect(new Date(first!.window).toISOString()).toBe(first!.window)
  })

  it('does not re-fire a threshold once crossed', () => {
    const { events, observe } = harness({ collections: { clients: { corpusSize: 100, alertAt: [0.5] } } })
    for (let i = 0; i < 500; i++) observe!(`c${i}`)
    expect(events).toHaveLength(1)
  })

  it('SIGNALS — it never refuses: the observer returns void and the read proceeds', () => {
    const { observe } = harness({ collections: { clients: { corpusSize: 1, alertAt: [0.1] } } })
    expect(observe!('c1')).toBeUndefined()
    expect(() => observe!('c2')).not.toThrow()
  })
})
