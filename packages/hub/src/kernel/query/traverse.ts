/**
 * Query DSL `.traverse()` — bounded breadth-first walk over ONE declared,
 * self-referencing `ref()` field (#1352).
 *
 * Org charts, bills of materials, account hierarchies, parent/child clients:
 * every one of them is a collection whose records point at other records in
 * the SAME collection, and every one of them otherwise needs the consumer to
 * hand-roll recursion in userland.
 *
 * Scope — and the scope is the design, not a limitation to be lifted later:
 *
 *   - **Declared refs only.** The field must carry a `ref()` whose target is
 *     the collection being queried. This is not a general graph engine; an
 *     undeclared field, or a ref pointing at a different collection, is
 *     refused at plan time with an actionable error.
 *   - **`direction: 'up'`** follows the FK — one `lookupById` per hop, O(1).
 *     **`direction: 'down'`** answers "who points at me", which no forward
 *     index can serve, so it builds the reverse-FK index #1289 introduced
 *     (`bucketByRefKey` in `join.ts`) ONCE per call and probes it per node.
 *   - **`maxDepth` is required.** Not defaulted. An unbounded walk over a
 *     large collection is a denial of service against the consumer's own UI,
 *     and a silent default would truncate a result set without saying so —
 *     the caller must state the bound they can afford.
 *   - **A node is emitted once**, at the shallowest depth it is reached at.
 *     That settles the diamond (two seeds converging on one ancestor → one
 *     row) and it is the same set that makes cycles terminate.
 *
 * **Cost.** Nothing here decrypts. `collection.query()` is eager-mode only
 * and reads the vault's already-decrypted in-memory cache, so the AES-GCM
 * cost was paid once at `openVault()` prefetch: a depth-5 traversal is
 * `depth × frontier` Map lookups and zero `crypto.subtle` calls. The one
 * non-constant cost is `down`'s single O(n) pass to build the reverse index.
 * The architectural invariant is untouched — no filter, sort or hop is
 * pushed to the store, which holds ciphertext and never runs a query.
 */

import { readPath } from './predicate.js'
import { bucketByRefKey, coerceRefKey } from './join.js'
import { TraversalCycleError } from '../errors.js'

/** Which way a traversal walks the declared self-ref. */
export type TraverseDirection = 'up' | 'down'

/**
 * What a traversal does when it reaches a node already on the current path.
 *
 * `'stop'` (the default) prunes that branch and finishes the walk — a
 * circular parent chain produces a finite result instead of hanging.
 * `'throw'` raises {@link TraversalCycleError}, for hierarchies that are
 * supposed to be acyclic and where a cycle is a finding, not a shape.
 */
export type CyclePolicy = 'stop' | 'throw'

/** Options for {@link runTraversal}. `maxDepth` is deliberately required. */
export interface TraverseOptions {
  readonly direction: TraverseDirection
  /**
   * Maximum number of hops from a seed. `0` returns the seeds alone. Must be
   * a non-negative integer — there is no default, on purpose.
   */
  readonly maxDepth: number
  /** Cycle behaviour. Defaults to `'stop'`. */
  readonly onCycle?: CyclePolicy
}

/**
 * One row of a traversal result.
 *
 * Deliberately NOT flattened into the record. Stamping `depth` / `path` onto
 * the record would collide with a real field on exactly the collections this
 * feature exists for — an org chart with its own `depth` column is not a
 * hypothetical — and the loser of that collision would be silent.
 *
 * `path` is the ids from the seed to this node, BOTH INCLUSIVE, so
 * `path.length === depth + 1` and `path.at(-1) === id` always. A seed has
 * `depth: 0` and `path: [id]`.
 */
export interface TraversalRow<T> {
  /** This node's record id. */
  readonly id: string
  /** The record itself, decoded exactly as `toArray()` would decode it. */
  readonly record: T
  /** Hops from the seed. `0` for a seed. */
  readonly depth: number
  /** Seed-to-node ids, inclusive at both ends. */
  readonly path: readonly string[]
}

/** The slice of a query source a traversal needs. */
export interface TraverseSource {
  snapshot(): readonly unknown[]
  lookupById?(id: string): unknown
  snapshotEntries?(): readonly { readonly id: string; readonly record: unknown }[]
}

interface Node {
  readonly id: string
  readonly record: unknown
  readonly depth: number
  readonly path: readonly string[]
}

