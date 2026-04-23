/**
 * Foreign-key references — the v0.4 soft-FK mechanism.
 *
 * A collection declares its references as metadata at construction
 * time:
 *
 * ```ts
 * import { ref } from '@noy-db/hub'
 *
 * const invoices = company.collection<Invoice>('invoices', {
 *   refs: {
 *     clientId: ref('clients'),            // default: strict
 *     categoryId: ref('categories', 'warn'),
 *     parentId:  ref('invoices', 'cascade'), // self-reference OK
 *   },
 * })
 * ```
 *
 * Three modes:
 *
 *   - **strict** — the default. `put()` rejects records whose
 *     reference target doesn't exist, and `delete()` of the target
 *     rejects if any strict-referencing records still exist.
 *     Matches SQL's default FK semantics.
 *
 *   - **warn** — both operations succeed unconditionally. Broken
 *     references surface only through
 *     `vault.checkIntegrity()`, which walks every collection
 *     and reports orphans. Use when you want soft validation for
 *     imports from messy sources.
 *
 *   - **cascade** — `put()` is same as warn. `delete()` of the
 *     target deletes every referencing record. Cycles are detected
 *     and broken via an in-progress set, so mutual cascades
 *     terminate instead of recursing forever.
 *
 * Cross-vault refs are explicitly rejected: if the target
 * name contains a `/`, `ref()` throws `RefScopeError`. Cross-
 * vault refs need an auth story (multi-keyring reads) that
 * v0.4 doesn't ship — tracked for v0.5.
 */

import { NoydbError } from './errors.js'

/** The three enforcement modes. Default for new refs is `'strict'`. */
export type RefMode = 'strict' | 'warn' | 'cascade'

/**
 * Descriptor returned by `ref()`. Collections accept a
 * `Record<string, RefDescriptor>` in their options. The key is the
 * field name on the record (top-level only — dotted paths are out of
 * scope for v0.4), the value describes which target collection the
 * field references and under what mode.
 *
 * The descriptor carries only plain data so it can be serialized,
 * passed around, and introspected without any class machinery.
 */
export interface RefDescriptor {
  readonly target: string
  readonly mode: RefMode
}

/**
 * Thrown when a strict reference is violated — either `put()` with a
 * missing target id, or `delete()` of a target that still has
 * strict-referencing records.
 *
 * Carries structured detail so UI code (and a potential future
 * devtools panel) can render "client X cannot be deleted because
 * invoices 1, 2, and 3 reference it" instead of a bare error string.
 */
export class RefIntegrityError extends NoydbError {
  readonly collection: string
  readonly id: string
  readonly field: string
  readonly refTo: string
  readonly refId: string | null

  constructor(opts: {
    collection: string
    id: string
    field: string
    refTo: string
    refId: string | null
    message: string
  }) {
    super('REF_INTEGRITY', opts.message)
    this.name = 'RefIntegrityError'
    this.collection = opts.collection
    this.id = opts.id
    this.field = opts.field
    this.refTo = opts.refTo
    this.refId = opts.refId
  }
}

/**
 * Thrown when `ref()` is called with a target name that looks like
 * a cross-vault reference (contains a `/`). Separate error
 * class because the fix is different: RefIntegrityError means "data
 * is wrong"; RefScopeError means "the ref declaration is wrong".
 */
export class RefScopeError extends NoydbError {
  constructor(target: string) {
    super(
      'REF_SCOPE',
      `Cross-vault references are not supported in v0.4 — got target "${target}". ` +
        `Use a simple collection name (e.g. "clients"), not a path. ` +
        `Cross-vault refs are tracked for a future release.`,
    )
    this.name = 'RefScopeError'
  }
}

/**
 * Helper constructor. Thin wrapper around the object literal so user
 * code reads like `ref('clients')` instead of `{ target: 'clients',
 * mode: 'strict' }` — this is the only ergonomics reason it exists.
 *
 * Validates the target name eagerly so a misconfigured ref declaration
 * fails at collection construction time, not at the first put.
 */
