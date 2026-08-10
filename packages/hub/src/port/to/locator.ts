/**
 * The Locator seam (#945 Task 1): a serializable, CREDENTIALLESS store
 * descriptor plus a factory registry that reconstructs a `NoydbStore` from
 * data.
 *
 * A `StoreDescriptor` is the pod-portable "what store and where" — kind,
 * broad topology class, and a kind-specific serializable address/options
 * bag. It is deliberately dumb data: no field on it is ever typed as a
 * function, a `StoreCredentialSource`, or a `StoreCredentials` value, so a
 * descriptor can be written into a pod / manifest / sync payload without an
 * audit for leaked secrets. Anything that must resolve device-side or
 * user-side — a short-lived credential, a device-local directory override,
 * a mounted drive handle — travels out-of-band via `resolve()`'s `opts`,
 * never through the descriptor itself.
 *
 * This module is pure TypeScript: no imports beyond the kernel's own types
 * and errors, no Node built-ins, no crypto. It adds zero runtime
 * dependencies to `@noy-db/hub/to`.
 */
import type { NoydbStore, NoydbPodStore, StoreCredentialSource } from '../../kernel/types.js'
import { DuplicateStoreKindError, UnknownStoreKindError } from '../../kernel/errors.js'

/**
 * The broad topology bucket a store descriptor's kind falls into —
 * used by callers/UI to group or filter descriptors without knowing every
 * concrete `kind` string.
 */
export type StoreClass = 'local' | 'browser' | 'lan' | 'cloud'

/**
 * A serializable, CREDENTIALLESS description of a store instance: enough
 * data to reconstruct a `NoydbStore` via a registered `StoreFactory`, and
 * safe to persist or transmit as-is.
 *
 * CREDENTIALLESS BY CONSTRUCTION: no field here may be typed as a function,
 * a `StoreCredentialSource`, or a `StoreCredentials` value. Credentials
 * NEVER ride the descriptor — they are supplied separately (as a
 * `StoreCredentialSource`) to `StoreLocator.resolve()` at resolve time.
 */
export interface StoreDescriptor {
  /** The registered factory key (e.g. `'file'`, `'aws-s3'`, `'webdav'`). */
  readonly kind: string
  /** The broad topology bucket this kind falls into. */
  readonly class: StoreClass
  /** Kind-specific serializable location (e.g. `{ dir }`, `{ bucket, region }`). */
  readonly address: unknown
  /** Kind-specific serializable tuning options. */
  readonly options?: unknown
}

/**
 * A kind-specific, device-local supplement to a `StoreDescriptor` — a
 * directory override, a mount point, a drive handle — that is resolved
 * device-side and never carried inside a pod alongside the descriptor.
 */
export type StoreBinding = unknown

/**
 * Either store shape a factory may produce: the 6-method KV `NoydbStore`, or
 * the whole-vault `NoydbPodStore` implemented by `to-drive` / `to-icloud`.
 *
 * The two are DISJOINT, not sub/supertypes — a pod store has none of the six
 * KV methods — which is why moving between them needs a double cast and why
 * `isPodStore()` exists to narrow instead.
 */
export type AnyNoydbStore = NoydbStore | NoydbPodStore

/**
 * Narrow an `AnyNoydbStore` to the pod shape. Discriminates on the
 * `kind: 'bundle'` tag `NoydbPodStore` carries for exactly this purpose; a
 * `NoydbStore` has no `kind` field at all.
 *
 * Use this at a `resolve()` boundary instead of casting — a store resolved
 * from a descriptor read out of a pod is only known to be one of the two
 * shapes at runtime.
 */
export function isPodStore(store: AnyNoydbStore): store is NoydbPodStore {
  return (store as NoydbPodStore).kind === 'bundle'
}

