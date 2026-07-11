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
/** `'virtual'` (#638 Task 7) marks a `computed(fn, { mode: 'virtual' })` field's edge —
 *  never stored (rides the `present` phase), so it can never be sealed at rest
 *  ({@link ViaGraph.taintSealedFields} excludes it) and is always non-queryable
 *  regardless of source posture ({@link ViaGraph.effectivePosture} clamps it). */
export type Grain = 'record' | 'aggregate' | 'virtual'

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

/** Whether `p` is exactly the plain, non-taint baseline (Task 3 — `taintProvenance`). */
function isDefaultPosture(p: ViaPosture): boolean {
  return p.encryptedAtRest === DEFAULT_POSTURE.encryptedAtRest && p.queryable === DEFAULT_POSTURE.queryable &&
    p.exportable === DEFAULT_POSTURE.exportable && p.forgettable === DEFAULT_POSTURE.forgettable
}

/** One registered `registerDerived` call — a target's whole in-edge set. */
interface DerivedEdge {
  readonly target: FieldRef
  readonly sources: readonly FieldRef[]
  readonly kind: EdgeKind
  readonly grain: Grain
}

const SEP = '\0'
const EMPTY_SET: ReadonlySet<string> = new Set()

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
  /** Collections with at least one classified field (#638 Task 2 fix wave 2,
   *  Finding I1 — the reconcile path's combined-state leak guard memory). */
  private readonly _classifiedCollections = new Set<string>()
  /** Computed field names declared with no `computedDeps` entry, per collection
   *  (Finding I1 — such a field registers no edge when no classified field is
   *  present yet, so a LATER, separate reconcile call attaching classifiedFields
   *  still needs to see it regardless of declaration order). */
  private readonly _depslessComputed = new Map<string, Set<string>>()

  /** Declare a source field's posture (money/i18n/classified/plain). Plain fields
   *  default to `DEFAULT_POSTURE`; a later declaration for the same node wins-first (idempotent). */
  registerField(collection: string, field: string, posture: ViaPosture): void {
    const id = nodeId({ collection, field })
    if (this._posture.has(id)) return
    this._posture.set(id, posture)
    this._effectiveCache.clear()
  }

  /** Every field name with a declared posture (registerField) for `collection` —
   *  the graph's memory of previously-known fields. Consulted by the reconcile
   *  path's computedDeps validation (#638 Task 2 fix wave 2, Finding I2ii) so a
   *  field declared i18n/dictKey/money/classified at an EARLIER `vault.collection()`
   *  call stays a valid dep source on a later one, without the reconcile path
   *  needing direct access to those descriptors. */
  fieldNamesOf(collection: string): ReadonlySet<string> {
    const out = new Set<string>()
    for (const id of this._posture.keys()) {
      const sep = id.indexOf(SEP)
      if (id.slice(0, sep) === collection) out.add(id.slice(sep + 1))
    }
    return out
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

  /** Whether `target` already has a registered in-edge — lets a caller skip
   *  re-registering the same target (#638 Task 2 fix wave 2, Finding I2i:
   *  `registerDerived`'s at-most-once contract must hold across repeated
   *  identical `vault.collection()` calls, not just within a single one). */
  hasDerived(target: FieldRef): boolean {
    return this._in.has(nodeId(target))
  }

  /** Mark/query a collection as having declared at least one classified field. */
  markClassified(collection: string): void {
    this._classifiedCollections.add(collection)
  }

  isClassified(collection: string): boolean {
    return this._classifiedCollections.has(collection)
  }

  /** Mark/query a collection's depsless (no declared `computedDeps`) computed
   *  field names — see `_depslessComputed`'s doc comment above. */
  markDepslessComputed(collection: string, field: string): void {
    let set = this._depslessComputed.get(collection)
    if (!set) { set = new Set(); this._depslessComputed.set(collection, set) }
    set.add(field)
  }

  depslessComputedFields(collection: string): ReadonlySet<string> {
    return this._depslessComputed.get(collection) ?? EMPTY_SET
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
    // #638 Task 7 — a virtual field is computed fresh on every read and never
    // stored, so it is structurally unqueryable regardless of what its
    // sources' fold would otherwise permit (e.g. a money-sourced virtual
    // field must NOT inherit money's 'ordered' queryability — there is no
    // stored/indexed form to query against). Every OTHER axis (exportable/
    // forgettable/encryptedAtRest) still folds normally — the taint rule is
    // identical to a materialized field; only queryability is a fixed,
    // grain-level property, not a source-derived one.
    if (edge.grain === 'virtual' && result.queryable !== 'none') {
      result = { ...result, queryable: 'none' }
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

  /** Materialized (`grain !== 'virtual'`) derived fields on `collection` whose effective
   *  encryptedAtRest resolves to 'sealed' — the taint-seal set (Task 3). #638 Task 7
   *  makes the `grain !== 'virtual'` filter meaningful: a `computed(fn, { mode: 'virtual' })`
   *  field is never stored (rides the `present` phase, seam map Part 4's money-Formatted/
   *  i18n-Label precedent), so it is EXCLUDED here even when its effective `encryptedAtRest`
   *  folds to `'sealed'` — there is no envelope slot to seal. It still surfaces in
   *  {@link taintedPostures} (query refusal via `postureFor`'s `queryable` clamp above, and
   *  export refusal via `exportable`) — only the AT-REST SEALING ACTION is skipped. */
  taintSealedFields(collection: string): ReadonlySet<string> {
    const out = new Set<string>()
    for (const edge of this._in.values()) {
      if (edge.target.collection !== collection || edge.grain === 'virtual') continue
      const posture = this._computeEffective(nodeId(edge.target), edge)
      if (posture.encryptedAtRest === 'sealed') out.add(edge.target.field)
    }
    return out
  }

  /** Fields on `collection` whose registered edge is `grain === 'virtual'` (#638 Task 7) —
   *  `via-graph-wiring.ts#applyTaintOverlay` intersects this with `exportable === false`
   *  postures to know which virtual fields need PRESENT-TIME (not just export-time)
   *  redaction, since a virtual field's value is only ever materialized inside `present()`. */
  virtualFields(collection: string): ReadonlySet<string> {
    const out = new Set<string>()
    for (const edge of this._in.values()) {
      if (edge.target.collection === collection && edge.grain === 'virtual') out.add(edge.target.field)
    }
    return out
  }

  /** Per-collection { field → immediate source field names that forced its
   *  effective posture away from `DEFAULT_POSTURE` } — `describe()`'s
   *  provenance (Task 3). Only the DIRECT declared sources are named (not the
   *  ultimate origin several hops up a transitive chain); a source absent
   *  from the result contributed nothing restrictive. */
  taintProvenance(collection: string): ReadonlyMap<string, readonly string[]> {
    const out = new Map<string, readonly string[]>()
    for (const edge of this._in.values()) {
      if (edge.target.collection !== collection) continue
      const forcedBy = edge.sources
        .filter((source) => !isDefaultPosture(this._contribution(nodeId(source))))
        .map((source) => source.field)
      if (forcedBy.length > 0) out.set(edge.target.field, forcedBy)
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
