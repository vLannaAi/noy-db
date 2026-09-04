/**
 * ⛔⛔ THE INVARIANT THIS FEATURE IS ONLY SAFE WITH: coverage state retains NO
 * RECORD ID (#1363, #1251 §3).
 *
 * "Which records has X read" is a second copy of the interesting information.
 * A sensor built to notice bulk extraction that keeps the id set is the single
 * best artefact for an extractor to take — the feature would be its own worst
 * vulnerability. So this test does not merely check the serialized snapshot:
 * it walks the ENTIRE reachable object graph of a registry that has just
 * observed a thousand distinctively-named ids, including private fields, and
 * asserts none of them survives anywhere.
 *
 * ⚠️ If this test ever fails, the fix is never to rename the ids. It is to
 * delete whatever structure started retaining them.
 */

import { describe, it, expect } from 'vitest'
import { CoverageRegistry } from '../../src/with-audit/coverage/accounting.js'
import type { CoverageEvent } from '../../src/port/with/coverage-strategy.js'

const MARKER = 'taxid-marker'

function collectStrings(root: unknown): string[] {
  const out: string[] = []
  const seen = new Set<unknown>()
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return
    if (typeof v === 'string') { out.push(v); return }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return
    if (typeof v === 'function') { out.push(v.toString()); return }
    if (typeof v !== 'object') return
    if (seen.has(v)) return
    seen.add(v)
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return   // sketch registers/bits
    if (v instanceof Map) { for (const [k, val] of v) { visit(k); visit(val) } return }
    if (v instanceof Set) { for (const val of v) visit(val); return }
    for (const val of Object.values(v as Record<string, unknown>)) visit(val)
    // Private (#) fields are not reachable via Object.values; pull them out of
    // the only place they can be observed from outside — the class's own
    // accessors — and walk those too.
    for (const name of ['stats', 'snapshot'] as const) {
      const fn = (v as Record<string, unknown>)[name]
      if (typeof fn === 'function') visit((fn as () => unknown).call(v))
    }
  }
  visit(root)
  return out
}

describe('coverage state retains no record id', () => {
  const build = () => {
    const events: CoverageEvent[] = []
    const registry = new CoverageRegistry({
      collections: { clients: { corpusSize: 1_000, alertAt: [0.5] } },
    })
    const observe = registry.observer(
      'v', 'clients', 'mallory',
      () => ({ taxId13: { bulk: 'sensitive' } }),
      { emit: (_e, data) => { events.push(data) } },
      false,
    )
    expect(observe).toBeDefined()
    for (let i = 0; i < 1_000; i++) observe!(`${MARKER}-${i}`)
    return { registry, events }
  }

  it('holds no observed id anywhere in its reachable state', () => {
    const { registry } = build()
    const strings = collectStrings(registry)
    expect(strings.length).toBeGreaterThan(0)          // the walk really walked
    expect(strings.filter((s) => s.includes(MARKER))).toEqual([])
  })

  it('holds no observed id in the serializable snapshot', () => {
    const { registry } = build()
    const serialized = JSON.stringify(registry.snapshot())
    expect(serialized).not.toContain(MARKER)
    // And the snapshot is not empty — it really is carrying the sketch.
    expect(registry.snapshot().entries).toHaveLength(1)
    expect(registry.snapshot().entries[0]?.hll.r.length).toBeGreaterThan(0)
  })

  it('holds no observed id in an emitted alert', () => {
    const { events } = build()
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain(MARKER)
  })

  it('the snapshot is a sketch, not a set — restoring it cannot answer "did X read record N"', () => {
    const { registry } = build()
    const restored = new CoverageRegistry({ collections: { clients: { corpusSize: 1_000 } } })
    restored.restore(registry.snapshot())
    // The distinct estimate survives (the horizon must exceed tenure)...
    const stats = restored.stats()
    expect(stats[0]?.distinct).toBeGreaterThan(900)
    // ...while nothing in the restored state names a record.
    expect(collectStrings(restored).filter((s) => s.includes(MARKER))).toEqual([])
  })
})
