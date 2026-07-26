/**
 * Golden export-surface freeze for the `@noy-db/hub/cargo` seam (lexicon).
 *
 * `/cargo` is the canonical orchestration seam klum-db binds to (custody,
 * deed, diff, distributed query, addressing, change-observation); `/kernel`
 * remains as a deprecated alias. Like the `/kernel` golden, this freezes the
 * export list against a checked-in baseline (`cargo-surface.golden.json`) so
 * drift fails CI:
 *   - ADDING an export fails until the baseline is updated (visible, reviewed).
 *   - REMOVING / RENAMING an export fails loudly.
 *
 * MECHANISM (mirrors `kernel-surface-golden.test.ts`, adapted for the barrel's
 * `export * from './floor.js'` floor):
 *   1. VALUE exports — enumerated at runtime via `Object.keys(import * as cargo)`.
 *   2. SOURCE parse — because `/cargo` re-exports the whole `/kernel` surface
 *      via `export *`, the source-parse UNIONS the names parsed out of BOTH the
 *      cargo source (the orchestration delta) AND the kernel source (the floor).
 *   3. TYPE-only exports — same union of `export type { … } from` blocks. A
 *      compile-time `import type` list additionally asserts every baselined type
 *      still resolves, so a removal/rename also breaks `typecheck`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as cargo from '../src/with-cargo/index.js'
import type {
  AccessibleVault, AggregateResult, AggregateSpec, ChangeEvent, Collection,
  AdoptPartitionOptions, AdoptPartitionResult, ClosureResult, CollectionMeta,
  CoordinationProvider, CreateOwnerManagedOptions, CreateOwnerOptions, CreateOwnerResult,
  CreateOwnerStandardOptions, DanglingRefNotice, DecryptedRecord, DeedMarker, DrainBarrierOptions,
  ExtractPartitionResult, WalkClosureOptions,
  ExtractionPreview, FenceState, FuseOptions, GrantCustodianOptions, IndexDef, JoinStrategy,
  LiberateOptions, LiberateResult, LiveAggregation, LiveQuery, Noydb, Operator,
  Query, RetrieveHit, RetrieveOptions, SealingKeyProvider, Unsubscribe, Vault,
  VaultMeta, WriteConflict, WriteHook, WriteQueue, WriterPresence,
} from '../src/with-cargo/index.js'

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
    return [...out]
  }
  return {
    types: collect(/export\s+type\s*\{([^}]*)\}\s*from/g),
    values: collect(/export\s*\{([^}]*)\}\s*from/g),
  }
}

const uniqSort = (xs: string[]): string[] => [...new Set(xs)].sort()

const baseline: Surface = JSON.parse(read('./cargo-surface.golden.json')) as Surface
// `export *` from /kernel means the cargo surface = cargo-source delta ∪ kernel floor.
const cargoSrc = parseExports(read('../src/with-cargo/index.ts'))
const kernelSrc = parseExports(read('../src/with-cargo/floor.ts'))
const parsed = {
  values: uniqSort([...cargoSrc.values, ...kernelSrc.values]),
  types: uniqSort([...cargoSrc.types, ...kernelSrc.types]),
}

describe('@noy-db/hub/cargo — golden export surface', () => {
  it('value exports match the frozen baseline (runtime enumeration)', () => {
    const runtime = Object.keys(cargo)
      .filter((k) => (cargo as Record<string, unknown>)[k] !== undefined)
      .sort()
    expect(runtime).toEqual([...baseline.values].sort())
  })

  it('value exports in source match the baseline (source parse, ∪ kernel floor)', () => {
    expect(parsed.values).toEqual([...baseline.values].sort())
  })

  it('type exports match the frozen baseline (source parse, ∪ kernel floor)', () => {
    expect(parsed.types).toEqual([...baseline.types].sort())
  })
})

// Compile-time exhaustiveness: every baselined type must still be exported.
// A removal/rename breaks `typecheck` here in addition to the source-parse test.
type _FrozenTypes = [
  AccessibleVault, AggregateResult<AggregateSpec>, AggregateSpec, ChangeEvent,
  Collection<Record<string, unknown>>, CollectionMeta, CoordinationProvider,
  AdoptPartitionOptions, AdoptPartitionResult, ClosureResult,
  CreateOwnerManagedOptions, CreateOwnerOptions, CreateOwnerResult, CreateOwnerStandardOptions,
  DanglingRefNotice, DecryptedRecord, DeedMarker, DrainBarrierOptions, ExtractPartitionResult,
  ExtractionPreview, WalkClosureOptions,
  FenceState, FuseOptions, GrantCustodianOptions,
  IndexDef, JoinStrategy, LiberateOptions, LiberateResult,
  LiveAggregation<Record<string, unknown>>, LiveQuery<Record<string, unknown>>,
  Noydb, Operator, Query<Record<string, unknown>>, RetrieveHit<Record<string, unknown>>,
  RetrieveOptions, SealingKeyProvider, Unsubscribe, Vault, VaultMeta,
  WriteConflict, WriteHook, WriteQueue, WriterPresence,
]
