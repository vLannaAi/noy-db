/**
 * Link-set naming helpers, declaration types, and errors — the tiny,
 * always-loadable slice of the links feature (#553).
 *
 * Split out of `link-set.ts` so the kernel floor (reserved-name guard in
 * `vault.collection()`, the lazy `vault.links()` handle) and the ref/link
 * enforcement facade can bind these few lines WITHOUT statically pulling
 * the `LinkSet` storage engine; that class now loads via dynamic import
 * on first link I/O. `link-set.ts` re-exports everything here, so import
 * paths and class identities are unchanged for existing consumers.
 */

import { NoydbError, ValidationError } from '../../kernel/errors.js'
import type { RefDescriptor } from '../../kernel/refs.js'

export const LINK_COLLECTION_PREFIX = '_links_'

/** Storage collection name for a logical link set. */
export function linkCollectionName(name: string): string {
  return `${LINK_COLLECTION_PREFIX}${name}`
}

/** True for any reserved link-collection name. */
export function isLinkCollectionName(name: string): boolean {
  return name.startsWith(LINK_COLLECTION_PREFIX)
}

/** What happens to a link's rows when one of its endpoint records is deleted. */
export type LinkOnDelete = 'cascade' | 'strict' | 'warn'

/**
 * Declaration for a link set, passed to `vault.link(name, spec)`. `a` and
 * `b` are the endpoint collection names (slot-typed). `onDelete` governs
 * what happens to link rows when an endpoint record is deleted:
 * `'cascade'` (default) removes the touching link rows, `'strict'` blocks
 * the endpoint delete while links exist, `'warn'` leaves orphan rows
 * (surfaced by `vault.checkIntegrity()`).
 */
export interface LinkSpec {
  readonly a: string
  readonly b: string
  readonly onDelete?: LinkOnDelete
}

/**
 * Validate + register a `vault.link(name, spec)` declaration. `a`/`b`
 * accept either a collection name or a `ref(target)` descriptor (only
 * `target` is used). Idempotent for an identical re-declaration; throws
 * `ValidationError` for an invalid endpoint or a conflicting
 * re-declaration. Body extracted out of `Vault.link()` (shrink-first,
 * #947) — the kernel floor keeps a thin delegator.
 */
export function declareLink(
  linkRegistry: Map<string, LinkSpec>,
  name: string,
  spec: { a: string | RefDescriptor; b: string | RefDescriptor; onDelete?: LinkSpec['onDelete'] },
): void {
  const a = typeof spec.a === 'string' ? spec.a : spec.a.target
  const b = typeof spec.b === 'string' ? spec.b : spec.b.target
  for (const [slot, target] of [['a', a], ['b', b]] as const) {
    if (!target || target.startsWith('_') || target.includes('/')) {
      throw new ValidationError(
        `vault.link("${name}"): endpoint "${slot}" must be a simple collection name, got "${target}".`,
      )
    }
  }
  const resolved: LinkSpec = { a, b, ...(spec.onDelete ? { onDelete: spec.onDelete } : {}) }
  const existing = linkRegistry.get(name)
  if (existing) {
    if (existing.a !== resolved.a || existing.b !== resolved.b || (existing.onDelete ?? 'cascade') !== (resolved.onDelete ?? 'cascade')) {
      throw new ValidationError(`vault.link("${name}"): conflicting re-declaration.`)
    }
    return
  }
  linkRegistry.set(name, resolved)
}

/** One link tuple as returned by `of()` / `list()`. */
export interface LinkRow {
  readonly a: string
  readonly b: string
  readonly meta?: Record<string, unknown>
}

/**
 * Compose the row key for an ordered `(a, b)` pair. Each id is
 * URI-encoded and joined with `|` — encodeURIComponent escapes `|`, so the
 * key is unambiguous regardless of id contents.
 */
export function linkRowKey(aId: string, bId: string): string {
  return `${encodeURIComponent(aId)}|${encodeURIComponent(bId)}`
}

/** Public handle returned by `vault.links(name)`. */
export interface LinkSetHandle {
  /** Create (or overwrite the metadata of) the link `(aId, bId)`. Validates both endpoints exist. */
  connect(aId: string, bId: string, meta?: Record<string, unknown>): Promise<void>
  /** Remove the link `(aId, bId)`. Idempotent — a no-op if it doesn't exist. */
  disconnect(aId: string, bId: string): Promise<void>
  /** Whether the link `(aId, bId)` exists. */
  has(aId: string, bId: string): Promise<boolean>
  /** All links touching `id` on EITHER endpoint. */
  of(id: string): Promise<LinkRow[]>
  /** All links in the set. */
  list(): Promise<LinkRow[]>
}

/** Thrown when a `strict` link blocks deletion of an endpoint that still has links. */
export class LinkIntegrityError extends NoydbError {
  readonly link: string
  readonly endpoint: string
  readonly id: string
  readonly count: number
  constructor(link: string, endpoint: string, id: string, count: number) {
    super(
      'LINK_INTEGRITY',
      `Cannot delete "${endpoint}"/"${id}": ${count} link(s) in "${link}" still reference it (onDelete: 'strict').`,
    )
    this.name = 'LinkIntegrityError'
    this.link = link
    this.endpoint = endpoint
    this.id = id
    this.count = count
  }
}
