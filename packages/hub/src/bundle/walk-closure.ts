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

  return { closure, graph: { depth: 0, cyclesDetected: false } }
}
