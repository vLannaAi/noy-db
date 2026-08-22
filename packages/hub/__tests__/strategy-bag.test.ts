import { describe, it, expect } from 'vitest'

import {
  STRATEGY_DEFAULTS,
  resolveStrategies,
  type StrategyBag,
  type StrategyKey,
} from '../src/port/with/strategies.js'
import type { NoydbOptions } from '../src/kernel/types.js'
import { NO_BLOBS } from '../src/port/with/blob-strategy.js'
import { NO_ARCHIVE } from '../src/port/with/archive-strategy.js'
import { NO_SEARCH } from '../src/with-lookup/search/strategy.js'

const KEYS = Object.keys(STRATEGY_DEFAULTS) as StrategyKey[]

describe('resolveStrategies (#838)', () => {
  it('resolves every service when the caller passes nothing', () => {
    const bag = resolveStrategies({} as NoydbOptions)

    // The point of the bag: there is no `undefined` to null-check anywhere
    // downstream. #834 was a caller being told a service was not enabled when
    // they had configured it; a hole in the bag must be just as impossible.
    for (const key of KEYS) {
      expect(bag[key], `${key} did not resolve`).toBeDefined()
      expect(bag[key]).toBe(STRATEGY_DEFAULTS[key])
    }
  })

  it('lets a provided strategy override its default', () => {
    const search = { ...NO_SEARCH } as StrategyBag['search']
    const bag = resolveStrategies({ searchStrategy: search } as NoydbOptions)

    expect(bag.search).toBe(search)
    expect(bag.search).not.toBe(NO_SEARCH)
    expect(bag.blobs).toBe(NO_BLOBS) // everything else stays on the floor
  })

  it('maps each option name to its suffix-stripped bag key', () => {
    // `searchStrategy: withSearch()` must read back as `strategies.search`.
    // This is the runtime half of the compile-time assertion in strategies.ts.
    for (const key of KEYS) {
      const sentinel = { __sentinel: key } as unknown as StrategyBag[StrategyKey]
      const bag = resolveStrategies({ [`${key}Strategy`]: sentinel } as unknown as NoydbOptions)

      expect(bag[key], `${key}Strategy did not land on strategies.${key}`).toBe(sentinel)
    }
  })

  it('treats an explicitly-undefined option as not provided', () => {
    const bag = resolveStrategies({ blobsStrategy: undefined } as unknown as NoydbOptions)

    expect(bag.blobs).toBe(NO_BLOBS)
  })

  it('does not mutate the shared defaults', () => {
    const before = { ...STRATEGY_DEFAULTS }
    resolveStrategies({ blobsStrategy: { ...NO_BLOBS } } as NoydbOptions)

    expect({ ...STRATEGY_DEFAULTS }).toEqual(before)
  })

  it('returns a fresh bag per call', () => {
    expect(resolveStrategies({} as NoydbOptions)).not.toBe(resolveStrategies({} as NoydbOptions))
  })
})

describe('STRATEGY_DEFAULTS (#838)', () => {
  it('covers every service exactly once', () => {
    expect(KEYS).toHaveLength(29) // +vaultHead (#1044), +formats (ADR 0004)
    expect(new Set(KEYS).size).toBe(KEYS.length)
  })

  it('holds a stub for archive rather than undefined', () => {
    // archive was the one service with no NO-op stub: the spine held
    // `ArchiveStrategy | undefined` behind a hand-rolled null gate.
    expect(STRATEGY_DEFAULTS.archive).toBe(NO_ARCHIVE)
    expect(() => STRATEGY_DEFAULTS.archive.store).toThrow(/archiveStrategy: withArchive/)
  })

  it('gives lazy a working floor, not a no-op', () => {
    // `lazy`'s default is IMPLICIT_LAZY — an un-opted-in collection still gets
    // a real LRU. This is why the table maps keys to defaults instead of
    // assuming a NO_* naming convention.
    expect(STRATEGY_DEFAULTS.lazy).toBeDefined()
  })
})
