// kernel/via/graph.ts — the per-vault ViaGraph dependency model (Via port phase C, #638).
//
// Metadata-only dependency graph over (collection, field) nodes: source-field
// postures, derived-field edges, and the taint (effective-posture) algebra.
// NEVER stores record values or key material — see
// docs/superpowers/specs/2026-07-11-via-phase-c-design.md §1/§2.

import { DerivationCycleError, MaterializedViewCycleError } from '../errors.js'
import type { ViaPosture } from './index.js'

/** A (collection, field) node. Artifact-grain targets (rollup field, MV row-class,
 *  overlay output) are modelled as a field node whose `field` is the artifact key. */
export interface FieldRef { readonly collection: string; readonly field: string }

export type EdgeKind = 'computed' | 'derivation' | 'rollup' | 'mv' | 'overlay' | 'ref'
/** `'virtual'` (#638 Task 7) marks a `computed(fn, { mode: 'virtual' })` field's edge —
 *  never stored (rides the `present` phase), so it can never be sealed at rest
 *  ({@link ViaGraph.taintSealedFields} excludes it) and is always non-queryable
 *  regardless of source posture ({@link ViaGraph.effectivePosture} clamps it). */
export type Grain = 'record' | 'aggregate' | 'virtual'

/** Delete/forget-time referential policy for a `'ref'` edge (#650 Task 5, spec §4) — duplicated
 *  (not imported) from `via/lookup/descriptor.ts`'s `OnDelete`: the kernel spine may not
 *  statically import `via/**` (Check 14, `via-layering`). Keep the two in sync by hand. */
export type OnDelete = 'restrict' | 'cascade' | 'nullify'

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

/** Security-axes-only fold for a wildcard collection node (#642): sealed-wins encryptedAtRest,
 *  AND exportable, OR forgettable — queryable is NOT folded (stays base.queryable; the sealed
 *  clamp to 'none' is buildTaintOverlay's job, so inheriting `sealed` never over-restricts a
 *  blob-adjacent output to unqueryable). Pure; exported for unit testing. Distinct from
 *  {@link foldPosture} (which folds all four axes) — do NOT reuse foldPosture here. */
export function foldWildcardSecurity(base: ViaPosture, contributor: ViaPosture): ViaPosture {
  return {
    encryptedAtRest: base.encryptedAtRest === 'sealed' || contributor.encryptedAtRest === 'sealed' ? 'sealed' : 'envelope',
    queryable: base.queryable,
    exportable: base.exportable && contributor.exportable,
    forgettable: base.forgettable || contributor.forgettable,
  }
}

// the folded formula kinds a '*' source contributes its collection-fold to (ref keeps identity):
type FoldedKind = 'derivation' | 'rollup' | 'mv' | 'overlay'
const FOLDED_KINDS: ReadonlySet<EdgeKind> = new Set<FoldedKind>(['derivation', 'rollup', 'mv', 'overlay'])

/** Whether `p` is exactly the plain, non-taint baseline (Task 3 — `taintProvenance`). */
function isDefaultPosture(p: ViaPosture): boolean {
  return p.encryptedAtRest === DEFAULT_POSTURE.encryptedAtRest && p.queryable === DEFAULT_POSTURE.queryable &&
    p.exportable === DEFAULT_POSTURE.exportable && p.forgettable === DEFAULT_POSTURE.forgettable
}

/** One `_out` entry — a `source -> target` derived edge, carrying its OWN registration's
 *  `kind` (#678). `kind` must be edge-local, not re-derived from `_in`: `_in` is single-slot
 *  per target and can be overwritten by a LATER `registerDerived` call on the SAME target
 *  (a dual-role target, e.g. #631's exempt {computed, lookup} field composition) — asking
 *  `_in` for "this target's current kind" answers the wrong question for a specific edge. */
interface OutEdge { readonly target: FieldRef; readonly kind: EdgeKind }

