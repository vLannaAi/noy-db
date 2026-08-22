/**
 * Golden export-surface freeze for `@noy-db/hub/introspection`.
 *
 * ## Why this subpath is frozen, and why it was not before
 *
 * `/introspection` began as a themed grouping — "symbols that previously had
 * no home but the root barrel", per SERVICES.md — added for navigability
 * rather than as a binding target. It has since become the contract the whole
 * UI family binds: noy-db-ui's three packages carry 9 imports from here
 * against 7 from the bare root (#1021), and that migration is the family's
 * remedy for a root-barrel coupling where "any root export change is a
 * potential ui break".
 *
 * In 2026-08-22 a `@noy-db/hub/ui` PORT was proposed — `NoydbSurface` plus a
 * descriptor/factory/locator mirroring `to-*`/`at-*`/`by-*` — and DECLINED.
 * The argument that settled it is structural, not procedural: those three are
 * DRIVEN ports, where hub holds the reference and calls the satellite. A UI is
 * a DRIVING adapter — it calls hub, and hub never invokes a UI. A
 * `SurfaceLocator` would be registry machinery with no caller, which is this
 * repo's unexecuted-claim pattern in type form.
 *
 * The consequence lands here. `/to` — the equivalent contract for the store
 * family — has had a golden freeze since S5. `/introspection` had none, so
 * the subpath the UI family was told to bind INSTEAD of a port carried no
 * stability guarantee at all. Telling a consumer "bind this" is a promise;
 * this is the promise.
 *
 * MECHANISM — identical to `to-surface-golden.test.ts`: runtime `Object.keys`
 * freezes the VALUE exports; a source-parse of the `export [type] { … } from`
 * blocks freezes the TYPE-only exports (erased at runtime); a compile-time
 * type list asserts every baselined type still resolves, so a removal also
 * breaks `typecheck` rather than only this file.
 *
 * Adding an export requires a visible baseline update. Removing or renaming
 * one fails loudly — which is the point, because a third-party UI binding it
 * has no other signal.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as introspection from '../src/with-shape/introspection/index.js'
import type {
  BehaviorSummary,
  CollectionConfig,
  CollectionDescription,
  CollectionDescriptor,
  CollectionStats,
  DerivationBehaviorEntry,
  DerivationDescriptor,
  DerivationOutputEntry,
  DescribeOptions,
  DescribedField,
  DumpSchemaOptions,
  FieldDescriptor,
  FieldMeta,
  FieldSource,
  GuardBehaviorEntry,
  InternalCollectionStats,
  ListProjectionOptions,
  MaterializedViewBehaviorEntry,
  MaterializedViewDescriptor,
  OverlayBehaviorEntry,
  OverlayViewDescriptor,
  SatelliteBehaviorEntry,
  SchemaIntrospection,
  SemanticType,
  StandardSchemaV1Issue,
  VaultIntrospectState,
  VaultSchemaSnapshot,
} from '../src/with-shape/introspection/index.js'

interface Surface {
  readonly values: readonly string[]
  readonly types: readonly string[]
}

function read(url: string): string {
  return readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8')
}

/** Strip comments, then collect names from `export [type] { … } from` blocks. */
function parseExports(src: string): { values: string[]; types: string[] } {
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const collect = (re: RegExp): string[] => {
    const out = new Set<string>()
    for (const m of clean.matchAll(re)) {
      for (const part of (m[1] ?? '').split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) out.add(name)
      }
    }
    return [...out].sort()
  }
  return {
    types: collect(/export\s+type\s*\{([^}]*)\}\s*from/g),
    values: collect(/export\s*\{([^}]*)\}\s*from/g),
  }
}

const baseline: Surface = JSON.parse(read('./introspection-surface.golden.json')) as Surface
const parsed = parseExports(read('../src/with-shape/introspection/index.ts'))

describe('@noy-db/hub/introspection — golden export surface', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(introspection)
      .filter((k) => (introspection as Record<string, unknown>)[k] !== undefined)
      .sort()
    expect(runtime).toEqual([...baseline.values].sort())
  })

  it('value exports in source match the baseline (source parse)', () => {
    expect(parsed.values).toEqual([...baseline.values].sort())
  })

  it('type exports match the frozen baseline (source parse)', () => {
    expect(parsed.types).toEqual([...baseline.types].sort())
  })

  it('carries the three symbols the UI family actually binds', () => {
    // Named explicitly rather than left to the count: these are what noy-db-ui
    // imports today, and what a `/ui` port would have had to re-expose. If one
    // ever leaves this subpath, the decision to decline `/ui` needs revisiting
    // rather than the baseline quietly shrinking.
    for (const symbol of ['CollectionDescription', 'DescribedField', 'FieldMeta']) {
      expect(baseline.types, `${symbol} is load-bearing for the UI family`).toContain(symbol)
    }
    // #1021's residue: the one import noy-db-ui could NOT migrate, because it
    // reached `/introspection` only in 0.6.0-pre.9 and their floor is
    // ^0.6.0-pre.0. It is here now; the floor is what still holds it back.
    expect(baseline.types).toContain('StandardSchemaV1Issue')
  })
})

// Compile-time exhaustiveness: every baselined type must still be exported.
type _FrozenTypes = [
  BehaviorSummary,
  CollectionConfig,
  CollectionDescription,
  CollectionDescriptor,
  CollectionStats,
  DerivationBehaviorEntry,
  DerivationDescriptor,
  DerivationOutputEntry,
  DescribeOptions,
  DescribedField,
  DumpSchemaOptions,
  FieldDescriptor,
  FieldMeta,
  FieldSource,
  GuardBehaviorEntry,
  InternalCollectionStats,
  ListProjectionOptions,
  MaterializedViewBehaviorEntry,
  MaterializedViewDescriptor,
  OverlayBehaviorEntry,
  OverlayViewDescriptor,
  SatelliteBehaviorEntry,
  SchemaIntrospection,
  SemanticType,
  StandardSchemaV1Issue,
  VaultIntrospectState,
  VaultSchemaSnapshot,
]
