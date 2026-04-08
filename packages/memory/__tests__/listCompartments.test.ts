/**
 * `listCompartments()` adapter capability — v0.5 #63.
 *
 * The memory adapter implements the optional 7th adapter method
 * (`listCompartments`) used by `Noydb.listAccessibleCompartments()`
 * to enumerate the compartment universe before filtering down to
 * the ones the calling principal can unwrap.
 *
 * For the in-memory adapter the implementation is `[...store.keys()]`
 * — these tests verify the contract: empty stores return empty
 * arrays, multi-compartment stores return every key, system
 * collections (those starting with `_`) do not affect the count
 * because compartments are top-level Map keys, not collections.
 */

import { describe, it, expect } from 'vitest'
import { memory } from '../src/index.js'
import type { EncryptedEnvelope } from '@noy-db/core'

function envelope(v = 1): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: '2026-04-07T00:00:00Z', _iv: 'iv', _data: 'data' }
}

describe('@noy-db/memory — listCompartments (#63)', () => {
  it('exposes listCompartments as an optional method', () => {
    const a = memory()
    expect(typeof a.listCompartments).toBe('function')
  })

  it('returns an empty array on a fresh adapter', async () => {
    const a = memory()
    expect(await a.listCompartments!()).toEqual([])
  })

  it('returns one compartment after a single put', async () => {
    const a = memory()
    await a.put('T1', 'invoices', 'inv-1', envelope())
    expect(await a.listCompartments!()).toEqual(['T1'])
  })

  it('returns every distinct compartment after writes to multiple', async () => {
    const a = memory()
    await a.put('T1', 'invoices', 'inv-1', envelope())
    await a.put('T2', 'invoices', 'inv-2', envelope())
    await a.put('T7', 'payments', 'pay-1', envelope())
    expect((await a.listCompartments!()).sort()).toEqual(['T1', 'T2', 'T7'])
  })

  it('counts each compartment once regardless of how many collections / records it has', async () => {
    const a = memory()
    await a.put('T1', 'invoices', 'inv-1', envelope())
    await a.put('T1', 'invoices', 'inv-2', envelope())
    await a.put('T1', 'invoices', 'inv-3', envelope())
    await a.put('T1', 'payments', 'pay-1', envelope())
    await a.put('T1', '_keyring', 'alice', envelope())
    expect(await a.listCompartments!()).toEqual(['T1'])
  })

  it('does not include collections under a compartment as separate entries', async () => {
    // Sanity check: it's compartments, not collections. The shape
    // is `Map<compartment, Map<collection, ...>>`, so iterating the
    // outer map gives compartments only.
    const a = memory()
    await a.put('only-comp', 'a', 'x', envelope())
    await a.put('only-comp', 'b', 'x', envelope())
    await a.put('only-comp', 'c', 'x', envelope())
    expect(await a.listCompartments!()).toEqual(['only-comp'])
  })
})
