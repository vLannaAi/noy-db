/**
 * Tests for the Locator seam (#945 Task 1): a serializable, credentialless
 * `StoreDescriptor` plus the `createStoreLocator()` factory registry that
 * reconstructs a `NoydbStore` from data.
 */
import { describe, it, expect } from 'vitest'
import {
  createStoreLocator,
  isPodStore,
  UnknownStoreKindError,
  DuplicateStoreKindError,
  type StoreDescriptor,
  type StoreFactory,
} from '../src/port/to/index.js'
import type { NoydbStore, NoydbPodStore, AnyNoydbStore } from '../src/port/to/index.js'

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

/** Minimal stand-in satisfying the whole-vault `NoydbPodStore` contract. */
function makePodStore(tag: string): NoydbPodStore {
  return {
    kind: 'bundle',
    name: tag,
    readBundle: async () => null,
    writeBundle: async () => ({ version: '1' }),
    deleteBundle: async () => {},
    listBundles: async () => [],
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

  it('registers a pod-store factory without a cast (#988)', async () => {
    const locator = createStoreLocator()
    const sentinel = makePodStore('icloud')
    // The point of the issue: this line used to require
    // `podFactory as unknown as StoreFactory`, duplicated in to-drive and
    // to-icloud. `S` now infers as `NoydbPodStore` from the factory itself.
    const podFactory: StoreFactory<NoydbPodStore> = () => sentinel
    locator.register('icloud', podFactory)

    const resolved = await locator.resolveAny({ kind: 'icloud', class: 'cloud', address: {} })
    expect(resolved).toBe(sentinel)
    expect(isPodStore(resolved)).toBe(true)
  })

  it('resolve() is a pure pass-through — the cast it carries stays sound', async () => {
    // #988 called the pod cast "sound against the current implementation,
    // which is exactly the fragile kind of soundness". The fragility is real,
    // so pin it: resolve() must not wrap, validate, or reshape what the
    // factory returned. If a future resolve() does, this fails loudly here
    // rather than silently at two pod stores in another repo.
    const locator = createStoreLocator()
    const pod = makePodStore('drive')
    const kv = makeSentinelStore('memory')
    locator.register('drive', (): NoydbPodStore => pod)
    locator.register('mem', () => kv)

    expect(await locator.resolveAny({ kind: 'drive', class: 'cloud', address: {} })).toBe(pod)
    expect(await locator.resolveAny({ kind: 'mem', class: 'local', address: {} })).toBe(kv)
    expect(await locator.resolve({ kind: 'mem', class: 'local', address: {} })).toBe(kv)
  })

  it('isPodStore discriminates the two disjoint shapes', () => {
    const pod: AnyNoydbStore = makePodStore('drive')
    const kv: AnyNoydbStore = makeSentinelStore('memory')

    expect(isPodStore(pod)).toBe(true)
    expect(isPodStore(kv)).toBe(false)

    // The narrowing is what makes it useful, not just the boolean: inside the
    // guard the pod-only methods are reachable without a cast.
    if (isPodStore(pod)) expect(typeof pod.readBundle).toBe('function')
    else throw new Error('unreachable — pod store must narrow')
  })

  it('resolveAny throws the same UnknownStoreKindError as resolve', async () => {
    const locator = createStoreLocator()
    locator.register('stub', () => makeSentinelStore('sentinel'))

    await expect(
      Promise.resolve().then(() =>
        locator.resolveAny({ kind: 'nope', class: 'local', address: {} }),
      ),
    ).rejects.toBeInstanceOf(UnknownStoreKindError)
  })

  it('type-check: a bare StoreFactory still means a KV store', () => {
    // Backward compatibility is the reason `S` defaults to `NoydbStore`
    // rather than to the union: every existing `StoreFactory` annotation in
    // the family keeps its exact previous meaning.
    // @ts-expect-error — a pod store is not a NoydbStore, and the default did not widen.
    const wrong: StoreFactory = () => makePodStore('drive')
    expect(wrong).toBeTypeOf('function')
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
