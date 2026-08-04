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
import type { NoydbStore, StoreCredentialSource } from '../../kernel/types.js'
import { UnknownStoreKindError } from '../../kernel/errors.js'

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
 * Reconstructs a live `NoydbStore` from a `StoreDescriptor`. Registered
 * against a `StoreLocator` under the descriptor's `kind`.
 */
export type StoreFactory = (
  descriptor: StoreDescriptor,
  opts: { binding?: StoreBinding; credentials?: StoreCredentialSource },
) => NoydbStore | Promise<NoydbStore>

/** A registry of `StoreFactory`s, keyed by `StoreDescriptor.kind`. */
export interface StoreLocator {
  /** Register a factory for `kind`. Throws if `kind` is already registered. */
  register(kind: string, factory: StoreFactory): void
  /** Resolve `descriptor` to a live store via its kind's registered factory. */
  resolve(
    descriptor: StoreDescriptor,
    opts?: { binding?: StoreBinding; credentials?: StoreCredentialSource },
  ): NoydbStore | Promise<NoydbStore>
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
  const factories = new Map<string, StoreFactory>()

  return {
    register(kind, factory) {
      if (factories.has(kind)) {
        throw new Error(
          `StoreLocator: kind "${kind}" is already registered. Each kind may ` +
            `be registered once per locator — pick a distinct kind string, or ` +
            `create a separate StoreLocator instance.`,
        )
      }
      factories.set(kind, factory)
    },
    resolve(descriptor, opts = {}) {
      const factory = factories.get(descriptor.kind)
      if (!factory) {
        throw new UnknownStoreKindError(descriptor.kind, [...factories.keys()].sort())
      }
      return factory(descriptor, opts)
    },
  }
}
