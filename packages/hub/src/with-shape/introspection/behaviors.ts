/**
 * `Vault.listBehaviors()` builder (#947 Task 3) — a read-only, typed
 * enumeration of the five behavior registries a vault can carry: guards,
 * derivations, materialized views, overlays, satellites. Each entry
 * carries the behavior's stable name (the declared `name`, or a
 * deterministic fallback for an unnamed guard/derivation) plus the
 * SERIALIZABLE half of its spec — every function-valued field (`check`,
 * `derive`, `compute`, a rollup's `compute`, an MV's `query`/`rowKey`/
 * `map`, …) is stripped before it reaches the caller. Registries the
 * vault never initialized (no guard/derivation/MV/overlay/satellite
 * strategy was passed to `createNoydb`) contribute an empty array.
 *
 * @module
 */
import type { GuardRegistry } from '../../with-audit/guards/registry.js'
import type { DerivationRegistry } from '../../with-formula/derivations/registry.js'
import { fallbackDerivationName } from './derivation-key.js'
import type { MaterializedViewRegistry } from '../../with-formula/materialized-views/registry.js'
import type { OverlayedViewRegistry } from '../../with-formula/overlay-views/registry.js'
import type { OverlayFieldMergeMode } from '../../with-formula/overlay-views/types.js'
import type { SatelliteRegistry } from '../satellites/registry.js'

/** One guard's public identity + declarative (non-function) config. */
export interface GuardBehaviorEntry {
  readonly name: string
  readonly collection: string
  readonly frozenFields?: { readonly fields: readonly string[] }
  readonly amendment?: { readonly roles: readonly ('admin' | 'owner')[] }
}

/** One derivation output declaration, functions (`key`) stripped. */
export interface DerivationOutputEntry {
  readonly shape: 'record' | 'array'
  readonly collection: string
  readonly optional?: boolean
  readonly denorm?: readonly string[]
  readonly maxFanout?: number
}

/** One derivation's public identity + declarative (non-function) config. */
export interface DerivationBehaviorEntry {
  readonly name: string
  readonly source: string
  readonly sources?: readonly string[]
  readonly triggerBy?: ReadonlyArray<{ readonly collection: string; readonly on: string; readonly maxFanout?: number }>
  readonly rollup?: { readonly from: string; readonly key: string; readonly field: string }
  readonly deterministic: true
  readonly outputs: Readonly<Record<string, DerivationOutputEntry>>
  readonly lifecycle: 'eager' | 'lazy' | { readonly mode: 'eager' | 'lazy'; readonly maxDepth?: number }
  readonly strict?: boolean
}

/** One materialized view's identity + its spec, functions stripped recursively. */
export interface MaterializedViewBehaviorEntry {
  readonly name: string
  readonly spec: Readonly<Record<string, unknown>>
}

/** One overlay's identity + config — `OverlayedViewSpec` carries no function fields. */
export interface OverlayBehaviorEntry {
  readonly name: string
  readonly base: string
  readonly overlay: string
  readonly shadowField: string
  readonly shadowValue: unknown
  readonly mergeMode?: OverlayFieldMergeMode
}

/** One satellite pairing — `SatelliteSpec` carries no function fields. */
export interface SatelliteBehaviorEntry {
  readonly name: string
  readonly base: string
  readonly fields: readonly string[]
  readonly joined?: string
}

/** Typed, read-only enumeration of all five behavior registries. */
export interface BehaviorSummary {
  readonly guards: readonly GuardBehaviorEntry[]
  readonly derivations: readonly DerivationBehaviorEntry[]
  readonly materializedViews: readonly MaterializedViewBehaviorEntry[]
  readonly overlays: readonly OverlayBehaviorEntry[]
  readonly satellites: readonly SatelliteBehaviorEntry[]
}

/** The five registries `Vault.listBehaviors()` reads from — `null` when the vault never initialized that strategy. */
export interface BehaviorRegistries {
  readonly guards: GuardRegistry | null
  readonly derivations: DerivationRegistry | null
  readonly materializedViews: MaterializedViewRegistry | null
  readonly overlays: OverlayedViewRegistry | null
  readonly satellites: SatelliteRegistry | null
}

