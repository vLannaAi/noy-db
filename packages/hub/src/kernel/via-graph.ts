// kernel/via-graph.ts — the per-vault ViaGraph dependency model (Via port phase C, #638).
//
// Metadata-only dependency graph over (collection, field) nodes: source-field
// postures, derived-field edges, and the taint (effective-posture) algebra.
// NEVER stores record values or key material — see
// docs/superpowers/specs/2026-07-11-via-phase-c-design.md §1/§2.

import { DerivationCycleError, MaterializedViewCycleError } from './errors.js'
import type { ViaPosture } from './via.js'

/** A (collection, field) node. Artifact-grain targets (rollup field, MV row-class,
 *  overlay output) are modelled as a field node whose `field` is the artifact key. */
export interface FieldRef { readonly collection: string; readonly field: string }

export type EdgeKind = 'computed' | 'derivation' | 'rollup' | 'mv' | 'overlay'
export type Grain = 'record' | 'aggregate'

/** Plain (non-via) field baseline — max-permissive; taint only ever tightens. */
export const DEFAULT_POSTURE: ViaPosture =
  { encryptedAtRest: 'envelope', queryable: 'full', exportable: true, forgettable: false }

const QUERYABLE_RANK: Record<ViaPosture['queryable'], number> = {
  none: 0,
  'det-exact': 1,
  ordered: 2,
  full: 3,
}

/** The per-axis "most restrictive" fold — pure, exported for direct unit testing. */
export function foldPosture(a: ViaPosture, b: ViaPosture): ViaPosture {
  return {
    encryptedAtRest: a.encryptedAtRest === 'sealed' || b.encryptedAtRest === 'sealed' ? 'sealed' : 'envelope',
    queryable: QUERYABLE_RANK[a.queryable] <= QUERYABLE_RANK[b.queryable] ? a.queryable : b.queryable,
    exportable: a.exportable && b.exportable,
    forgettable: a.forgettable || b.forgettable,
  }
}

/** One registered `registerDerived` call — a target's whole in-edge set. */
interface DerivedEdge {
  readonly target: FieldRef
  readonly sources: readonly FieldRef[]
  readonly kind: EdgeKind
  readonly grain: Grain
}

const SEP = '\0'

function nodeId(ref: FieldRef): string {
  return `${ref.collection}${SEP}${ref.field}`
}

/** Inverse of `nodeId`, for building a human-readable cycle path. */
function displayNodeId(id: string): string {
  const sep = id.indexOf(SEP)
  return `${id.slice(0, sep)}.${id.slice(sep + 1)}`
}

/** Metadata-only dependency graph, ONE per vault. Never stores values or key material. */
export class ViaGraph {
  /** Declared source-field postures (registerField), keyed by node id. */
  private readonly _posture = new Map<string, ViaPosture>()
  /** Every derived target's registration, keyed by the target's node id. */
  private readonly _in = new Map<string, DerivedEdge>()
  /** source node id -> derived targets that depend on it (dispatch/erasure). */
  private readonly _out = new Map<string, FieldRef[]>()
  /** Memoized effective posture per derived target node id. */
  private readonly _effectiveCache = new Map<string, ViaPosture>()

  /** Declare a source field's posture (money/i18n/classified/plain). Plain fields
   *  default to `DEFAULT_POSTURE`; a later declaration for the same node wins-first (idempotent). */
  registerField(collection: string, field: string, posture: ViaPosture): void {
    const id = nodeId({ collection, field })
    if (this._posture.has(id)) return
    this._posture.set(id, posture)
    this._effectiveCache.clear()
  }

  /** A derived target depends on `sources` (may be cross-collection). `kind`/`grain`
   *  drive dispatch + erasure semantics; sources drive taint. Re-registering the same
   *  target replaces `_in` but does not prune stale `_out` edges — callers must
   *  register each target at most once per graph lifetime. */
  registerDerived(target: FieldRef, sources: readonly FieldRef[], kind: EdgeKind, grain: Grain): void {
    const id = nodeId(target)
    this._in.set(id, { target, sources, kind, grain })
    for (const source of sources) {
      const sourceId = nodeId(source)
      const dependents = this._out.get(sourceId)
      if (dependents) dependents.push(target)
      else this._out.set(sourceId, [target])
    }
    this._effectiveCache.clear()
  }

