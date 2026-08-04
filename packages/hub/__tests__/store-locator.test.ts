/**
 * Tests for the Locator seam (#945 Task 1): a serializable, credentialless
 * `StoreDescriptor` plus the `createStoreLocator()` factory registry that
 * reconstructs a `NoydbStore` from data.
 */
import { describe, it, expect } from 'vitest'
import {
  createStoreLocator,
  UnknownStoreKindError,
  DuplicateStoreKindError,
  type StoreDescriptor,
  type StoreFactory,
} from '../src/port/to/index.js'
import type { NoydbStore } from '../src/port/to/index.js'

/** Minimal stand-in satisfying the 6-method `NoydbStore` contract. */
function makeSentinelStore(tag: string): NoydbStore {
  return {
    name: tag,
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => [],
    loadAll: async () => ({}),
    saveAll: async () => {},
  }
}

describe('createStoreLocator', () => {
  it('resolves a registered kind to the store its factory produces', async () => {
    const locator = createStoreLocator()
    const sentinel = makeSentinelStore('sentinel')
    const factory: StoreFactory = () => sentinel

    locator.register('stub', factory)

    const descriptor: StoreDescriptor = { kind: 'stub', class: 'local', address: {} }
    const resolved = await locator.resolve(descriptor)

    expect(resolved).toBe(sentinel)
  })

  it('throws UnknownStoreKindError naming the offending kind and the registered kinds', async () => {
    const locator = createStoreLocator()
    locator.register('stub', () => makeSentinelStore('sentinel'))
    locator.register('another', () => makeSentinelStore('another'))

    const descriptor: StoreDescriptor = { kind: 'nope', class: 'local', address: {} }

    let caught: unknown
    try {
      await locator.resolve(descriptor)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(UnknownStoreKindError)
    const err = caught as UnknownStoreKindError
    expect(err.kind).toBe('nope')
    expect(err.registeredKinds).toEqual(['another', 'stub'])
    expect(err.message).toContain('nope')
    expect(err.message).toContain('another')
    expect(err.message).toContain('stub')
  })

  it('rejects re-registering a kind that already has a factory', () => {
    const locator = createStoreLocator()
    locator.register('stub', () => makeSentinelStore('first'))

    let caught: unknown
    try {
      locator.register('stub', () => makeSentinelStore('second'))
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(DuplicateStoreKindError)
    const err = caught as DuplicateStoreKindError
    expect(err.kind).toBe('stub')
    expect(err.message).toContain('stub')
  })

  it('type-check: a descriptor literal cannot carry a credentials function', () => {
    const descriptor: StoreDescriptor = {
      kind: 'stub',
      class: 'local',
      address: {},
      // @ts-expect-error — StoreDescriptor is credentialless by construction; credentials never ride it.
      credentials: () => Promise.resolve({ kind: 'token', token: 'x' }),
    }
    expect(descriptor).toBeTruthy()
  })
})
