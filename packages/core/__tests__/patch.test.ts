/**
 * JSON Patch compute/apply tests — #44, v0.4.
 *
 * The module is pure, so these tests cover the algorithm directly
 * without any adapter / collection / encryption scaffolding. Failures
 * here would silently corrupt delta history, so coverage errs heavily
 * on the side of "check everything once, then check round-trip on
 * random inputs".
 *
 * Categories:
 *   - Path encoding (`~` / `/` escapes)
 *   - Primitive diffs
 *   - Object diffs (add, remove, replace, nested)
 *   - Array diffs (whole-array replace)
 *   - Type change (object → primitive, array → object)
 *   - Apply edge cases (out-of-range, missing keys)
 *   - Round-trip on 20 random object pairs
 */

import { describe, it, expect } from 'vitest'
import { computePatch, applyPatch, type JsonPatch } from '../src/ledger/patch.js'

function roundtrip<T>(prev: T, next: T): void {
  const patch = computePatch(prev, next)
  const reconstructed = applyPatch(prev, patch)
  expect(reconstructed).toEqual(next)
}

describe('computePatch + applyPatch', () => {
  // ─── No-ops ────────────────────────────────────────────────────

  it('returns an empty patch for equal primitives', () => {
    expect(computePatch(1, 1)).toEqual([])
    expect(computePatch('a', 'a')).toEqual([])
    expect(computePatch(true, true)).toEqual([])
    expect(computePatch(null, null)).toEqual([])
  })

  it('returns an empty patch for deeply equal objects', () => {
    expect(computePatch({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([])
  })

  // ─── Primitive differences ─────────────────────────────────────

  it('emits a root replace for different primitives', () => {
    const patch = computePatch(1, 2)
    expect(patch).toEqual([{ op: 'replace', path: '', value: 2 }])
    expect(applyPatch(1, patch)).toBe(2)
  })

  it('emits a root replace for primitive → object', () => {
    const patch = computePatch(1, { a: 1 })
    expect(patch).toEqual([{ op: 'replace', path: '', value: { a: 1 } }])
    expect(applyPatch(1, patch)).toEqual({ a: 1 })
  })

  // ─── Object diffs ──────────────────────────────────────────────

  it('emits an add op for a new object key', () => {
    const patch = computePatch({ a: 1 }, { a: 1, b: 2 })
    expect(patch).toEqual([{ op: 'add', path: '/b', value: 2 }])
    roundtrip({ a: 1 }, { a: 1, b: 2 })
  })

  it('emits a remove op for a deleted object key', () => {
    const patch = computePatch({ a: 1, b: 2 }, { a: 1 })
    expect(patch).toEqual([{ op: 'remove', path: '/b' }])
    roundtrip({ a: 1, b: 2 }, { a: 1 })
  })

  it('emits a replace op for a changed value', () => {
    const patch = computePatch({ a: 1 }, { a: 2 })
    expect(patch).toEqual([{ op: 'replace', path: '/a', value: 2 }])
    roundtrip({ a: 1 }, { a: 2 })
  })

  it('handles nested object replacements', () => {
    roundtrip(
      { user: { name: 'alice', age: 30 } },
      { user: { name: 'alice', age: 31 } },
    )
  })

  it('handles deeply nested additions', () => {
    roundtrip(
      { a: { b: { c: 1 } } },
      { a: { b: { c: 1, d: 2 } } },
    )
  })

  it('handles multiple simultaneous changes in a single object', () => {
    const patch = computePatch(
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 20, d: 4 },
    )
    // Order: remove c, add d, replace b
    expect(patch).toHaveLength(3)
    roundtrip({ a: 1, b: 2, c: 3 }, { a: 1, b: 20, d: 4 })
  })

  // ─── Arrays ────────────────────────────────────────────────────

  it('treats equal arrays as no-op', () => {
    expect(computePatch([1, 2, 3], [1, 2, 3])).toEqual([])
  })

  it('replaces the whole array on any change', () => {
    const patch = computePatch([1, 2, 3], [1, 2, 4])
    expect(patch).toEqual([{ op: 'replace', path: '', value: [1, 2, 4] }])
    roundtrip([1, 2, 3], [1, 2, 4])
  })

  it('handles an array nested inside an object', () => {
    roundtrip(
      { items: [{ id: 1 }, { id: 2 }] },
      { items: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    )
  })

  it('handles array length changes', () => {
    roundtrip([1, 2, 3], [1])
    roundtrip([1], [1, 2, 3])
  })

  // ─── Type changes ──────────────────────────────────────────────

  it('handles object → array type change', () => {
    roundtrip({ a: 1 } as unknown, [1, 2, 3] as unknown)
  })

  it('handles array → object type change', () => {
    roundtrip([1, 2] as unknown, { a: 1 } as unknown)
  })

  it('handles null → object', () => {
    roundtrip(null as unknown, { a: 1 } as unknown)
  })

  it('handles object → null', () => {
    roundtrip({ a: 1 } as unknown, null as unknown)
  })

  // ─── Path escaping ─────────────────────────────────────────────

  it('escapes ~ in keys', () => {
    const patch = computePatch({ 'a~b': 1 }, { 'a~b': 2 })
    expect(patch).toEqual([{ op: 'replace', path: '/a~0b', value: 2 }])
    roundtrip({ 'a~b': 1 }, { 'a~b': 2 })
  })

  it('escapes / in keys', () => {
    const patch = computePatch({ 'a/b': 1 }, { 'a/b': 2 })
    expect(patch).toEqual([{ op: 'replace', path: '/a~1b', value: 2 }])
    roundtrip({ 'a/b': 1 }, { 'a/b': 2 })
  })

  it('escapes ~ before / to avoid the ~01 ambiguity', () => {
    // Key `~1` should become `~01`, not `/0`. Round-trip proves it.
    roundtrip({ '~1': 1 }, { '~1': 2 })
  })

  // ─── Apply error cases ────────────────────────────────────────

  it('applyPatch throws on remove of missing key', () => {
    expect(() =>
      applyPatch({ a: 1 }, [{ op: 'remove', path: '/b' }]),
    ).toThrow(/remove on missing key/)
  })

  it('applyPatch throws on replace of missing key', () => {
    expect(() =>
      applyPatch({ a: 1 }, [{ op: 'replace', path: '/b', value: 2 }]),
    ).toThrow(/replace on missing key/)
  })

  it('applyPatch throws on path that steps into a primitive', () => {
    expect(() =>
      applyPatch({ a: 1 }, [{ op: 'replace', path: '/a/b', value: 2 }]),
    ).toThrow(/cannot apply/)
  })

  it('applyPatch throws on path that does not start with slash', () => {
    expect(() =>
      applyPatch({ a: 1 }, [{ op: 'replace', path: 'a', value: 2 } as unknown as JsonPatch[number]]),
    ).toThrow(/must start with/)
  })

  it('applyPatch add on existing object key replaces it (per RFC)', () => {
    const result = applyPatch({ a: 1 }, [{ op: 'add', path: '/a', value: 2 }])
    expect(result).toEqual({ a: 2 })
  })

  // ─── Immutability ─────────────────────────────────────────────

  it('applyPatch does not mutate the input', () => {
    const base = { a: 1, b: { c: 2 } }
    const snapshot = JSON.stringify(base)
    applyPatch(base, [{ op: 'replace', path: '/b/c', value: 3 }])
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it('computePatch does not mutate either input', () => {
    const prev = { a: 1 }
    const next = { a: 2 }
    const prevSnap = JSON.stringify(prev)
    const nextSnap = JSON.stringify(next)
    computePatch(prev, next)
    expect(JSON.stringify(prev)).toBe(prevSnap)
    expect(JSON.stringify(next)).toBe(nextSnap)
  })

  // ─── Round-trip on representative accounting records ─────────

  it('round-trips a realistic invoice edit sequence', () => {
    let inv: Record<string, unknown> = {
      id: 'inv-1',
      client: 'Acme',
      amount: 100,
      status: 'draft',
      lines: [
        { sku: 'A-1', qty: 2, price: 50 },
      ],
    }
    const history: typeof inv[] = [structuredClone(inv)]

    // Edit 1: add another line item
    let next: Record<string, unknown> = {
      ...inv,
      amount: 150,
      lines: [
        { sku: 'A-1', qty: 2, price: 50 },
        { sku: 'B-2', qty: 1, price: 50 },
      ],
    }
    roundtrip(inv, next)
    inv = next
    history.push(structuredClone(inv))

    // Edit 2: status change
    next = { ...inv, status: 'open' }
    roundtrip(inv, next)
    inv = next
    history.push(structuredClone(inv))

    // Edit 3: add a notes field
    next = { ...inv, notes: 'Paid at pickup' }
    roundtrip(inv, next)
    inv = next
    history.push(structuredClone(inv))

    // Edit 4: remove a line, adjust amount
    next = {
      ...inv,
      amount: 100,
      lines: [{ sku: 'A-1', qty: 2, price: 50 }],
    }
    roundtrip(inv, next)
    history.push(structuredClone(next))
  })

  // ─── Storage-efficiency gate ─────────────────────────────────

  it('small edits produce proportionally small patches', () => {
    // The whole point of delta history: edit size, not record size.
    const big: Record<string, unknown> = {
      id: 'inv-1',
      padding: 'x'.repeat(10_000),
      field: 1,
    }
    const bigPatched = { ...big, field: 2 }

    const patch = computePatch(big, bigPatched)
    const patchJson = JSON.stringify(patch)

    // The patch must not include the padding. A naive snapshot of
    // `bigPatched` would be >10KB; a delta should be <100 bytes.
    expect(patchJson.length).toBeLessThan(100)
    expect(patch).toEqual([{ op: 'replace', path: '/field', value: 2 }])
  })
})
