/**
 * Transitive-closure FK walker. Computes the set of
 * (collection, id) tuples reachable from seed predicates, so a
 * partition extraction ships a referentially-complete subset.
 *
 * Two-phase, plaintext, read-only (runs inside the unlocked vault
 * session — see foundation §13.4 / spec invariant 7):
 *   1. INBOUND expansion: from selected records, pull every record
 *      that references them (children travel with parents), to a
 *      fixed point.
 *   2. OUTBOUND completion: pull every VISIBLE parent the selected set
 *      references, transitively, WITHOUT re-expanding inbound from those
 *      parents (bounds the closure). A tier-elevated (or missing) parent is
 *      excluded rather than admitted — see `danglingRefs` on the result.
 *
 * The FK graph is auto-derived from the vault's existing RefRegistry
 * (the `ref('target')` declarations on collections) — no hand-written
 * edge list.
 *
 * @module
 */
import type { Vault } from '../kernel/vault.js'
import { PartitionExtractionError } from '../kernel/errors.js'

/** Seed predicate per collection. Records that return true become roots. */
export interface WalkClosureOptions {
  readonly seeds: Record<
    string,
    (record: Record<string, unknown>) => boolean | Promise<boolean>
  >
  /** Max fixed-point iterations before throwing. Default 16. */
  readonly maxDepth?: number
}

/**
 * #759: an outbound FK edge whose referenced parent was excluded from the
 * closure — either because it doesn't exist, or because it is tier-elevated
 * and therefore invisible (same "elevated ≡ missing" semantics as root
 * selection / inbound expansion). The child keeps its FK value; the parent
 * does not travel. Callers (extract-partition) surface this as a residue
 * notice rather than silently dropping it.
 */
export interface DanglingRefNotice {
  /** Collection of the child record that holds the dangling FK. */
  readonly collection: string
  /** Id of the child record. */
  readonly id: string
  /** FK field on the child that references the missing/elevated parent. */
  readonly field: string
  /** Target collection the FK points at. */
  readonly target: string
  /** Id of the missing/elevated parent. */
  readonly targetId: string
  /**
   * #772: distinguishes an intentional tier boundary (`'elevated'` — the
   * parent exists but is above the caller's readable tier) from a genuine
   * data-integrity gap (`'missing'` — no envelope for `targetId` at all).
   */
  readonly reason: 'missing' | 'elevated'
}

export interface ClosureResult {
  /** collection → set of record ids that travel together. */
  readonly closure: Map<string, Set<string>>
  readonly graph: {
    /** Fixed-point iterations the walk needed to converge. */
    readonly depth: number
    /** True if an edge pointed back to an already-selected node. */
    readonly cyclesDetected: boolean
  }
  /** #759: outbound FK edges whose parent was excluded (missing or elevated). */
  readonly danglingRefs: ReadonlyArray<DanglingRefNotice>
}