export function buildBehaviorSummary(registries: BehaviorRegistries): BehaviorSummary {
  return {
    guards: buildGuardEntries(registries.guards),
    derivations: buildDerivationEntries(registries.derivations),
    materializedViews: buildMaterializedViewEntries(registries.materializedViews),
    overlays: buildOverlayEntries(registries.overlays),
    satellites: buildSatelliteEntries(registries.satellites),
  }
}

function buildGuardEntries(registry: GuardRegistry | null): readonly GuardBehaviorEntry[] {
  if (!registry) return []
  const unnamedOccurrence = new Map<string, number>()
  return registry.all().map((spec) => {
    let name = spec.name
    if (name === undefined) {
      const occurrence = (unnamedOccurrence.get(spec.collection) ?? 0) + 1
      unnamedOccurrence.set(spec.collection, occurrence)
      name = `${spec.collection}#${occurrence}`
    }
    return {
      name,
      collection: spec.collection,
      ...(spec.frozenFields ? { frozenFields: { fields: spec.frozenFields.fields } } : {}),
      ...(spec.amendment ? { amendment: { roles: spec.amendment.roles } } : {}),
    }
  })
}

function buildDerivationEntries(registry: DerivationRegistry | null): readonly DerivationBehaviorEntry[] {
  if (!registry) return []
  const usedNames = new Set<string>()
  const entries = registry.all().map(({ spec }) => {
    const outputCollections = Object.values(spec.outputs).map((o) => o.collection)
    const name = spec.name ?? fallbackDerivationName(outputCollections, spec.source, usedNames)
    usedNames.add(name)
    const outputs: Record<string, DerivationOutputEntry> = {}
    for (const [key, output] of Object.entries(spec.outputs)) {
      outputs[key] = output.shape === 'record'
        ? { shape: 'record', collection: output.collection, ...(output.optional !== undefined ? { optional: output.optional } : {}), ...(output.denorm ? { denorm: output.denorm } : {}) }
        : { shape: 'array', collection: output.collection, ...(output.maxFanout !== undefined ? { maxFanout: output.maxFanout } : {}) }
    }
    return {
      name,
      source: spec.source,
      ...(spec.sources ? { sources: spec.sources } : {}),
      ...(spec.triggerBy ? { triggerBy: spec.triggerBy } : {}),
      ...(spec.rollup ? { rollup: { from: spec.rollup.from, key: spec.rollup.key, field: spec.rollup.field } } : {}),
      deterministic: true as const,
      outputs,
      lifecycle: spec.lifecycle,
      ...(spec.strict !== undefined ? { strict: spec.strict } : {}),
    }
  })
  return entries
}

function buildMaterializedViewEntries(registry: MaterializedViewRegistry | null): readonly MaterializedViewBehaviorEntry[] {
  if (!registry) return []
  return registry.all().map(({ spec }) => ({
    name: spec.name,
    spec: stripFunctions(spec) as Readonly<Record<string, unknown>>,
  }))
}

function buildOverlayEntries(registry: OverlayedViewRegistry | null): readonly OverlayBehaviorEntry[] {
  if (!registry) return []
  return registry.all().map((spec) => ({
    name: spec.name,
    base: spec.base,
    overlay: spec.overlay,
    shadowField: spec.shadowField,
    shadowValue: spec.shadowValue,
    ...(spec.mergeMode ? { mergeMode: spec.mergeMode } : {}),
  }))
}

function buildSatelliteEntries(registry: SatelliteRegistry | null): readonly SatelliteBehaviorEntry[] {
  if (!registry) return []
  return registry.allSpecs().map((spec) => ({
    name: spec.satellite,
    base: spec.base,
    fields: spec.fields,
    ...(spec.joined !== undefined ? { joined: spec.joined } : {}),
  }))
}

/**
 * Recursively strip every function-valued field from a plain
 * object/array, producing a JSON-safe clone. The projection primitive
 * behind `materializedViews[].spec` — an MV spec is too large and
 * varied (query/unionSources/projection forms, each with their own
 * callbacks) to hand-list a serializable half field-by-field; this
 * generic pass gives the same "never a function body" guarantee without
 * tracking every field individually.
 */
function stripFunctions(value: unknown): unknown {
  if (typeof value === 'function') return undefined
  if (Array.isArray(value)) return value.map(stripFunctions).filter((v) => v !== undefined)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stripped = stripFunctions(v)
      if (stripped !== undefined) out[k] = stripped
    }
    return out
  }
  return value
}