/** One registered `registerDerived` call — a target's whole in-edge set. */
interface DerivedEdge {
  readonly target: FieldRef
  readonly sources: readonly FieldRef[]
  readonly kind: EdgeKind
  readonly grain: Grain
  /** `'ref'` edges only — the referencing field's delete/forget policy (#650 Task 5). */
  readonly onDelete?: OnDelete
  /** `'ref'` edges only — the backing dimension's canonical-key FIELD NAME on its own row (matrix
   *  tier's `lookup(dim, {key})`; always `'id'` for reserved/static tiers). Defaults to `'id'`
   *  when absent — a referencing field always stores this field's VALUE, never the backing row's
   *  PUT-id when the two differ (#650 Task 5, mirrors Task 3's membership review fix). */
  readonly keyField?: string
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
  /** source node id -> derived edges that depend on it (dispatch/erasure), each carrying
   *  its own registration's `kind` (#678 — see {@link OutEdge}). */
  private readonly _out = new Map<string, OutEdge[]>()
  /** Memoized effective posture per derived target node id. */
  private readonly _effectiveCache = new Map<string, ViaPosture>()
  /** Memoized whole-collection security-axes fold for `'*'` wildcard LEAF nodes (#642),
   *  keyed by collection name — see {@link _wildcardContribution}. Cleared alongside
   *  `_effectiveCache` on every `registerField`/`registerDerived` (a later-registered
   *  field must re-fold on the next read — registration ordering is free). */
  private readonly _wildcardCache = new Map<string, ViaPosture>()
  /** Collections with at least one classified field (#638 Task 2 fix wave 2,
   *  Finding I1 — the reconcile path's combined-state leak guard memory). */
  private readonly _classifiedCollections = new Set<string>()
  /** Computed field names declared with no `deps` entry, per collection
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
    this._wildcardCache.clear()
  }

  /** A derived target depends on `sources` (may be cross-collection). `kind`/`grain`
   *  drive dispatch + erasure semantics; sources drive taint. Re-registering the same
   *  target replaces `_in` but does not prune stale `_out` edges — callers must
   *  register each target at most once per graph lifetime. `onDelete`/`keyField` (#650 Task 5)
   *  are meaningful only for `kind === 'ref'` edges — {@link referencingEdgesOf} reads them back. */
  registerDerived(target: FieldRef, sources: readonly FieldRef[], kind: EdgeKind, grain: Grain, onDelete?: OnDelete, keyField?: string): void {
    const id = nodeId(target)
    this._in.set(id, {
      target, sources, kind, grain,
      ...(onDelete !== undefined ? { onDelete } : {}),
      ...(keyField !== undefined ? { keyField } : {}),
    })
    for (const source of sources) {
      const sourceId = nodeId(source)
      const outEdge: OutEdge = { target, kind }
      const dependents = this._out.get(sourceId)
      if (dependents) dependents.push(outEdge)
      else this._out.set(sourceId, [outEdge])
    }
    this._effectiveCache.clear()
    this._wildcardCache.clear()
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

  /** Mark/query a collection's depsless (no declared `deps`) computed
   *  field names — see `_depslessComputed`'s doc comment above. */
  markDepslessComputed(collection: string, field: string): void {
    let set = this._depslessComputed.get(collection)
    if (!set) { set = new Set(); this._depslessComputed.set(collection, set) }
    set.add(field)
  }

  depslessComputedFields(collection: string): ReadonlySet<string> {
    return this._depslessComputed.get(collection) ?? EMPTY_SET
  }

  /** Every field name the graph already has memory of for `collection` — from an
   *  EARLIER, separate `vault.collection()` call (registered postures, derived
   *  targets, depsless-computed names) — regardless of which via feature declared
   *  it. #645 — `via/graph-wiring.ts`'s reconcile-path `knownFields` universe
   *  (`collectKnownFieldNames`) is scoped to THIS call's own options only, so a
   *  computed field attached in a LATER call whose `deps` correctly names a field
   *  declared in an EARLIER call was spuriously refused as "unknown"; this method
   *  lets that call site union in the graph's cross-call memory. Excludes the `'*'`
   *  wildcard target (an overlay/derivation whole-record fold node, never a real
   *  record field — see {@link registerDerived}'s doc comment). */
  knownFieldNames(collection: string): ReadonlySet<string> {
    const out = new Set<string>()
    const prefix = `${collection}${SEP}`
    for (const id of this._posture.keys()) {
      if (id.startsWith(prefix)) out.add(id.slice(prefix.length))
    }
    for (const edge of this._in.values()) {
      if (edge.target.collection === collection && edge.target.field !== '*') out.add(edge.target.field)
    }
    const depsless = this._depslessComputed.get(collection)
    if (depsless) for (const field of depsless) out.add(field)
    return out
  }

  /** Reject cycles at declare time (vault open). Throws `DerivationCycleError` for a
   *  derivation/rollup/computed cycle, `MaterializedViewCycleError` for an MV cycle —
   *  same classes + message shape the registries throw today (behavior lock). */
  assertAcyclic(): void {
    const visited = new Set<string>()
    const stack: string[] = []

    /** #639 — containment expansion: writing a real field `f` on collection `C` is
     *  a write to `C`, so it must ALSO reach every whole-record (`'*'`) dependent of
     *  `C` — the missing reachability step that made mutual/rotating rollup cycles
     *  invisible (a rollup target is always a real field node and never itself a
     *  graph SOURCE, so the old `_out.get(id)`-only walk dead-ended on it).
     *
     *  TRAVERSAL-LOCAL ONLY (law, #642): this is a virtual adjacency computed
     *  during the DFS walk, reading `_out` only. It must NEVER be materialized via
     *  `registerDerived` (no new `(C,f)→(C,'*')` edge) and must NEVER touch `_in` —
     *  putting `(C,'*')` into `_in` would flip `_contribution('C\0*')` from the
     *  `_wildcardContribution` fold (`#642`) onto the `_computeEffective` path,
     *  bleeding cycle-reachability taint into `foldWildcardSecurity`'s posture
     *  fold. Posture folding (`_contribution`/`_computeEffective`/
     *  `_wildcardContribution`) never reads `_out`, so an expansion that reads
     *  `_out` only is provably unable to perturb it. */
    // #671 item 5 — exclude `kind:'ref'` consuming edges: mutual FK lookups (two
    // collections each referencing the other) are legal and must not be treated as a
    // derivation cycle. Ref edges exist for cascade/rename machinery
    // (`referencingEdgesOf`/delete-time restrict/cascade/nullify), never derivation
    // ordering, so they carry no ordering constraint here. #678 — `kind` is read off
    // THIS `_out` entry (edge-local), NOT re-derefed from `_in`: a dual-role target
    // (e.g. #631's exempt {computed, lookup} composition) can have its `_in` entry's
    // `kind` overwritten by a LATER `registerDerived` call for the SAME target, so
    // asking `_in` "what kind is `t` registered as NOW" wrongly excluded a real
    // computed edge from the DFS as if it were a ref edge, hiding a genuine
    // derivation cycle. Asking "what kind is THIS specific edge" is correct
    // regardless of what else was later registered for the target.
    const notRefEdge = (entry: OutEdge): boolean => entry.kind !== 'ref'
    const neighboursOf = (id: string): readonly FieldRef[] => {
      const own = (this._out.get(id) ?? []).filter(notRefEdge).map((entry) => entry.target)
      const sep = id.indexOf(SEP)
      if (id.slice(sep + 1) === '*') return own
      const wildcard = (this._out.get(`${id.slice(0, sep)}${SEP}*`) ?? []).filter(notRefEdge).map((entry) => entry.target)
      if (wildcard.length === 0) return own
      return [...own, ...wildcard]
    }

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
      for (const dependent of neighboursOf(id)) visit(nodeId(dependent))
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

  /** A node's posture contribution when folded into a dependent: recurse if it is itself
   *  derived; else its declared/default posture — UNLESS it is a `'*'` LEAF node consumed
   *  by a folded formula kind (#642, `derivation|rollup|mv|overlay`), in which case it
   *  contributes its collection's whole-record security fold ({@link _wildcardContribution}).
   *  `kind` is the CONSUMING edge's kind, threaded from {@link _computeEffective}. `'ref'`
   *  edges (and the provenance-only untyped call, `kind` left `undefined`) keep `'*'` =
   *  identity — the phase-D lookup reliance (`via/lookup/registry.ts:392-397`) that a
   *  referencing field must not seal just because its dimension collection has a classified
   *  column. */
  private _contribution(id: string, kind?: EdgeKind): ViaPosture {
    const edge = this._in.get(id)
    if (edge) return this._computeEffective(id, edge)
    if (kind !== undefined && FOLDED_KINDS.has(kind) && id.endsWith(`${SEP}*`)) {
      return this._wildcardContribution(id.slice(0, -2))
    }
    return this._declaredPosture(id)
  }

  /** Lazy fold (#642) of a collection's REGISTERED field postures on the security axes only
   *  ({@link foldWildcardSecurity} — sealed-wins encryptedAtRest, AND exportable, OR
   *  forgettable; queryable stays at DEFAULT_POSTURE's 'full', never folded), seeded at
   *  DEFAULT_POSTURE. This is the collection-level posture a `'*'` LEAF node contributes to a
   *  folded-kind formula edge (derivation/rollup/mv/overlay) — see {@link _contribution}. A
   *  plain (unregistered) field contributes nothing (the identity), so the fold is strictly
   *  more conservative than deps-based taint and never hits the KNOWN-LIMIT wall (it names no
   *  fields — seam map §1d). Memoized per collection in `_wildcardCache`. */
  private _wildcardContribution(collection: string): ViaPosture {
    const cached = this._wildcardCache.get(collection)
    if (cached) return cached
    let result = DEFAULT_POSTURE
    const prefix = `${collection}${SEP}`
    for (const [id, posture] of this._posture) {
      if (!id.startsWith(prefix) || id === `${prefix}*`) continue
      result = foldWildcardSecurity(result, posture)
    }
    this._wildcardCache.set(collection, result)
    return result
  }

  private _computeEffective(id: string, edge: DerivedEdge): ViaPosture {
    const cached = this._effectiveCache.get(id)
    if (cached) return cached
    let result = DEFAULT_POSTURE
    for (const source of edge.sources) {
      result = foldPosture(result, this._contribution(nodeId(source), edge.kind))
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
   *  `via/graph-wiring.ts#applyTaintOverlay` intersects this with `exportable === false`
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

  /** Dispatch (Task 4): every derived target triggered by a write to `collection`. Excludes
   *  `'ref'` edges (#650 Task 5 review, folded Minor) — a `'ref'` edge is consulted only by the
   *  delete/forget-time restrict/cascade/nullify path ({@link referencingEdgesOf}), never by the
   *  sync/cutover/restore dispatch wave (`runGraphDispatchWave`); counting it here defeated that
   *  wave's zero-cost early-continue, costing every write to a referenced backing collection an
   *  unconditional decrypt + two no-op dispatch passes. {@link derivedArtifactsOf} (erasure
   *  fanout) still includes `'ref'` edges — the forget path genuinely needs them. */
  dependentsOf(collection: string): ReadonlyArray<{ readonly target: FieldRef; readonly kind: EdgeKind; readonly grain: Grain }> {
    return this._targetsDependingOn(collection).filter((edge) => edge.kind !== 'ref')
  }

  /** Erasure (Task 6): derived artifacts of a forgotten record whose source is `collection`. */
  derivedArtifactsOf(collection: string): ReadonlyArray<{ readonly target: FieldRef; readonly kind: EdgeKind; readonly grain: Grain }> {
    return this._targetsDependingOn(collection)
  }

  /** Referencing edges pointing AT a backing dimension (delete/forget-time restrict/cascade/
   *  nullify, #650 Task 5) — an O(1) reverse lookup via the existing `_out` map (keyed at the
   *  dimension's wildcard `field:'*'` node, the same convention every whole-collection source
   *  already uses), NEVER a scan across collections or records. `backing` is the collection name
   *  a lookup field's edge was registered against (a reserved dimension's `_dict_<name>`/
   *  `_lookup_<name>` collection name, or a matrix dimension's own collection name). */
  referencingEdgesOf(backing: string): ReadonlyArray<{ readonly referencing: FieldRef; readonly onDelete: OnDelete; readonly keyField: string }> {
    const targets = this._out.get(nodeId({ collection: backing, field: '*' }))
    if (!targets) return []
    const out: Array<{ referencing: FieldRef; onDelete: OnDelete; keyField: string }> = []
    for (const entry of targets) {
      // #678 — `kind` is read directly off THIS `_out` entry (edge-local) instead of
      // re-derefing `_in`. This also fixes the symmetric ref-vanishes hazard: under a
      // registration order where a LATER `registerDerived` call for the same target
      // overwrites `_in`'s kind away from `'ref'`, the old `_in`-derefing check would
      // silently drop a genuine referencing edge from cascade/nullify delete machinery
      // even though this specific edge was truly registered as `'ref'`.
      if (entry.kind !== 'ref') continue
      const edge = this._in.get(nodeId(entry.target))
      if (edge?.onDelete !== undefined) {
        out.push({ referencing: entry.target, onDelete: edge.onDelete, keyField: edge.keyField ?? 'id' })
      }
    }
    return out
  }
}