/**
 * Id-paired view of the source.
 *
 * Same reasoning as `JoinableSource.snapshotEntries` (#1289): a Collection
 * snapshot record does not carry its own id, so anything that has to ask
 * "which record is this?" must go through the id-paired view. The `id`-field
 * fallback serves the plain-object sources unit tests wire up.
 */
function entriesOf(source: TraverseSource): readonly { id: string; record: unknown }[] {
  const paired = source.snapshotEntries?.()
  if (paired !== undefined) return paired as readonly { id: string; record: unknown }[]
  const out: { id: string; record: unknown }[] = []
  for (const record of source.snapshot()) {
    const id = coerceRefKey(readPath(record, 'id'))
    if (id !== null) out.push({ id, record })
  }
  return out
}

/**
 * Bounded BFS from `seeds`.
 *
 * `seeds` are ids, not records — a seed that names no existing record is
 * skipped, not thrown on, for the same reason a dangling ref terminates a
 * branch quietly: a traversal reports the graph it found, and a missing node
 * is an absence, not a failure of the walk.
 *
 * The two guards are separate on purpose:
 *
 *   - `path.includes(next)` is a CYCLE — the walk would re-enter a node it is
 *     standing on. Checked first, so `onCycle: 'throw'` reports a genuine
 *     ring rather than the next case.
 *   - `emitted.has(next)` is a DIAMOND — the node was already reached by
 *     another branch, at a depth no greater than this one (BFS), so re-
 *     emitting it would duplicate the row and re-walk its whole subtree.
 *
 * Collapsing them into one visited-set would make a diamond indistinguishable
 * from a cycle, which is precisely the distinction `onCycle` sells.
 */
export function runTraversal(
  source: TraverseSource,
  field: string,
  seeds: readonly string[],
  opts: TraverseOptions,
): TraversalRow<unknown>[] {
  const { direction, maxDepth } = opts
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error(
      `.traverse("${field}"): maxDepth must be a non-negative integer, got ` +
        `${String(maxDepth)}. It is required and has no default — an unbounded ` +
        `walk over a large collection is a denial of service against your own UI.`,
    )
  }
  const onCycle: CyclePolicy = opts.onCycle ?? 'stop'

  const entries = entriesOf(source)
  const lookup: (id: string) => unknown =
    source.lookupById !== undefined
      ? (id): unknown => source.lookupById?.(id)
      : ((): ((id: string) => unknown) => {
          const byId = new Map(entries.map(e => [e.id, e.record]))
          return (id): unknown => byId.get(id)
        })()

  // Built only for `down`: `up` follows the FK it already holds, so paying an
  // O(n) pass to answer a question it never asks would be pure waste.
  const children =
    direction === 'down'
      ? bucketByRefKey(entries, e => readPath(e.record, field))
      : undefined

  const emitted = new Set<string>()
  const out: TraversalRow<unknown>[] = []
  let frontier: Node[] = []

  for (const seedId of seeds) {
    if (emitted.has(seedId)) continue
    const record = lookup(seedId)
    if (record === undefined) continue
    emitted.add(seedId)
    const node: Node = { id: seedId, record, depth: 0, path: [seedId] }
    out.push(node)
    frontier.push(node)
  }

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: Node[] = []
    for (const current of frontier) {
      for (const { id, record } of neighboursOf(current, field, direction, lookup, children)) {
        if (current.path.includes(id)) {
          if (onCycle === 'throw') {
            throw new TraversalCycleError({ field, cycle: [...current.path, id] })
          }
          continue
        }
        if (emitted.has(id)) continue
        emitted.add(id)
        const node: Node = { id, record, depth, path: [...current.path, id] }
        out.push(node)
        next.push(node)
      }
    }
    frontier = next
  }

  return out
}

function neighboursOf(
  current: Node,
  field: string,
  direction: TraverseDirection,
  lookup: (id: string) => unknown,
  children: Map<string, { id: string; record: unknown }[]> | undefined,
): readonly { id: string; record: unknown }[] {
  if (direction === 'down') return children?.get(current.id) ?? []
  const parentId = coerceRefKey(readPath(current.record, field))
  if (parentId === null) return []
  const parent = lookup(parentId)
  // Dangling ref: the branch ends here. Deliberately NOT the join's strict
  // ref-mode throw — a traversal's answer to "what is above this node" is
  // "nothing we can see", and a missing ancestor should not take out the
  // rows the walk already found.
  if (parent === undefined) return []
  return [{ id: parentId, record: parent }]
}