/**
 * Reconstructs a live store from a `StoreDescriptor`. Registered against a
 * `StoreLocator` under the descriptor's `kind`.
 *
 * The type parameter says WHICH shape this factory builds. It defaults to
 * `NoydbStore`, so a bare `StoreFactory` means exactly what it always has;
 * a pod-store factory declares `StoreFactory<NoydbPodStore>` and registers
 * without a cast (#988).
 */
export type StoreFactory<S extends AnyNoydbStore = NoydbStore> = (
  descriptor: StoreDescriptor,
  opts: { binding?: StoreBinding; credentials?: StoreCredentialSource },
) => S | Promise<S>

/** A registry of `StoreFactory`s, keyed by `StoreDescriptor.kind`. */
export interface StoreLocator {
  /**
   * Register a factory for `kind`. Throws if `kind` is already registered.
   *
   * Accepts a factory building EITHER store shape — `S` is inferred from the
   * factory's own return type, so a `NoydbPodStore` factory needs no cast.
   */
  register<S extends AnyNoydbStore>(kind: string, factory: StoreFactory<S>): void
  /**
   * Resolve `descriptor` to a live store via its kind's registered factory.
   *
   * Returns `NoydbStore`. If the `kind` was registered with a pod-store
   * factory, the resolved value is really a `NoydbPodStore`: this signature
   * is the seam's remaining unsoundness, kept because widening it to
   * `AnyNoydbStore` would break every existing caller. Where the descriptor's
   * kind is not statically known, prefer `resolveAny()` and `isPodStore()`.
   */
  resolve(
    descriptor: StoreDescriptor,
    opts?: { binding?: StoreBinding; credentials?: StoreCredentialSource },
  ): NoydbStore | Promise<NoydbStore>
  /**
   * As `resolve()`, but typed honestly: the registry is keyed by a runtime
   * `kind` string, so which of the two shapes comes back is not knowable
   * statically. Narrow the result with `isPodStore()`.
   */
  resolveAny(
    descriptor: StoreDescriptor,
    opts?: { binding?: StoreBinding; credentials?: StoreCredentialSource },
  ): AnyNoydbStore | Promise<AnyNoydbStore>
}

/**
 * Creates a fresh, empty `StoreLocator`.
 *
 * DUPLICATE REGISTRATION: `register()` throws if `kind` is already
 * registered, rather than silently overwriting it (last-wins). A
 * composition root that registers the same kind twice is almost always a
 * mistake — a copy-pasted setup block, two satellite packages fighting
 * over the same kind string — and last-wins would hide it behind whichever
 * registration happened to run last. This mirrors the
 * `DuplicateBehaviorNameError` philosophy (#947): fail loudly at the
 * mistake's source instead of silently at some unrelated `resolve()` call
 * later.
 */
export function createStoreLocator(): StoreLocator {
  const factories = new Map<string, StoreFactory<AnyNoydbStore>>()

  function lookup(kind: string): StoreFactory<AnyNoydbStore> {
    const factory = factories.get(kind)
    if (!factory) {
      throw new UnknownStoreKindError(kind, [...factories.keys()].sort())
    }
    return factory
  }

  return {
    register(kind, factory) {
      if (factories.has(kind)) {
        throw new DuplicateStoreKindError(kind)
      }
      factories.set(kind, factory)
    },
    resolve(descriptor, opts = {}) {
      // The one place the seam's `resolve(): NoydbStore` signature is paid
      // for. A pod-store `kind` really returns a `NoydbPodStore`; the registry
      // is keyed by a runtime string so nothing here can prove otherwise.
      // Concentrated in the module that owns the invariant rather than
      // duplicated as `as unknown as StoreFactory` in every pod-store package
      // (#988). `resolveAny()` is the honest signature over the same call.
      return lookup(descriptor.kind)(descriptor, opts) as NoydbStore | Promise<NoydbStore>
    },
    resolveAny(descriptor, opts = {}) {
      return lookup(descriptor.kind)(descriptor, opts)
    },
  }
}