export function ref(target: string, mode: RefMode = 'strict'): RefDescriptor {
  if (target.includes('/')) {
    throw new RefScopeError(target)
  }
  if (!target || target.startsWith('_')) {
    throw new Error(
      `ref(): target collection name must be non-empty and cannot start with '_' (reserved for internal collections). Got "${target}".`,
    )
  }
  return { target, mode }
}

/**
 * Per-vault registry of reference declarations.
 *
 * The registry is populated by `Collection` constructors (which pass
 * their `refs` option through the Vault) and consulted by the
 * Vault on every `put` / `delete` and by `checkIntegrity`. A
 * single instance lives on the Vault for its lifetime; there's
 * no global state.
 *
 * The data structure is two parallel maps:
 *
 *   - `outbound`: `collection → { field → RefDescriptor }` — what
 *     refs does `collection` declare? Used on put to check
 *     strict-target-exists and on checkIntegrity to walk each
 *     collection's outbound refs.
 *
 *   - `inbound`:  `target → Array<{ collection, field, mode }>` —
 *     which collections reference `target`? Used on delete to find
 *     the records that might be affected by cascade / strict.
 *
 * The two views are kept in sync by `register()` and never mutated
 * otherwise — refs can't be unregistered at runtime in v0.4.
 */
export class RefRegistry {
  private readonly outbound = new Map<string, Record<string, RefDescriptor>>()
  private readonly inbound = new Map<
    string,
    Array<{ collection: string; field: string; mode: RefMode }>
  >()

  /**
   * Register the refs declared by a single collection. Idempotent in
   * the happy path — calling twice with the same data is a no-op.
   * Calling twice with DIFFERENT data throws, because silent
   * overrides would be confusing ("I changed the ref and it doesn't
   * update" vs "I declared the same collection twice with different
   * refs and the second call won").
   */
  register(collection: string, refs: Record<string, RefDescriptor>): void {
    const existing = this.outbound.get(collection)
    if (existing) {
      // Compare shallowly — if any field disagrees, reject.
      const existingKeys = Object.keys(existing).sort()
      const newKeys = Object.keys(refs).sort()
      if (existingKeys.join(',') !== newKeys.join(',')) {
        throw new Error(
          `RefRegistry: conflicting ref declarations for collection "${collection}"`,
        )
      }
      for (const k of existingKeys) {
        const a = existing[k]
        const b = refs[k]
        if (!a || !b || a.target !== b.target || a.mode !== b.mode) {
          throw new Error(
            `RefRegistry: conflicting ref declarations for collection "${collection}" field "${k}"`,
          )
        }
      }
      return
    }
    this.outbound.set(collection, { ...refs })
    for (const [field, desc] of Object.entries(refs)) {
      const list = this.inbound.get(desc.target) ?? []
      list.push({ collection, field, mode: desc.mode })
      this.inbound.set(desc.target, list)
    }
  }

  /** Get the outbound refs declared by a collection (or `{}` if none). */
  getOutbound(collection: string): Record<string, RefDescriptor> {
    return this.outbound.get(collection) ?? {}
  }

  /** Get the inbound refs that target a given collection (or `[]`). */
  getInbound(
    target: string,
  ): ReadonlyArray<{ collection: string; field: string; mode: RefMode }> {
    return this.inbound.get(target) ?? []
  }

  /**
   * Iterate every (collection → refs) pair that has at least one
   * declared reference. Used by `checkIntegrity` to walk the full
   * universe of outbound refs without needing to track collection
   * names elsewhere.
   */
  entries(): Array<[string, Record<string, RefDescriptor>]> {
    return [...this.outbound.entries()]
  }

  /** Clear the registry. Test-only escape hatch; never called from production code. */
  clear(): void {
    this.outbound.clear()
    this.inbound.clear()
  }
}

/**
 * Shape of a single violation reported by `vault.checkIntegrity()`.
 *
 * `refId` is the value we saw in the referencing field — it's the
 * ID we expected to find in `refTo`, but didn't. Left as `unknown`
 * because records are loosely typed at the integrity-check layer.
 */
export interface RefViolation {
  readonly collection: string
  readonly id: string
  readonly field: string
  readonly refTo: string
  readonly refId: unknown
  readonly mode: RefMode
}
