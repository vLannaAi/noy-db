/**
 * Transitive-closure FK walker (#201). Computes the set of
 * (collection, id) tuples reachable from seed predicates, so a
 * partition extraction ships a referentially-complete subset.
 *
 * Two-phase, plaintext, read-only (runs inside the unlocked vault
 * session — see foundation §13.4 / spec invariant 7):
 *   1. INBOUND expansion: from selected records, pull every record
 *      that references them (children travel with parents), to a
 *      fixed point.
 *   2. OUTBOUND completion: pull every parent the selected set
 *      references (no dangling FKs), transitively, WITHOUT
 *      re-expanding inbound from those parents (bounds the closure).
 *
 * The FK graph is auto-derived from the vault's existing RefRegistry
 * (the `ref('target')` declarations on collections) — no hand-written
 * edge list. See the design spec §4.1.
 *
 * @module
 */
import type { Vault } from '../vault.js'
import { PartitionExtractionError } from '../errors.js'

/** Seed predicate per collection. Records that return true become roots. */
export interface WalkClosureOptions {
  readonly seeds: Record<
    string,
    (record: Record<string, unknown>) => boolean | Promise<boolean>
  >
  /** Max fixed-point iterations before throwing. Default 16. */
  readonly maxDepth?: number
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
}

export async function walkClosure(
  vault: Vault,
  opts: WalkClosureOptions,
): Promise<ClosureResult> {
  const closure = new Map<string, Set<string>>()

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
        const id = record['id']
        if (typeof id === 'string') add(collectionName, id)
      }
    }
  }

  const { refRegistry } = vault._introspectState()
  const maxDepth = opts.maxDepth ?? 16
  let depth = 0
  let cyclesDetected = false

  // Phase 1 — INBOUND expansion. Worklist of newly-added (collection,id)
  // whose children we still need to pull.
  let frontier: Array<[string, string]> = []
  for (const [c, ids] of closure) for (const id of ids) frontier.push([c, id])

  while (frontier.length > 0) {
    if (++depth > maxDepth) {
      throw new PartitionExtractionError(
        `walkClosure exceeded maxDepth=${maxDepth}; the FK graph may be ` +
          `unexpectedly deep or cyclic. Raise maxDepth or narrow the seeds.`,
      )
    }
    const next: Array<[string, string]> = []
    for (const [collectionName, id] of frontier) {
      // Which collections reference THIS collection, and via which field?
      for (const inbound of refRegistry.getInbound(collectionName)) {
        const childColl = vault.collection<Record<string, unknown>>(inbound.collection)
        const childRecords = await childColl.list()
        for (const child of childRecords) {
          const fk = child[inbound.field]
          // Only scalar FK values can match an id; skip null/objects
          // (mirrors checkIntegrity's scalar guard, vault.ts).
          if (typeof fk !== 'string' && typeof fk !== 'number') continue
          if (String(fk) !== id) continue
          const childId = child['id']
          if (typeof childId !== 'string') continue
          if (add(inbound.collection, childId)) {
            next.push([inbound.collection, childId])
          } else {
            cyclesDetected = true
          }
        }
      }
    }
    frontier = next
  }

  // Phase 2 — OUTBOUND completion. Pull referenced parents so no FK
  // dangles. Transitive over outbound edges only; parents are NOT
  // inbound-expanded (that would drag in unrelated siblings).
  let outboundFrontier: Array<[string, string]> = []
  for (const [c, ids] of closure) for (const id of ids) outboundFrontier.push([c, id])

  while (outboundFrontier.length > 0) {
    if (++depth > maxDepth) {
      throw new PartitionExtractionError(
        `walkClosure exceeded maxDepth=${maxDepth} during outbound completion.`,
      )
    }
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
        // Reaching an already-selected parent here is normal DAG
        // convergence (a child referencing its in-scope parent), not a
        // cycle — so do NOT flag cyclesDetected in the outbound phase.
        if (add(descriptor.target, parentId)) {
          next.push([descriptor.target, parentId])
        }
      }
    }
    outboundFrontier = next
  }

  return { closure, graph: { depth, cyclesDetected } }
}