  /** Reject cycles at declare time (vault open). Throws `DerivationCycleError` for a
   *  derivation/rollup/computed cycle, `MaterializedViewCycleError` for an MV cycle —
   *  same classes + message shape the registries throw today (behavior lock). */
  assertAcyclic(): void {
    const visited = new Set<string>()
    const stack: string[] = []

    const visit = (id: string): void => {
      const idx = stack.indexOf(id)
      if (idx !== -1) {
        const cycle = stack.slice(idx).concat(id)
        const isMv = cycle.some(cycleId => this._in.get(cycleId)?.kind === 'mv')
        const path = cycle.map(displayNodeId)
        if (isMv) throw new MaterializedViewCycleError(path)
        throw new DerivationCycleError(path)
      }
      if (visited.has(id)) return
      stack.push(id)
      const dependents = this._out.get(id)
      if (dependents) {
        for (const dependent of dependents) visit(nodeId(dependent))
      }
      stack.pop()
      visited.add(id)
    }

    for (const id of this._out.keys()) visit(id)
  }

  /** A leaf (non-derived) node's own posture contribution: its declared posture,
   *  or `DEFAULT_POSTURE` if never declared via `registerField`. */
  private _declaredPosture(id: string): ViaPosture {
    return this._posture.get(id) ?? DEFAULT_POSTURE
  }

  /** A node's posture contribution when folded into a dependent: recurse if it is
   *  itself derived, else its declared/default posture. */
  private _contribution(id: string): ViaPosture {
    const edge = this._in.get(id)
    return edge ? this._computeEffective(id, edge) : this._declaredPosture(id)
  }

  private _computeEffective(id: string, edge: DerivedEdge): ViaPosture {
    const cached = this._effectiveCache.get(id)
    if (cached) return cached
    let result = DEFAULT_POSTURE
    for (const source of edge.sources) {
      result = foldPosture(result, this._contribution(nodeId(source)))
    }
    this._effectiveCache.set(id, result)
    return result
  }

  /** Strictest source posture on every axis, per §2. `undefined` when `target` has no
   *  in-edges (not a derived field). Transitive: folds through chained derivations. */
  effectivePosture(target: FieldRef): ViaPosture | undefined {
    const id = nodeId(target)
    const edge = this._in.get(id)
    if (!edge) return undefined
    return this._computeEffective(id, edge)
  }

  /** Per-collection { field → effectivePosture } overlay the pipeline consumes (Task 3). */
  taintedPostures(collection: string): ReadonlyMap<string, ViaPosture> {
    const out = new Map<string, ViaPosture>()
    for (const edge of this._in.values()) {
      if (edge.target.collection !== collection) continue
      out.set(edge.target.field, this._computeEffective(nodeId(edge.target), edge))
    }
    return out
  }

  /** Materialized (grain !== virtual-only) derived fields on `collection` whose effective
   *  encryptedAtRest resolves to 'sealed' — the taint-seal set (Task 3). */
  taintSealedFields(collection: string): ReadonlySet<string> {
    const out = new Set<string>()
    for (const edge of this._in.values()) {
      if (edge.target.collection !== collection) continue
      const posture = this._computeEffective(nodeId(edge.target), edge)
      if (posture.encryptedAtRest === 'sealed') out.add(edge.target.field)
    }
    return out
  }

  private _targetsDependingOn(collection: string): ReadonlyArray<{ readonly target: FieldRef; readonly kind: EdgeKind; readonly grain: Grain }> {
    const out: Array<{ target: FieldRef; kind: EdgeKind; grain: Grain }> = []
    for (const edge of this._in.values()) {
      if (edge.sources.some(source => source.collection === collection)) {
        out.push({ target: edge.target, kind: edge.kind, grain: edge.grain })
      }
    }
    return out
  }

  /** Dispatch (Task 4): every derived target triggered by a write to `collection`. */
  dependentsOf(collection: string): ReadonlyArray<{ readonly target: FieldRef; readonly kind: EdgeKind; readonly grain: Grain }> {
    return this._targetsDependingOn(collection)
  }

  /** Erasure (Task 6): derived artifacts of a forgotten record whose source is `collection`. */
  derivedArtifactsOf(collection: string): ReadonlyArray<{ readonly target: FieldRef; readonly kind: EdgeKind; readonly grain: Grain }> {
    return this._targetsDependingOn(collection)
  }
}