export async function walkClosure(
  vault: Vault,
  opts: WalkClosureOptions,
): Promise<ClosureResult> {
  const closure = new Map<string, Set<string>>()

  // Records carry a string `id` by construction (Collection.put(id: string)).
  // A non-string id during the walk means a malformed record — fail loud
  // rather than silently dropping it from the closure (which would leave a
  // dangling FK or a missing child in the extracted bundle).
  const requireStringId = (collection: string, record: Record<string, unknown>): string => {
    const id = record['id']
    if (typeof id !== 'string') {
      throw new PartitionExtractionError(
        `walkClosure: record in collection "${collection}" has a non-string ` +
          `id (${typeof id}); cannot include it in the partition closure.`,
      )
    }
    return id
  }

  const add = (collection: string, id: string): boolean => {
    let set = closure.get(collection)
    if (!set) {
      set = new Set<string>()
      closure.set(collection, set)
    }
    if (set.has(id)) return false
    set.add(id)
    return true
  }

  // Phase 0: evaluate seed predicates.
  for (const [collectionName, predicate] of Object.entries(opts.seeds)) {
    const coll = vault.collection<Record<string, unknown>>(collectionName)
    const records = await coll.list()
    for (const record of records) {
      if (await predicate(record)) {
        add(collectionName, requireStringId(collectionName, record))
      }
    }
  }

  const { refRegistry, adapter, name: vaultName } = vault._introspectState()
  const maxDepth = opts.maxDepth ?? 16
  let cyclesDetected = false

  // `depth` counts PRODUCTIVE expansion generations (rounds that added at
  // least one new record), taken as the max over the two phases — i.e. the
  // FK hop-distance the closure needed, not the raw loop-iteration count.
  // The terminal draining pass that adds nothing does not count.
  let inboundDepth = 0
  let outboundDepth = 0

  // Phase 1 — INBOUND expansion. Worklist of newly-added (collection,id)
  // whose children we still need to pull.
  let frontier: Array<[string, string]> = []
  for (const [c, ids] of closure) for (const id of ids) frontier.push([c, id])

  while (frontier.length > 0) {
    const next: Array<[string, string]> = []
    for (const [collectionName, id] of frontier) {
      // Which collections reference THIS collection, and via which field?
      for (const inbound of refRegistry.getInbound(collectionName)) {
        const childColl = vault.collection<Record<string, unknown>>(inbound.collection)
        // TODO(perf): re-scans the full inbound collection on every frontier
        // element. O(frontier · inboundCollections · records) per depth. Fine
        // at consumer-firm scale (foundation §13.4); revisit with an index or
        // pagination if extraction over very large vaults gets slow.
        const childRecords = await childColl.list()
        for (const child of childRecords) {
          const fk = child[inbound.field]
          // Only scalar FK values can match an id; skip null/objects
          // (mirrors checkIntegrity's scalar guard, vault.ts).
          if (typeof fk !== 'string' && typeof fk !== 'number') continue
          if (String(fk) !== id) continue
          const childId = requireStringId(inbound.collection, child)
          if (add(inbound.collection, childId)) {
            next.push([inbound.collection, childId])
          } else {
            cyclesDetected = true
          }
        }
      }
    }
    if (next.length > 0 && ++inboundDepth > maxDepth) {
      throw new PartitionExtractionError(
        `walkClosure exceeded maxDepth=${maxDepth}; the FK graph may be ` +
          `unexpectedly deep or cyclic. Raise maxDepth or narrow the seeds.`,
      )
    }
    frontier = next
  }

  // Phase 2 — OUTBOUND completion. Pull referenced parents so no FK
  // dangles. Transitive over outbound edges only; parents are NOT
  // inbound-expanded (that would drag in unrelated siblings).
  let outboundFrontier: Array<[string, string]> = []
  for (const [c, ids] of closure) for (const id of ids) outboundFrontier.push([c, id])

  const danglingRefs: DanglingRefNotice[] = []

  while (outboundFrontier.length > 0) {
    const next: Array<[string, string]> = []
    for (const [collectionName, id] of outboundFrontier) {
      const outbound = refRegistry.getOutbound(collectionName)
      if (Object.keys(outbound).length === 0) continue
      const coll = vault.collection<Record<string, unknown>>(collectionName)
      const record = await coll.get(id)
      if (!record) continue
      for (const [field, descriptor] of Object.entries(outbound)) {
        const rawId = record[field]
        // Only scalar FK values reference a parent id; skip null/objects.
        if (typeof rawId !== 'string' && typeof rawId !== 'number') continue
        const parentId = String(rawId)
        // #759: verify the referenced parent is visible through the SAME
        // tier-gated primitive root selection / inbound expansion use
        // (`Collection.get()` → `#getRaw`, which returns null for both a
        // missing record and a tier-elevated one). An elevated parent must
        // be excluded exactly like an elevated root or inbound target —
        // "elevated ≡ invisible" — rather than admitted into the closure,
        // where `reKeyClosure`'s raw adapter read would later hit it and
        // fail loud (the #748 canary). Record the resulting dangling FK
        // instead of silently dropping it.
        const parentColl = vault.collection<Record<string, unknown>>(descriptor.target)
        const parentRecord = await parentColl.get(parentId)
        if (!parentRecord) {
          // #772: a raw (tier-unaware) read distinguishes the two cases the
          // tier-gated `Collection.get()` above collapses to the same null —
          // an envelope present with `_tier > 0` is an intentional tier
          // boundary; no envelope at all is a genuine data-integrity gap.
          const rawParentEnv = await adapter.get(vaultName, descriptor.target, parentId)
          const reason: 'missing' | 'elevated' =
            rawParentEnv && (rawParentEnv._tier ?? 0) > 0 ? 'elevated' : 'missing'
          danglingRefs.push({
            collection: collectionName, id, field, target: descriptor.target, targetId: parentId, reason,
          })
          continue
        }
        // Reaching an already-selected parent here is normal DAG
        // convergence (a child referencing its in-scope parent), not a
        // cycle — so do NOT flag cyclesDetected in the outbound phase.
        if (add(descriptor.target, parentId)) {
          next.push([descriptor.target, parentId])
        }
      }
    }
    if (next.length > 0 && ++outboundDepth > maxDepth) {
      throw new PartitionExtractionError(
        `walkClosure exceeded maxDepth=${maxDepth} during outbound completion.`,
      )
    }
    outboundFrontier = next
  }

  const depth = Math.max(inboundDepth, outboundDepth)

  return { closure, graph: { depth, cyclesDetected }, danglingRefs }
}
