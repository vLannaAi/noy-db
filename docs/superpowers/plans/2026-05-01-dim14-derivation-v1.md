# Dimension 14 (derived data) v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `withDerivation` strategy in `@noy-db/hub` that lets a vault declare deterministic derivations of typed outputs from source records, with eager / lazy lifecycle, automatic invalidation on source change, and atomic rollback inside `withTransactions`. Outputs route to existing collections; no new storage backends in v1.

**Architecture:** Strategy-seam pattern matching `withHistory` / `withTransactions`. New `packages/hub/src/derivations/` directory with `strategy.ts` (interface + NO_DERIVATION stub), `active.ts` (`withDerivation()` factory), `registry.ts` (strategy graph + cycle detection), `executor.ts` (run + multi-output dispatch), `index.ts` (subpath barrel). Wired through `NoydbOptions.derivationStrategy`. Hooks into existing `Collection.put` (post-write trigger) and `Collection.get` (lazy-mode stale check). Outputs encrypted with the same DEK as the source — zero-knowledge invariant preserved.

**Tech Stack:** TypeScript ESM (`@noy-db/hub`), Vitest for tests, pnpm + Turbo monorepo, tsup for build. Same Web-Crypto-only stack as the rest of the hub.

**Spec:** [`docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md`](../specs/2026-05-01-dim14-derivation-v1-design.md)

---

## File structure

### Files to create

| Path | Responsibility |
|---|---|
| `packages/hub/src/derivations/strategy.ts` | `DerivationStrategy` interface + `NO_DERIVATION` stub |
| `packages/hub/src/derivations/types.ts` | `DerivationSpec`, `OutputSpec`, `DerivationLifecycle`, `DerivedFromMeta` |
| `packages/hub/src/derivations/active.ts` | `withDerivation()` factory; produces the active strategy |
| `packages/hub/src/derivations/registry.ts` | `DerivationRegistry` — strategy graph + cycle detection + dispatch |
| `packages/hub/src/derivations/executor.ts` | `DerivationExecutor` — run derive, dispatch outputs, partial-failure capture |
| `packages/hub/src/derivations/strategy-hash.ts` | `computeStrategyHash(spec)` — SHA-256 over canonical strategy shape |
| `packages/hub/src/derivations/index.ts` | Subpath barrel exporting `withDerivation` + types |
| `packages/hub/src/derivations/strategy.test.ts` | Unit tests for NO_DERIVATION stub |
| `packages/hub/src/derivations/active.test.ts` | Unit tests for `withDerivation()` factory shape |
| `packages/hub/src/derivations/registry.test.ts` | Unit tests for cycle detection + registration |
| `packages/hub/src/derivations/executor.test.ts` | Unit tests for executor (eager/lazy/strict/partial-failure) |
| `packages/hub/src/derivations/strategy-hash.test.ts` | Unit tests for strategy-hash determinism |
| `packages/hub/src/derivations/integration.test.ts` | Integration: vault + derivations end-to-end against `to-memory` and `to-file` |
| `showcases/src/70-with-derivation.showcase.test.ts` | End-to-end showcase: PDF source → metadata + text outputs |
| `docs/subsystems/derivations.md` | Reader-facing subsystem doc |

### Files to modify

| Path | Why |
|---|---|
| `packages/hub/src/types.ts` | Add `derivationStrategy?: DerivationStrategy` to `NoydbOptions`; add optional `_derivedFrom` to envelope payload type |
| `packages/hub/src/errors.ts` | Add `DerivationCycleError`, `DerivationOutputUnknownError`, `DerivationDepthError`, `DerivationOutputError` |
| `packages/hub/src/noydb.ts` | Wire `derivationStrategy` into Noydb constructor with `?? NO_DERIVATION` fallback; expose `vault.deriveAll(name)` |
| `packages/hub/src/collection.ts` | At end of `put` (post-store-write): call `derivationRegistry.onSourceWrite(...)`. At start of `get` for lazy mode: call `derivationRegistry.resolveStaleIfAny(...)` |
| `packages/hub/src/tx/transaction.ts` | Accept derivation operations as part of the rollback set when strict-mode derivations run inside a transaction |
| `packages/hub/package.json` | Add subpath export `./derivations` |
| `packages/hub/tsup.config.ts` | Add `derivations/index.ts` to entry list (if config uses explicit entries) |
| `features.yaml` | New `derivations` section with the showcase reference |

---

## Task 1: Scaffold the derivations subsystem (strategy seam, no logic)

**Files:**
- Create: `packages/hub/src/derivations/strategy.ts`
- Create: `packages/hub/src/derivations/types.ts`
- Create: `packages/hub/src/derivations/index.ts`
- Create: `packages/hub/src/derivations/strategy.test.ts`
- Modify: `packages/hub/src/types.ts` (NoydbOptions extension)
- Modify: `packages/hub/package.json` (subpath export)

- [ ] **Step 1: Create the types file**

```ts
// packages/hub/src/derivations/types.ts

/** v1 only supports record-shaped outputs. Blob/stream/embedding outputs deferred to v2. */
export type OutputShape = 'record'

/** Lifecycle controls when derivation runs relative to source mutations. */
export type DerivationLifecycle =
  | { mode: 'eager' }
  | { mode: 'lazy' }

/** Specification for one named output of a derivation. */
export interface OutputSpec {
  /** v1: must be 'record'. */
  shape: OutputShape
  /** Target collection name where the derived record is written. */
  collection: string
}

/** A single derivation strategy: source collection → typed outputs. */
export interface DerivationSpec<TSource = unknown, TOutputs extends Record<string, unknown> = Record<string, unknown>> {
  /** Source collection name. */
  source: string
  /** v1 only: must be true. Non-deterministic deferred to v3. */
  deterministic: true
  /** Map of named outputs and their target shape/collection. */
  outputs: { [K in keyof TOutputs]: OutputSpec }
  /** Derive function — runs on plaintext source, returns map of typed outputs. */
  derive: (source: TSource) => Promise<TOutputs> | TOutputs
  /** When derivation runs. */
  lifecycle: DerivationLifecycle
  /** If true, any output failure rolls back the source write inside withTransactions. Default false. */
  strict?: boolean
  /** Maximum derivation cascade depth before DerivationDepthError. Default 5. */
  maxDepth?: number
}

/** Envelope-payload metadata identifying a record as derived from a source. Lives inside `_data`, not unencrypted. */
export interface DerivedFromMeta {
  source: string
  sourceId: string
  sourceVersion: number
  derivedAt: string
  strategyHash: string
}
```

- [ ] **Step 2: Create the strategy seam**

```ts
// packages/hub/src/derivations/strategy.ts

/**
 * Strategy seam for the optional derivation subsystem. `withDerivation()`
 * is only reachable through `@noy-db/hub/derivations`. Consumers who don't
 * declare derivations ship none of the registry / executor code.
 *
 * @internal
 */

import type { DerivationSpec } from './types.js'

/**
 * @internal
 */
export interface DerivationStrategy {
  /** All derivation specs registered for this strategy (one per source collection). */
  readonly specs: ReadonlyArray<DerivationSpec>
}

const NOT_ENABLED = new Error(
  'Derivations require the derivation strategy. Import ' +
  '`{ withDerivation }` from "@noy-db/hub/derivations" and pass it to ' +
  '`createNoydb({ derivationStrategy: withDerivation(...) })`.',
)

/**
 * No-op stub used when no derivation strategy is configured.
 * @internal
 */
export const NO_DERIVATION: DerivationStrategy = {
  specs: [],
}

/** @internal */
export function assertDerivationsEnabled(strategy: DerivationStrategy): void {
  if (strategy === NO_DERIVATION) throw NOT_ENABLED
}
```

- [ ] **Step 3: Create the subpath barrel (factory not yet implemented; re-exports types only)**

```ts
// packages/hub/src/derivations/index.ts

/**
 * `@noy-db/hub/derivations` — derivation primitive (Dimension 14 v1).
 * See docs/subsystems/derivations.md for the reader-facing overview.
 *
 * @public
 */

export type { DerivationStrategy } from './strategy.js'
export type {
  DerivationSpec,
  OutputSpec,
  OutputShape,
  DerivationLifecycle,
  DerivedFromMeta,
} from './types.js'
```

- [ ] **Step 4: Add `derivationStrategy` to NoydbOptions**

In `packages/hub/src/types.ts`, find the `NoydbOptions` interface (around line 1370) and add this property in the same style as `historyStrategy` and `txStrategy`:

```ts
  /**
   * tree-shake seam — optional derivation subsystem. Pass
   * `withDerivation(specs)` from `@noy-db/hub/derivations` to enable
   * source→output derivation strategies. When omitted, no derivations
   * run; the registry / executor stay out of the bundle.
   *
   * @internal
   */
  readonly derivationStrategy?: DerivationStrategy
```

Add the import at the top of `types.ts`:

```ts
import type { DerivationStrategy } from './derivations/strategy.js'
```

- [ ] **Step 5: Add the subpath export to `packages/hub/package.json`**

Find the `"exports"` block. Add this entry alongside the existing subpath entries (e.g., after `"./history"`):

```json
    "./derivations": {
      "import": {
        "types": "./dist/derivations/index.d.ts",
        "default": "./dist/derivations/index.js"
      },
      "require": {
        "types": "./dist/derivations/index.d.cts",
        "default": "./dist/derivations/index.cjs"
      }
    },
```

- [ ] **Step 6: Write the failing test for the seam**

```ts
// packages/hub/src/derivations/strategy.test.ts

import { describe, expect, it } from 'vitest'
import { NO_DERIVATION, type DerivationStrategy } from './strategy.js'

describe('NO_DERIVATION', () => {
  it('is a frozen no-op stub with no specs', () => {
    expect(NO_DERIVATION.specs).toEqual([])
    expect(NO_DERIVATION.specs.length).toBe(0)
  })

  it('is referentially stable (same import returns same value)', () => {
    const a = NO_DERIVATION
    const b: DerivationStrategy = NO_DERIVATION
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 7: Run the test, verify pass**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/strategy.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 8: Verify the subpath import resolves**

Run:
```bash
pnpm turbo build --filter=@noy-db/hub
pnpm turbo typecheck --filter=@noy-db/hub
```

Expected: build + typecheck pass; the new `dist/derivations/index.{js,d.ts}` is produced.

- [ ] **Step 9: Commit**

```bash
git add packages/hub/src/derivations packages/hub/src/types.ts packages/hub/package.json
git commit -m "feat(hub): scaffold derivation strategy seam (no-op)

Adds packages/hub/src/derivations/ subdirectory with strategy.ts +
types.ts + index.ts barrel, plus the @noy-db/hub/derivations subpath
export. NoydbOptions.derivationStrategy added as an optional seam.
NO_DERIVATION stub is in place; no execution logic yet.

First piece of Dim 14 v1; spec at
docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md"
```

---

## Task 2: Strategy hash (deterministic SHA-256 over spec shape)

**Files:**
- Create: `packages/hub/src/derivations/strategy-hash.ts`
- Create: `packages/hub/src/derivations/strategy-hash.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/hub/src/derivations/strategy-hash.test.ts

import { describe, expect, it } from 'vitest'
import { computeStrategyHash } from './strategy-hash.js'
import type { DerivationSpec } from './types.js'

describe('computeStrategyHash', () => {
  const baseSpec: DerivationSpec = {
    source: 'pdfs',
    deterministic: true,
    outputs: {
      metadata: { shape: 'record', collection: 'pdf-meta' },
      text: { shape: 'record', collection: 'pdf-text' },
    },
    derive: (s: unknown) => ({ metadata: {}, text: {} }),
    lifecycle: { mode: 'eager' },
  }

  it('returns a 64-char hex string (sha-256)', async () => {
    const hash = await computeStrategyHash(baseSpec)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is deterministic for identical specs', async () => {
    const a = await computeStrategyHash(baseSpec)
    const b = await computeStrategyHash({ ...baseSpec })
    expect(a).toBe(b)
  })

  it('changes when source changes', async () => {
    const a = await computeStrategyHash(baseSpec)
    const b = await computeStrategyHash({ ...baseSpec, source: 'images' })
    expect(a).not.toBe(b)
  })

  it('changes when outputs map changes', async () => {
    const a = await computeStrategyHash(baseSpec)
    const b = await computeStrategyHash({
      ...baseSpec,
      outputs: { ...baseSpec.outputs, summary: { shape: 'record', collection: 'pdf-summary' } },
    })
    expect(a).not.toBe(b)
  })

  it('changes when derive function source code changes', async () => {
    const a = await computeStrategyHash(baseSpec)
    const b = await computeStrategyHash({
      ...baseSpec,
      derive: (s: unknown) => ({ metadata: { extra: 1 }, text: {} }),
    })
    expect(a).not.toBe(b)
  })

  it('output-key order does not affect hash (canonical sort)', async () => {
    const ordered: DerivationSpec = {
      ...baseSpec,
      outputs: {
        text: { shape: 'record', collection: 'pdf-text' },
        metadata: { shape: 'record', collection: 'pdf-meta' },
      },
    }
    const a = await computeStrategyHash(baseSpec)
    const b = await computeStrategyHash(ordered)
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 2: Run test, verify FAIL**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/strategy-hash.test.ts
```

Expected: All tests fail — `computeStrategyHash` not defined.

- [ ] **Step 3: Implement `computeStrategyHash`**

```ts
// packages/hub/src/derivations/strategy-hash.ts

import type { DerivationSpec } from './types.js'

/**
 * Canonical-shape SHA-256 over the strategy spec. Used in `_derivedFrom`
 * to detect strategy drift — when source / outputs / derive function
 * change, existing derived records mismatch and are eligible for re-derive.
 *
 * @internal
 */
export async function computeStrategyHash(spec: DerivationSpec): Promise<string> {
  const canonical = JSON.stringify({
    source: spec.source,
    deterministic: spec.deterministic,
    outputs: Object.keys(spec.outputs)
      .sort()
      .map((key) => [key, spec.outputs[key]]),
    deriveSource: spec.derive.toString(),
    lifecycle: spec.lifecycle,
    strict: spec.strict ?? false,
    maxDepth: spec.maxDepth ?? 5,
  })
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
```

- [ ] **Step 4: Run test, verify PASS**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/strategy-hash.test.ts
```

Expected: All 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/derivations/strategy-hash.ts packages/hub/src/derivations/strategy-hash.test.ts
git commit -m "feat(hub): add computeStrategyHash for derivation drift detection"
```

---

## Task 3: `withDerivation()` factory + active strategy

**Files:**
- Create: `packages/hub/src/derivations/active.ts`
- Create: `packages/hub/src/derivations/active.test.ts`
- Modify: `packages/hub/src/derivations/index.ts` (export `withDerivation`)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/hub/src/derivations/active.test.ts

import { describe, expect, it } from 'vitest'
import { withDerivation } from './active.js'
import { NO_DERIVATION } from './strategy.js'
import type { DerivationSpec } from './types.js'

const PDF_SPEC: DerivationSpec = {
  source: 'pdfs',
  deterministic: true,
  outputs: {
    metadata: { shape: 'record', collection: 'pdf-meta' },
  },
  derive: (s: { id: string }) => ({ metadata: { sourceId: s.id } }),
  lifecycle: { mode: 'eager' },
}

const IMG_SPEC: DerivationSpec = {
  source: 'images',
  deterministic: true,
  outputs: {
    thumb: { shape: 'record', collection: 'image-thumbs' },
  },
  derive: (s: { id: string }) => ({ thumb: { sourceId: s.id } }),
  lifecycle: { mode: 'lazy' },
}

describe('withDerivation', () => {
  it('returns a strategy holding a single spec when given one spec', () => {
    const strategy = withDerivation(PDF_SPEC)
    expect(strategy.specs).toHaveLength(1)
    expect(strategy.specs[0].source).toBe('pdfs')
  })

  it('returns a strategy holding multiple specs when given an array', () => {
    const strategy = withDerivation([PDF_SPEC, IMG_SPEC])
    expect(strategy.specs).toHaveLength(2)
    expect(strategy.specs.map((s) => s.source)).toEqual(['pdfs', 'images'])
  })

  it('is distinct from NO_DERIVATION', () => {
    const strategy = withDerivation(PDF_SPEC)
    expect(strategy).not.toBe(NO_DERIVATION)
  })

  it('throws if two specs share the same source collection', () => {
    expect(() => withDerivation([PDF_SPEC, { ...PDF_SPEC }])).toThrow(/duplicate source/i)
  })

  it('throws if a spec marks deterministic !== true', () => {
    const bad = { ...PDF_SPEC, deterministic: false as unknown as true }
    expect(() => withDerivation(bad)).toThrow(/deterministic/i)
  })
})
```

- [ ] **Step 2: Run test, verify FAIL**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/active.test.ts
```

Expected: All tests fail — `withDerivation` not defined.

- [ ] **Step 3: Implement `withDerivation`**

```ts
// packages/hub/src/derivations/active.ts

/**
 * Active derivation strategy — `withDerivation()` returns the strategy
 * that the registry / executor wire into Collection.put / Collection.get.
 *
 * @public
 */

import type { DerivationStrategy } from './strategy.js'
import type { DerivationSpec } from './types.js'

/**
 * Build the active derivation strategy from one or more specs.
 *
 * @example
 * ```ts
 * const db = await createNoydb({
 *   store: ...,
 *   derivationStrategy: withDerivation({
 *     source: 'pdfs',
 *     deterministic: true,
 *     outputs: {
 *       metadata: { shape: 'record', collection: 'pdf-metadata' },
 *       text: { shape: 'record', collection: 'pdf-text' },
 *     },
 *     derive: (pdf) => ({ metadata: extract(pdf), text: ocr(pdf) }),
 *     lifecycle: { mode: 'eager' },
 *   }),
 * })
 * ```
 */
export function withDerivation(specOrSpecs: DerivationSpec | DerivationSpec[]): DerivationStrategy {
  const specs = Array.isArray(specOrSpecs) ? specOrSpecs : [specOrSpecs]
  validateSpecs(specs)
  return { specs: Object.freeze(specs.slice()) }
}

function validateSpecs(specs: DerivationSpec[]): void {
  const sources = new Set<string>()
  for (const spec of specs) {
    if (spec.deterministic !== true) {
      throw new Error(
        `withDerivation: spec for source '${spec.source}' has deterministic=${String(spec.deterministic)}; ` +
        `v1 only supports deterministic=true. Non-deterministic derivations are deferred to v3.`,
      )
    }
    if (sources.has(spec.source)) {
      throw new Error(
        `withDerivation: duplicate source collection '${spec.source}'. ` +
        `Combine multiple derivations from the same source into one spec with multiple outputs.`,
      )
    }
    sources.add(spec.source)
  }
}
```

- [ ] **Step 4: Update barrel to export `withDerivation`**

```ts
// packages/hub/src/derivations/index.ts (replace existing)

/**
 * `@noy-db/hub/derivations` — derivation primitive (Dimension 14 v1).
 * @public
 */

export { withDerivation } from './active.js'
export type { DerivationStrategy } from './strategy.js'
export type {
  DerivationSpec,
  OutputSpec,
  OutputShape,
  DerivationLifecycle,
  DerivedFromMeta,
} from './types.js'
```

- [ ] **Step 5: Run test, verify PASS**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/active.test.ts
```

Expected: All 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/derivations/active.ts packages/hub/src/derivations/active.test.ts packages/hub/src/derivations/index.ts
git commit -m "feat(hub): add withDerivation() factory with spec validation"
```

---

## Task 4: Add derivation errors

**Files:**
- Modify: `packages/hub/src/errors.ts`

- [ ] **Step 1: Add the error classes**

Open `packages/hub/src/errors.ts` and add these classes at the end of the file (after the existing error classes, following the same pattern):

```ts
/** Thrown at strategy registration when the derivation graph contains a cycle. */
export class DerivationCycleError extends Error {
  override name = 'DerivationCycleError'
  constructor(public readonly cycle: string[]) {
    super(`Derivation cycle detected: ${cycle.join(' → ')} → ${cycle[0]}`)
  }
}

/** Thrown at strategy registration when an output spec names a collection not declared in the vault. */
export class DerivationOutputUnknownError extends Error {
  override name = 'DerivationOutputUnknownError'
  constructor(public readonly source: string, public readonly outputCollection: string) {
    super(`Derivation from '${source}' targets unknown output collection '${outputCollection}'.`)
  }
}

/** Thrown when a derivation cascade exceeds the configured maximum depth (default 5). */
export class DerivationDepthError extends Error {
  override name = 'DerivationDepthError'
  constructor(public readonly depth: number, public readonly chain: string[]) {
    super(`Derivation cascade depth ${depth} exceeded (chain: ${chain.join(' → ')}).`)
  }
}

/** Thrown for individual output failures inside a derivation execution. Caught by the executor for partial-failure capture. */
export class DerivationOutputError extends Error {
  override name = 'DerivationOutputError'
  constructor(
    public readonly source: string,
    public readonly outputName: string,
    public readonly cause: unknown,
  ) {
    super(`Derivation output '${outputName}' for source '${source}' failed: ${(cause as { message?: string })?.message ?? String(cause)}`)
  }
}
```

- [ ] **Step 2: Verify type-check**

Run:
```bash
pnpm turbo typecheck --filter=@noy-db/hub
```

Expected: typecheck passes.

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/errors.ts
git commit -m "feat(hub): add derivation error classes"
```

---

## Task 5: `DerivationRegistry` — registration + cycle detection

**Files:**
- Create: `packages/hub/src/derivations/registry.ts`
- Create: `packages/hub/src/derivations/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/hub/src/derivations/registry.test.ts

import { describe, expect, it } from 'vitest'
import { DerivationRegistry } from './registry.js'
import { withDerivation } from './active.js'
import { NO_DERIVATION } from './strategy.js'
import { DerivationCycleError } from '../errors.js'
import type { DerivationSpec } from './types.js'

function spec(source: string, ...outputs: string[]): DerivationSpec {
  const outputMap: Record<string, { shape: 'record'; collection: string }> = {}
  for (const out of outputs) outputMap[out] = { shape: 'record', collection: out }
  return {
    source,
    deterministic: true,
    outputs: outputMap,
    derive: () => Object.fromEntries(outputs.map((o) => [o, {}])),
    lifecycle: { mode: 'eager' },
  }
}

describe('DerivationRegistry', () => {
  it('builds empty when given NO_DERIVATION', () => {
    const reg = new DerivationRegistry(NO_DERIVATION)
    expect(reg.isEmpty()).toBe(true)
  })

  it('registers a single spec without cycle', () => {
    const strategy = withDerivation(spec('pdfs', 'pdf-meta'))
    const reg = new DerivationRegistry(strategy)
    expect(reg.isEmpty()).toBe(false)
    expect(reg.specsForSource('pdfs')).toHaveLength(1)
    expect(reg.specsForSource('pdf-meta')).toHaveLength(0)
  })

  it('registers multiple unrelated specs', () => {
    const strategy = withDerivation([spec('pdfs', 'pdf-meta'), spec('images', 'image-thumbs')])
    const reg = new DerivationRegistry(strategy)
    expect(reg.specsForSource('pdfs')).toHaveLength(1)
    expect(reg.specsForSource('images')).toHaveLength(1)
  })

  it('detects a self-loop (A → A)', () => {
    const strategy = withDerivation(spec('a', 'a'))
    expect(() => new DerivationRegistry(strategy)).toThrow(DerivationCycleError)
  })

  it('detects a 2-node cycle (A → B → A)', () => {
    const strategy = withDerivation([spec('a', 'b'), spec('b', 'a')])
    expect(() => new DerivationRegistry(strategy)).toThrow(DerivationCycleError)
  })

  it('detects a 3-node cycle (A → B → C → A)', () => {
    const strategy = withDerivation([spec('a', 'b'), spec('b', 'c'), spec('c', 'a')])
    expect(() => new DerivationRegistry(strategy)).toThrow(DerivationCycleError)
  })

  it('accepts a DAG with branches (A → B, A → C, B → D, C → D)', () => {
    const strategy = withDerivation([
      spec('a', 'b', 'c'),
      spec('b', 'd'),
      spec('c', 'd'),
    ])
    expect(() => new DerivationRegistry(strategy)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test, verify FAIL**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/registry.test.ts
```

Expected: tests fail — `DerivationRegistry` not defined.

- [ ] **Step 3: Implement `DerivationRegistry`**

```ts
// packages/hub/src/derivations/registry.ts

/**
 * DerivationRegistry — vault-internal strategy graph + cycle detection.
 * Built once at vault construction; immutable thereafter.
 *
 * @internal
 */

import { DerivationCycleError } from '../errors.js'
import type { DerivationStrategy } from './strategy.js'
import type { DerivationSpec } from './types.js'

export class DerivationRegistry {
  private readonly bySource: Map<string, DerivationSpec[]> = new Map()

  constructor(strategy: DerivationStrategy) {
    for (const spec of strategy.specs) {
      const list = this.bySource.get(spec.source) ?? []
      list.push(spec)
      this.bySource.set(spec.source, list)
    }
    this.detectCycles()
  }

  isEmpty(): boolean {
    return this.bySource.size === 0
  }

  specsForSource(source: string): readonly DerivationSpec[] {
    return this.bySource.get(source) ?? []
  }

  /** All sources that have at least one registered derivation. */
  sources(): readonly string[] {
    return Array.from(this.bySource.keys())
  }

  /** All output collection names referenced by any spec. */
  outputCollections(): Set<string> {
    const out = new Set<string>()
    for (const specs of this.bySource.values()) {
      for (const spec of specs) {
        for (const output of Object.values(spec.outputs)) {
          out.add(output.collection)
        }
      }
    }
    return out
  }

  /** DFS cycle detection over the source → output-collection graph. */
  private detectCycles(): void {
    const adj: Map<string, Set<string>> = new Map()
    for (const [src, specs] of this.bySource.entries()) {
      const targets = new Set<string>()
      for (const spec of specs) {
        for (const output of Object.values(spec.outputs)) {
          targets.add(output.collection)
        }
      }
      adj.set(src, targets)
    }

    const WHITE = 0, GREY = 1, BLACK = 2
    const color: Map<string, number> = new Map()
    const stack: string[] = []

    const visit = (node: string): void => {
      color.set(node, GREY)
      stack.push(node)
      const neighbors = adj.get(node) ?? new Set()
      for (const next of neighbors) {
        const c = color.get(next) ?? WHITE
        if (c === GREY) {
          // Cycle found — reconstruct from stack
          const cycleStart = stack.indexOf(next)
          throw new DerivationCycleError(stack.slice(cycleStart))
        }
        if (c === WHITE) visit(next)
      }
      color.set(node, BLACK)
      stack.pop()
    }

    for (const node of adj.keys()) {
      if ((color.get(node) ?? WHITE) === WHITE) visit(node)
    }
  }
}
```

- [ ] **Step 4: Run test, verify PASS**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/registry.test.ts
```

Expected: All 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/derivations/registry.ts packages/hub/src/derivations/registry.test.ts
git commit -m "feat(hub): add DerivationRegistry with cycle detection"
```

---

## Task 6: Wire `derivationStrategy` into `Noydb` constructor

**Files:**
- Modify: `packages/hub/src/noydb.ts`

- [ ] **Step 1: Find the Noydb class fields**

In `packages/hub/src/noydb.ts`, locate the existing private fields where `txStrategy` is declared (around line 84). The pattern is:
```ts
private readonly txStrategy: TxStrategy
```

- [ ] **Step 2: Add the registry field and import**

At the top of `noydb.ts`, add the imports:
```ts
import { DerivationRegistry } from './derivations/registry.js'
import { NO_DERIVATION } from './derivations/strategy.js'
```

In the Noydb class, after the `txStrategy` declaration, add:
```ts
private readonly derivationRegistry: DerivationRegistry
```

- [ ] **Step 3: Initialise the registry in the constructor**

In the Noydb constructor (around line 97-99 where `txStrategy` is set), add immediately after:
```ts
this.derivationRegistry = new DerivationRegistry(options.derivationStrategy ?? NO_DERIVATION)
```

- [ ] **Step 4: Expose the registry to internal consumers**

Add a getter on the class so `Vault` / `Collection` can reach the registry without coupling on private state:
```ts
/** @internal — used by Collection to dispatch derivation hooks. */
getDerivationRegistry(): DerivationRegistry {
  return this.derivationRegistry
}
```

- [ ] **Step 5: Verify build + typecheck**

Run:
```bash
pnpm turbo build --filter=@noy-db/hub
pnpm turbo typecheck --filter=@noy-db/hub
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/noydb.ts
git commit -m "feat(hub): wire DerivationRegistry into Noydb constructor"
```

---

## Task 7: Verify `DerivedFromMeta` is correctly placed (no-op confirmation)

**Files:** verification only.

The `DerivedFromMeta` type was already defined in `packages/hub/src/derivations/types.ts` in Task 1. It lives inside the derivations module rather than the broader `packages/hub/src/types.ts` because:

- Only the executor and the derivations module need to construct or consume it
- It's a payload-internal field (inside the encrypted `_data` blob), not part of the envelope shape
- Keeping it module-local avoids bloating the hub's top-level type surface

This task exists in the plan to make the placement choice explicit (don't accidentally duplicate the type into `packages/hub/src/types.ts`). No code changes — proceed to Task 8.

- [ ] **Step 1: Confirm the type exists at the expected location**

Run:
```bash
grep -n "DerivedFromMeta" packages/hub/src/derivations/types.ts
```

Expected: at least one match showing `export interface DerivedFromMeta { ... }`.

- [ ] **Step 2: Confirm the type is NOT duplicated elsewhere**

Run:
```bash
grep -rn "DerivedFromMeta" packages/hub/src/
```

Expected: matches only in `packages/hub/src/derivations/`. If `packages/hub/src/types.ts` also has a definition, remove it (Task 1's location is canonical).

---

## Task 8: `DerivationExecutor` — eager mode, single-output

**Files:**
- Create: `packages/hub/src/derivations/executor.ts`
- Create: `packages/hub/src/derivations/executor.test.ts`

- [ ] **Step 1: Write the failing test (single-output eager)**

```ts
// packages/hub/src/derivations/executor.test.ts

import { describe, expect, it } from 'vitest'
import { DerivationExecutor } from './executor.js'
import { DerivationRegistry } from './registry.js'
import { withDerivation } from './active.js'
import { computeStrategyHash } from './strategy-hash.js'
import type { DerivationSpec } from './types.js'

interface FakeVault {
  put: (collection: string, id: string, record: Record<string, unknown>) => Promise<void>
  get: (collection: string, id: string) => Promise<Record<string, unknown> | null>
}

function makeFakeVault(): FakeVault & { records: Map<string, Map<string, Record<string, unknown>>> } {
  const records = new Map<string, Map<string, Record<string, unknown>>>()
  return {
    records,
    async put(collection, id, record) {
      let bucket = records.get(collection)
      if (!bucket) { bucket = new Map(); records.set(collection, bucket) }
      bucket.set(id, record)
    },
    async get(collection, id) {
      return records.get(collection)?.get(id) ?? null
    },
  }
}

const PDF_SPEC: DerivationSpec<{ id: string; pageCount: number }, { metadata: { pageCount: number } }> = {
  source: 'pdfs',
  deterministic: true,
  outputs: { metadata: { shape: 'record', collection: 'pdf-meta' } },
  derive: (pdf) => ({ metadata: { pageCount: pdf.pageCount } }),
  lifecycle: { mode: 'eager' },
}

describe('DerivationExecutor — eager single-output', () => {
  it('writes a derived record after source write', async () => {
    const vault = makeFakeVault()
    const registry = new DerivationRegistry(withDerivation(PDF_SPEC as DerivationSpec))
    const executor = new DerivationExecutor(registry, vault)

    await executor.runForSource('pdfs', 'doc1', { id: 'doc1', pageCount: 5 }, 1)

    const meta = await vault.get('pdf-meta', 'doc1')
    expect(meta).not.toBeNull()
    expect((meta as { pageCount: number }).pageCount).toBe(5)
  })

  it('attaches _derivedFrom metadata with the strategy hash', async () => {
    const vault = makeFakeVault()
    const registry = new DerivationRegistry(withDerivation(PDF_SPEC as DerivationSpec))
    const executor = new DerivationExecutor(registry, vault)

    await executor.runForSource('pdfs', 'doc1', { id: 'doc1', pageCount: 5 }, 3)

    const meta = await vault.get('pdf-meta', 'doc1')
    const expectedHash = await computeStrategyHash(PDF_SPEC as DerivationSpec)
    const derivedFrom = (meta as { _derivedFrom: Record<string, unknown> })._derivedFrom
    expect(derivedFrom).toMatchObject({
      source: 'pdfs',
      sourceId: 'doc1',
      sourceVersion: 3,
      strategyHash: expectedHash,
    })
    expect(typeof (derivedFrom as { derivedAt: string }).derivedAt).toBe('string')
  })

  it('is a no-op when the source has no registered derivation', async () => {
    const vault = makeFakeVault()
    const registry = new DerivationRegistry(withDerivation(PDF_SPEC as DerivationSpec))
    const executor = new DerivationExecutor(registry, vault)

    await executor.runForSource('unrelated', 'x', { foo: 'bar' }, 1)
    expect(vault.records.get('pdf-meta')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test, verify FAIL**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/executor.test.ts
```

Expected: tests fail — `DerivationExecutor` not defined.

- [ ] **Step 3: Implement the executor with single-output eager**

```ts
// packages/hub/src/derivations/executor.ts

/**
 * DerivationExecutor — runs registered derivations and writes outputs
 * through a write-target abstraction. Decoupled from Collection so
 * tests can inject a fake vault.
 *
 * @internal
 */

import { computeStrategyHash } from './strategy-hash.js'
import { DerivationOutputError } from '../errors.js'
import type { DerivationRegistry } from './registry.js'
import type { DerivationSpec, DerivedFromMeta } from './types.js'

/**
 * Minimal write-target the executor needs. The real Vault implements this
 * (Collection.put / Collection.get); tests inject a Map-backed fake.
 *
 * @internal
 */
export interface DerivationWriteTarget {
  put(collection: string, id: string, record: Record<string, unknown>): Promise<void>
  get(collection: string, id: string): Promise<Record<string, unknown> | null>
}

/**
 * Result of running a single derivation spec for a single source record.
 *
 * @internal
 */
export interface DerivationResult {
  outputs: { name: string; success: boolean; error?: unknown }[]
}

/**
 * @internal
 */
export class DerivationExecutor {
  private readonly hashCache: Map<DerivationSpec, Promise<string>> = new Map()

  constructor(
    private readonly registry: DerivationRegistry,
    private readonly target: DerivationWriteTarget,
  ) {}

  /**
   * Trigger derivations whose source matches `sourceCollection`. No-op if
   * no derivation is registered for that source.
   */
  async runForSource(
    sourceCollection: string,
    sourceId: string,
    sourceRecord: unknown,
    sourceVersion: number,
  ): Promise<DerivationResult[]> {
    const specs = this.registry.specsForSource(sourceCollection)
    const results: DerivationResult[] = []
    for (const spec of specs) {
      results.push(await this.runOne(spec, sourceId, sourceRecord, sourceVersion))
    }
    return results
  }

  private async runOne(
    spec: DerivationSpec,
    sourceId: string,
    sourceRecord: unknown,
    sourceVersion: number,
  ): Promise<DerivationResult> {
    const derived = await spec.derive(sourceRecord as never)
    const strategyHash = await this.getStrategyHash(spec)
    const meta: DerivedFromMeta = {
      source: spec.source,
      sourceId,
      sourceVersion,
      derivedAt: new Date().toISOString(),
      strategyHash,
    }
    const outcomes: DerivationResult['outputs'] = []
    for (const [name, output] of Object.entries(spec.outputs)) {
      const value = (derived as Record<string, unknown>)[name]
      if (value === undefined) {
        outcomes.push({
          name,
          success: false,
          error: new DerivationOutputError(spec.source, name, new Error(`derive() did not return output '${name}'`)),
        })
        continue
      }
      try {
        const record = { ...(value as Record<string, unknown>), _derivedFrom: meta }
        await this.target.put(output.collection, sourceId, record)
        outcomes.push({ name, success: true })
      } catch (cause) {
        outcomes.push({ name, success: false, error: new DerivationOutputError(spec.source, name, cause) })
      }
    }
    return { outputs: outcomes }
  }

  private getStrategyHash(spec: DerivationSpec): Promise<string> {
    let cached = this.hashCache.get(spec)
    if (!cached) {
      cached = computeStrategyHash(spec)
      this.hashCache.set(spec, cached)
    }
    return cached
  }
}
```

- [ ] **Step 4: Run test, verify PASS**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/executor.test.ts
```

Expected: All 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/derivations/executor.ts packages/hub/src/derivations/executor.test.ts
git commit -m "feat(hub): add DerivationExecutor with eager single-output"
```

---

## Task 9: Multi-output dispatch + partial-failure capture

**Files:**
- Modify: `packages/hub/src/derivations/executor.test.ts` (add tests; existing tests stay)

- [ ] **Step 1: Add tests for multi-output success and partial failure**

Append to `packages/hub/src/derivations/executor.test.ts`:

```ts
const MULTI_SPEC: DerivationSpec = {
  source: 'pdfs',
  deterministic: true,
  outputs: {
    metadata: { shape: 'record', collection: 'pdf-meta' },
    text: { shape: 'record', collection: 'pdf-text' },
  },
  derive: (pdf: unknown) => ({
    metadata: { kind: 'meta' },
    text: { kind: 'text' },
  }),
  lifecycle: { mode: 'eager' },
}

describe('DerivationExecutor — multi-output', () => {
  it('writes all outputs on full success', async () => {
    const vault = makeFakeVault()
    const registry = new DerivationRegistry(withDerivation(MULTI_SPEC))
    const executor = new DerivationExecutor(registry, vault)

    const results = await executor.runForSource('pdfs', 'doc1', { id: 'doc1' }, 1)
    expect(results[0].outputs).toHaveLength(2)
    expect(results[0].outputs.every((o) => o.success)).toBe(true)
    expect(await vault.get('pdf-meta', 'doc1')).not.toBeNull()
    expect(await vault.get('pdf-text', 'doc1')).not.toBeNull()
  })

  it('captures partial failure when one output write fails', async () => {
    const failingVault: ReturnType<typeof makeFakeVault> = makeFakeVault()
    const originalPut = failingVault.put.bind(failingVault)
    failingVault.put = async (collection, id, record) => {
      if (collection === 'pdf-text') throw new Error('disk full')
      return originalPut(collection, id, record)
    }

    const registry = new DerivationRegistry(withDerivation(MULTI_SPEC))
    const executor = new DerivationExecutor(registry, failingVault)

    const results = await executor.runForSource('pdfs', 'doc1', { id: 'doc1' }, 1)
    const outcomes = results[0].outputs
    expect(outcomes.find((o) => o.name === 'metadata')?.success).toBe(true)
    expect(outcomes.find((o) => o.name === 'text')?.success).toBe(false)
    expect(await failingVault.get('pdf-meta', 'doc1')).not.toBeNull()
    expect(await failingVault.get('pdf-text', 'doc1')).toBeNull()
  })

  it('captures missing-output failure when derive() omits a declared output', async () => {
    const incompleteSpec: DerivationSpec = {
      ...MULTI_SPEC,
      derive: () => ({ metadata: { kind: 'meta' } }) as Record<string, unknown>,
    }
    const vault = makeFakeVault()
    const registry = new DerivationRegistry(withDerivation(incompleteSpec))
    const executor = new DerivationExecutor(registry, vault)

    const results = await executor.runForSource('pdfs', 'doc1', { id: 'doc1' }, 1)
    expect(results[0].outputs.find((o) => o.name === 'text')?.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests, verify PASS**

The current executor implementation already handles multi-output (it iterates `Object.entries(spec.outputs)`) and partial failure (try/catch per output, plus the missing-output check). Run:

```bash
pnpm vitest run packages/hub/src/derivations/executor.test.ts
```

Expected: All tests pass (the original 3 plus the new 3, total 6).

- [ ] **Step 3: Commit**

```bash
git add packages/hub/src/derivations/executor.test.ts
git commit -m "test(hub): cover multi-output dispatch and partial-failure capture"
```

---

## Task 10: Hook executor into `Collection.put` for eager-mode source writes

**Files:**
- Modify: `packages/hub/src/collection.ts`
- Modify: `packages/hub/src/noydb.ts` (expose executor builder)
- Create: `packages/hub/src/derivations/integration.test.ts`

- [ ] **Step 1: Expose an executor factory from Noydb**

In `packages/hub/src/noydb.ts`, add a method that builds an executor wired to the live vault. Add this near `getDerivationRegistry()`:

```ts
/**
 * @internal — Used by Collection to run derivations.
 * The write target is a thin Collection.put / Collection.get adapter.
 */
buildDerivationExecutor(): import('./derivations/executor.js').DerivationExecutor {
  const target = {
    put: async (collection: string, id: string, record: Record<string, unknown>) => {
      const col = this.vault.collection(collection)
      await col.put(id, record as never)
    },
    get: async (collection: string, id: string) => {
      const col = this.vault.collection(collection)
      return (await col.get(id)) as Record<string, unknown> | null
    },
  }
  // Lazy import to keep module-graph dependency minimal
  const { DerivationExecutor } = require('./derivations/executor.js') as typeof import('./derivations/executor.js')
  return new DerivationExecutor(this.derivationRegistry, target)
}
```

(If the codebase prohibits CommonJS-style `require` in TypeScript ESM, swap for `await import(...)` and make the method `async`. Adjust the call site in Step 2 accordingly.)

- [ ] **Step 2: Add the post-write hook in Collection.put**

In `packages/hub/src/collection.ts`, locate the `Collection.put(...)` method. After the existing `await this.store.put(...)` line and any subsequent history/sync calls but before the method returns, add the derivation dispatch:

```ts
// Trigger derivations registered for this source collection.
// Eager mode: run synchronously; lazy mode: just mark stale.
const noydb = this.noydb // existing private reference; rename if codebase uses a different name
const registry = noydb.getDerivationRegistry()
if (!registry.isEmpty()) {
  const specs = registry.specsForSource(this.name)
  if (specs.length > 0) {
    const eagerSpecs = specs.filter((s) => s.lifecycle.mode === 'eager')
    if (eagerSpecs.length > 0) {
      const executor = noydb.buildDerivationExecutor()
      // The plaintext record is `record` (the put arg already validated/decrypted).
      // Source version is the new envelope's `_v` (passed by the existing put path).
      await executor.runForSource(this.name, id, record, /* sourceVersion */ newVersion)
    }
    // Lazy specs: no-op here; stale tracking comes in Task 11.
  }
}
```

> **Note for the implementer:** the exact variable names (`record`, `newVersion`, `id`, `this.noydb`) depend on the `Collection.put` method internals. Read the existing method to confirm and adjust. The hook MUST run after `store.put` succeeds but before the method returns.

- [ ] **Step 3: Write the integration test**

```ts
// packages/hub/src/derivations/integration.test.ts

import { describe, expect, it } from 'vitest'
import { createNoydb } from '../noydb.js'
import { withDerivation } from './active.js'
import { memoryStore } from '@noy-db/to-memory' // uses the existing test store

describe('Derivation integration — eager mode end-to-end', () => {
  it('writes a derived record when the source is written', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: { id: 'tester', passphrase: 'test-pass-1234567890' },
      derivationStrategy: withDerivation({
        source: 'pdfs',
        deterministic: true,
        outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
        derive: (pdf: { id: string; pageCount: number }) => ({
          meta: { id: pdf.id, pageCount: pdf.pageCount },
        }),
        lifecycle: { mode: 'eager' },
      }),
    })

    const vault = await db.openVault('main')
    await vault.collection<{ id: string; pageCount: number }>('pdfs').put('doc1', { id: 'doc1', pageCount: 12 })

    const metaCol = vault.collection<{ id: string; pageCount: number; _derivedFrom?: unknown }>('pdf-meta')
    const meta = await metaCol.get('doc1')
    expect(meta).not.toBeNull()
    expect(meta?.pageCount).toBe(12)
    expect(meta?._derivedFrom).toBeDefined()
  })
})
```

> **Note:** if `createNoydb` requires more options (passphrase shape, vault setup), match the existing test patterns under `packages/hub/src/*.test.ts`.

- [ ] **Step 4: Run integration test, verify PASS**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/integration.test.ts
```

Expected: 1 test passes.

- [ ] **Step 5: Run the full hub test suite to verify no regression**

Run:
```bash
pnpm vitest run packages/hub
```

Expected: all hub tests pass (existing plus the new derivation tests).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/collection.ts packages/hub/src/noydb.ts packages/hub/src/derivations/integration.test.ts
git commit -m "feat(hub): hook DerivationExecutor into Collection.put for eager mode"
```

---

## Task 11: Lazy lifecycle + stale tracking

**Files:**
- Modify: `packages/hub/src/derivations/registry.ts` (add stale-bit Set + APIs)
- Modify: `packages/hub/src/collection.ts` (mark stale on lazy source-write; resolve on read)
- Modify: `packages/hub/src/derivations/integration.test.ts` (add lazy test)

- [ ] **Step 1: Add stale-tracking to the registry**

In `packages/hub/src/derivations/registry.ts`, add private state and APIs:

```ts
/** Set of "<sourceCollection>:<sourceId>" tokens marked stale (lazy mode). */
private readonly stale: Set<string> = new Set()

private static staleKey(source: string, sourceId: string): string {
  return `${source}:${sourceId}`
}

/** Mark a source-record's lazy derivations as stale (next read will re-derive). */
markStale(source: string, sourceId: string): void {
  this.stale.add(DerivationRegistry.staleKey(source, sourceId))
}

/** True if the source-record has any pending lazy re-derivation. */
isStale(source: string, sourceId: string): boolean {
  return this.stale.has(DerivationRegistry.staleKey(source, sourceId))
}

/** Clear stale flag after re-derivation. */
clearStale(source: string, sourceId: string): void {
  this.stale.delete(DerivationRegistry.staleKey(source, sourceId))
}

/**
 * Find which source produces records for a given output collection.
 * Used by Collection.get during stale-resolution: given a derived
 * collection name, find the source spec(s) that produce it.
 */
sourcesProducing(outputCollection: string): { spec: DerivationSpec; outputName: string }[] {
  const matches: { spec: DerivationSpec; outputName: string }[] = []
  for (const specs of this.bySource.values()) {
    for (const spec of specs) {
      for (const [name, output] of Object.entries(spec.outputs)) {
        if (output.collection === outputCollection) {
          matches.push({ spec, outputName: name })
        }
      }
    }
  }
  return matches
}
```

- [ ] **Step 2: Mark stale in `Collection.put` for lazy specs**

Extend the eager-mode hook from Task 10 to also handle lazy:

```ts
const lazySpecs = specs.filter((s) => s.lifecycle.mode === 'lazy')
for (const _ of lazySpecs) {
  registry.markStale(this.name, id)
}
```

- [ ] **Step 3: Add stale resolution at the start of `Collection.get`**

In `packages/hub/src/collection.ts`, locate `Collection.get(id)`. At the very start (before the existing cache lookup):

```ts
// Lazy-mode: if this collection is a derivation output and the source is
// stale, re-derive before the read returns.
const noydb = this.noydb
const registry = noydb.getDerivationRegistry()
if (!registry.isEmpty()) {
  const producers = registry.sourcesProducing(this.name)
  for (const { spec } of producers) {
    if (registry.isStale(spec.source, id)) {
      // Re-fetch the source record and run the derivation now.
      const sourceCol = this.vault.collection(spec.source)
      const sourceRecord = await sourceCol.get(id)
      if (sourceRecord !== null) {
        const sourceMeta = await sourceCol.getEnvelopeVersion(id) // existing internal API
        const executor = noydb.buildDerivationExecutor()
        await executor.runForSource(spec.source, id, sourceRecord, sourceMeta ?? 1)
      }
      registry.clearStale(spec.source, id)
    }
  }
}
```

> **Note:** `getEnvelopeVersion(id)` is illustrative — use whatever the existing collection API exposes for "current envelope version of record id." If no such API exists, derive it from the source's encrypted envelope `_v` field directly.

- [ ] **Step 4: Add lazy test to integration suite**

Append to `packages/hub/src/derivations/integration.test.ts`:

```ts
describe('Derivation integration — lazy mode end-to-end', () => {
  it('does not derive on source write, but derives on first read', async () => {
    let deriveCalls = 0
    const db = await createNoydb({
      store: memoryStore(),
      user: { id: 'tester', passphrase: 'test-pass-1234567890' },
      derivationStrategy: withDerivation({
        source: 'pdfs',
        deterministic: true,
        outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
        derive: (pdf: { id: string; pageCount: number }) => {
          deriveCalls++
          return { meta: { id: pdf.id, pageCount: pdf.pageCount } }
        },
        lifecycle: { mode: 'lazy' },
      }),
    })

    const vault = await db.openVault('main')
    await vault.collection<{ id: string; pageCount: number }>('pdfs').put('doc1', { id: 'doc1', pageCount: 5 })
    expect(deriveCalls).toBe(0) // lazy: not yet

    const meta = await vault.collection<{ pageCount: number }>('pdf-meta').get('doc1')
    expect(deriveCalls).toBe(1)
    expect(meta?.pageCount).toBe(5)

    // Second read: stale flag cleared, no extra derivation
    await vault.collection<{ pageCount: number }>('pdf-meta').get('doc1')
    expect(deriveCalls).toBe(1)

    // Re-write source: stale again
    await vault.collection<{ id: string; pageCount: number }>('pdfs').put('doc1', { id: 'doc1', pageCount: 8 })
    expect(deriveCalls).toBe(1) // still lazy, not yet

    const meta2 = await vault.collection<{ pageCount: number }>('pdf-meta').get('doc1')
    expect(deriveCalls).toBe(2)
    expect(meta2?.pageCount).toBe(8)
  })
})
```

- [ ] **Step 5: Run integration tests, verify PASS**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/integration.test.ts
```

Expected: both eager and lazy tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/derivations/registry.ts packages/hub/src/collection.ts packages/hub/src/derivations/integration.test.ts
git commit -m "feat(hub): add lazy derivation lifecycle with stale-bit tracking"
```

---

## Task 12: Strict mode + `withTransactions` rollback

**Files:**
- Modify: `packages/hub/src/derivations/executor.ts` (add `runForSourceStrict` that throws on first failure)
- Modify: `packages/hub/src/collection.ts` (in eager hook: choose strict vs non-strict per spec)
- Modify: `packages/hub/src/derivations/integration.test.ts` (add strict-mode rollback test)

- [ ] **Step 1: Add strict variant to executor**

Append to `packages/hub/src/derivations/executor.ts`:

```ts
/**
 * Strict variant: throws on first output failure rather than capturing.
 * Used by Collection.put when a spec has `strict: true`. Inside
 * `withTransactions`, the throw aborts the transaction.
 */
async runForSourceStrict(
  sourceCollection: string,
  sourceId: string,
  sourceRecord: unknown,
  sourceVersion: number,
): Promise<void> {
  const specs = this.registry.specsForSource(sourceCollection).filter((s) => s.strict === true)
  for (const spec of specs) {
    const result = await this.runOne(spec, sourceId, sourceRecord, sourceVersion)
    const failure = result.outputs.find((o) => !o.success)
    if (failure?.error) throw failure.error
  }
}
```

- [ ] **Step 2: Update the Collection.put hook to dispatch strict vs non-strict**

In `packages/hub/src/collection.ts`, replace the eager dispatch (from Task 10) with:

```ts
const eagerSpecs = specs.filter((s) => s.lifecycle.mode === 'eager')
if (eagerSpecs.length > 0) {
  const executor = noydb.buildDerivationExecutor()
  const strictSpecs = eagerSpecs.filter((s) => s.strict === true)
  const nonStrictSpecs = eagerSpecs.filter((s) => s.strict !== true)
  if (strictSpecs.length > 0) {
    // Throws on first failure → aborts caller (which is inside the source put;
    // if the put is inside a transaction, the transaction's revert pass cleans up).
    await executor.runForSourceStrict(this.name, id, record, newVersion)
  }
  if (nonStrictSpecs.length > 0) {
    await executor.runForSource(this.name, id, record, newVersion)
  }
}
```

- [ ] **Step 3: Write the strict-rollback test**

Append to `packages/hub/src/derivations/integration.test.ts`:

```ts
import { withTransactions } from '../tx/index.js'

describe('Derivation integration — strict-mode rollback', () => {
  it('rolls back source write when strict derivation fails inside a transaction', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: { id: 'tester', passphrase: 'test-pass-1234567890' },
      txStrategy: withTransactions(),
      derivationStrategy: withDerivation({
        source: 'orders',
        deterministic: true,
        outputs: { audit: { shape: 'record', collection: 'order-audit' } },
        // Force failure: derive() returns undefined for the only output
        derive: () => ({} as Record<string, unknown>),
        lifecycle: { mode: 'eager' },
        strict: true,
      }),
    })

    const vault = await db.openVault('main')

    let txnError: unknown = null
    try {
      await db.transaction(async (tx) => {
        await tx.collection('orders').put('o1', { id: 'o1', amount: 100 })
      })
    } catch (e) {
      txnError = e
    }
    expect(txnError).not.toBeNull()

    // Source write must have rolled back
    const order = await vault.collection('orders').get('o1')
    expect(order).toBeNull()
  })
})
```

- [ ] **Step 4: Run tests, verify PASS**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/integration.test.ts
```

Expected: all integration tests pass (eager, lazy, strict).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/derivations/executor.ts packages/hub/src/collection.ts packages/hub/src/derivations/integration.test.ts
git commit -m "feat(hub): add strict-mode derivation with withTransactions rollback"
```

---

## Task 13: Cascade depth bound

**Files:**
- Modify: `packages/hub/src/derivations/executor.ts` (track depth)
- Modify: `packages/hub/src/derivations/integration.test.ts` (add depth-exceeded test)

- [ ] **Step 1: Add depth tracking to the executor**

Modify `runForSource` and `runOne` in `packages/hub/src/derivations/executor.ts` to thread a depth counter:

```ts
async runForSource(
  sourceCollection: string,
  sourceId: string,
  sourceRecord: unknown,
  sourceVersion: number,
  depth = 0,
): Promise<DerivationResult[]> {
  const specs = this.registry.specsForSource(sourceCollection)
  const results: DerivationResult[] = []
  for (const spec of specs) {
    const maxDepth = spec.maxDepth ?? 5
    if (depth >= maxDepth) {
      const { DerivationDepthError } = await import('../errors.js')
      throw new DerivationDepthError(depth, [sourceCollection])
    }
    results.push(await this.runOne(spec, sourceId, sourceRecord, sourceVersion))
  }
  return results
}
```

> **Note:** the eager hook in Collection.put currently calls `runForSource` with no depth — that's depth 0. When derivation outputs *also* have derivations registered (chained), the recursive call should pass `depth + 1`. Since v1's `Collection.put` triggers derivation, and the executor's `target.put` calls back into `Collection.put`, the natural cascade increment happens via the recursive Collection-level call. To enforce a true bound, the executor must pass depth into the next put — done by exposing depth via the write target.

For v1, the simplest correct mechanism: track depth via a vault-scoped `currentDepth` counter on the registry, incremented on entry and decremented on exit. Add to registry.ts:

```ts
private currentDepth = 0

enterDerivation(): number { return ++this.currentDepth }
exitDerivation(): void { this.currentDepth = Math.max(0, this.currentDepth - 1) }
```

Then in Collection.put's eager hook, wrap the executor call:

```ts
const startedDepth = registry.enterDerivation()
try {
  // ... existing executor.runForSource calls
} finally {
  registry.exitDerivation()
}
```

And in the executor's `runOne`, before doing any output writes:

```ts
const max = spec.maxDepth ?? 5
const depthSnapshot = (this.registry as { currentDepth?: number }).currentDepth ?? 0
if (depthSnapshot > max) {
  throw new DerivationDepthError(depthSnapshot, [spec.source])
}
```

- [ ] **Step 2: Add the depth-exceeded test**

Append to `packages/hub/src/derivations/integration.test.ts`:

```ts
describe('Derivation integration — cascade depth bound', () => {
  it('throws DerivationDepthError when cascade exceeds maxDepth', async () => {
    // A → B → C → D → E → F (chain of 6 collections, default maxDepth=5)
    const chain = ['a', 'b', 'c', 'd', 'e', 'f']
    const specs = chain.slice(0, -1).map((src, i) => ({
      source: src,
      deterministic: true as const,
      outputs: { out: { shape: 'record' as const, collection: chain[i + 1] } },
      derive: (rec: { id: string }) => ({ out: { id: rec.id } }),
      lifecycle: { mode: 'eager' as const },
    }))

    const db = await createNoydb({
      store: memoryStore(),
      user: { id: 'tester', passphrase: 'test-pass-1234567890' },
      derivationStrategy: withDerivation(specs),
    })

    const vault = await db.openVault('main')

    let err: unknown = null
    try {
      await vault.collection<{ id: string }>('a').put('x', { id: 'x' })
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull()
    expect((err as Error).name).toBe('DerivationDepthError')
  })
})
```

- [ ] **Step 3: Run tests, verify PASS**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/integration.test.ts
```

Expected: depth test passes alongside existing tests.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/derivations/executor.ts packages/hub/src/derivations/registry.ts packages/hub/src/collection.ts packages/hub/src/derivations/integration.test.ts
git commit -m "feat(hub): enforce derivation cascade depth bound"
```

---

## Task 14: `vault.deriveAll(collection)` bulk recompute

**Files:**
- Modify: `packages/hub/src/vault.ts` (add `deriveAll` method)
- Modify: `packages/hub/src/derivations/integration.test.ts` (add bulk-recompute test)

- [ ] **Step 1: Add `deriveAll` to Vault**

In `packages/hub/src/vault.ts`, add the method:

```ts
/**
 * Re-derive every record in `outputCollection` from its current source.
 * Used after the strategy changes (different `derive` function, modified
 * outputs map) — the strategyHash on existing derived records won't match
 * the new strategy, so deriveAll() rebuilds them.
 *
 * @returns counts of derived/failed records.
 */
async deriveAll(outputCollection: string): Promise<{ derived: number; failed: number }> {
  const registry = this.noydb.getDerivationRegistry()
  if (registry.isEmpty()) return { derived: 0, failed: 0 }

  const producers = registry.sourcesProducing(outputCollection)
  if (producers.length === 0) {
    throw new Error(`vault.deriveAll: no derivation registered targeting collection '${outputCollection}'.`)
  }

  let derived = 0
  let failed = 0
  for (const { spec } of producers) {
    const sourceCol = this.collection(spec.source)
    const ids = await sourceCol.list()
    const executor = this.noydb.buildDerivationExecutor()
    for (const id of ids) {
      try {
        const record = await sourceCol.get(id)
        if (record === null) continue
        await executor.runForSource(spec.source, id, record, /* sourceVersion */ 1)
        derived++
      } catch {
        failed++
      }
    }
  }
  return { derived, failed }
}
```

- [ ] **Step 2: Write the bulk-recompute test**

Append to `packages/hub/src/derivations/integration.test.ts`:

```ts
describe('Derivation integration — vault.deriveAll', () => {
  it('re-derives all records in a collection', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: { id: 'tester', passphrase: 'test-pass-1234567890' },
      derivationStrategy: withDerivation({
        source: 'pdfs',
        deterministic: true,
        outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
        derive: (pdf: { id: string; pageCount: number }) => ({ meta: { pageCount: pdf.pageCount } }),
        lifecycle: { mode: 'lazy' },  // lazy → derive only on read OR on deriveAll
      }),
    })

    const vault = await db.openVault('main')
    await vault.collection('pdfs').put('a', { id: 'a', pageCount: 1 })
    await vault.collection('pdfs').put('b', { id: 'b', pageCount: 2 })
    await vault.collection('pdfs').put('c', { id: 'c', pageCount: 3 })

    const result = await vault.deriveAll('pdf-meta')
    expect(result.derived).toBe(3)
    expect(result.failed).toBe(0)

    expect((await vault.collection<{ pageCount: number }>('pdf-meta').get('a'))?.pageCount).toBe(1)
    expect((await vault.collection<{ pageCount: number }>('pdf-meta').get('b'))?.pageCount).toBe(2)
    expect((await vault.collection<{ pageCount: number }>('pdf-meta').get('c'))?.pageCount).toBe(3)
  })
})
```

- [ ] **Step 3: Run tests, verify PASS**

Run:
```bash
pnpm vitest run packages/hub/src/derivations/integration.test.ts
```

Expected: deriveAll test passes alongside existing tests.

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/vault.ts packages/hub/src/derivations/integration.test.ts
git commit -m "feat(hub): add vault.deriveAll() for bulk re-derivation"
```

---

## Task 15: End-to-end showcase

**Files:**
- Create: `showcases/src/70-with-derivation.showcase.test.ts`

- [ ] **Step 1: Write the showcase**

```ts
// showcases/src/70-with-derivation.showcase.test.ts

/**
 * Showcase 70: Derivation primitive (Dimension 14 v1)
 *
 * Demonstrates declaring a multi-output derivation: a "documents"
 * collection where each record produces a derived metadata record
 * (page count, word count) and a derived text record (extracted body).
 *
 * Verified with `to-memory` for hermetic tests; the same shape works
 * unchanged on `to-file` and any conformant store.
 */

import { describe, expect, it } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withDerivation } from '@noy-db/hub/derivations'
import { memoryStore } from '@noy-db/to-memory'

interface Document {
  id: string
  title: string
  body: string
}

interface DocumentMeta {
  title: string
  wordCount: number
}

interface DocumentText {
  body: string
}

describe('Showcase 70 — withDerivation', () => {
  it('derives metadata and text from a source document on write', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: { id: 'showcase-user', passphrase: 'showcase-passphrase-12345' },
      derivationStrategy: withDerivation({
        source: 'documents',
        deterministic: true,
        outputs: {
          meta: { shape: 'record', collection: 'document-meta' },
          text: { shape: 'record', collection: 'document-text' },
        },
        derive: (doc: Document) => ({
          meta: { title: doc.title, wordCount: doc.body.split(/\s+/).filter(Boolean).length },
          text: { body: doc.body.toLowerCase() },
        }),
        lifecycle: { mode: 'eager' },
      }),
    })

    const vault = await db.openVault('main')

    await vault.collection<Document>('documents').put('d1', {
      id: 'd1',
      title: 'Hello World',
      body: 'A quick brown fox jumps over the lazy dog.',
    })

    const meta = await vault.collection<DocumentMeta & { _derivedFrom?: unknown }>('document-meta').get('d1')
    expect(meta?.title).toBe('Hello World')
    expect(meta?.wordCount).toBe(9)
    expect(meta?._derivedFrom).toBeDefined()

    const text = await vault.collection<DocumentText>('document-text').get('d1')
    expect(text?.body).toBe('a quick brown fox jumps over the lazy dog.')
  })

  it('re-derives when the source is updated', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: { id: 'showcase-user', passphrase: 'showcase-passphrase-12345' },
      derivationStrategy: withDerivation({
        source: 'documents',
        deterministic: true,
        outputs: { meta: { shape: 'record', collection: 'document-meta' } },
        derive: (doc: Document) => ({ meta: { title: doc.title, wordCount: doc.body.split(/\s+/).length } }),
        lifecycle: { mode: 'eager' },
      }),
    })

    const vault = await db.openVault('main')
    const docs = vault.collection<Document>('documents')
    const meta = vault.collection<DocumentMeta>('document-meta')

    await docs.put('d1', { id: 'd1', title: 'V1', body: 'one two' })
    expect((await meta.get('d1'))?.wordCount).toBe(2)

    await docs.put('d1', { id: 'd1', title: 'V2', body: 'one two three four' })
    expect((await meta.get('d1'))?.wordCount).toBe(4)
    expect((await meta.get('d1'))?.title).toBe('V2')
  })
})
```

- [ ] **Step 2: Run the showcase**

Run:
```bash
pnpm vitest run showcases/src/70-with-derivation.showcase.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add showcases/src/70-with-derivation.showcase.test.ts
git commit -m "feat(showcases): add 70-with-derivation end-to-end showcase"
```

---

## Task 16: Subsystem documentation

**Files:**
- Create: `docs/subsystems/derivations.md`

- [ ] **Step 1: Write the subsystem doc**

```markdown
# Derivations (`@noy-db/hub/derivations`)

> Declare deterministic data derivations: a source record produces one
> or more typed outputs (other records) automatically maintained on
> source change. The derivation function runs *inside* the encrypted
> boundary — outputs preserve the zero-knowledge invariant.

## When to use it

Reach for derivations when:

- A record's *materialised projection* should auto-update on source change (computed metadata, denormalised view, full-text index, summarised digest)
- The source record can produce *multiple* derived shapes (one PDF → metadata + extracted text + thumbnail)
- The derivation is *deterministic* (re-running the function on the same input produces the same output)

Don't use derivations for:

- *Non-deterministic* outputs (LLM summaries, dynamic embedding models) — v1 only supports deterministic; non-deterministic deferred to v3
- *In-record* computed fields (use `withComputedFields`, the narrower primitive in `@noy-db/hub/aggregate`)
- *Cross-vault* derivations — v1 is vault-scoped

## How it works

```ts
import { createNoydb } from '@noy-db/hub'
import { withDerivation } from '@noy-db/hub/derivations'

const db = await createNoydb({
  store: ...,
  user: ...,
  derivationStrategy: withDerivation({
    source: 'pdfs',
    deterministic: true,
    outputs: {
      metadata: { shape: 'record', collection: 'pdf-metadata' },
      text:     { shape: 'record', collection: 'pdf-text' },
    },
    derive: (pdf) => ({
      metadata: { pageCount: pdf.pages.length, title: pdf.title },
      text:     { body: extractText(pdf) },
    }),
    lifecycle: { mode: 'eager' },  // or 'lazy'
  }),
})
```

When a record is written to `pdfs`, the strategy fires:
- **eager mode:** outputs are derived synchronously inside the same write
- **lazy mode:** outputs are marked stale; derivation runs on first read

## Lifecycle modes

| Mode | Source-write cost | First-read cost | Use case |
|---|---|---|---|
| `eager` | Pay per write | Free | Reads are frequent and predictable |
| `lazy` | Free | Pay per first read | Writes are frequent but reads are sparse |

## Strict mode + transactions

```ts
withDerivation({ ..., strict: true })
```

In strict mode, any output failure throws. Run the source `put` inside
`db.transaction(...)` to get rollback for free — the strict throw aborts
the transaction.

## Multi-output partial-failure

In non-strict mode, output failures are isolated: a 3-output derivation
where output #2 fails commits outputs #1 and #3, marks #2 with retry
metadata. Suits scenarios where some outputs are best-effort.

## Cycle detection

Derivation graphs are validated at vault open. `A → B → A` (or longer
cycles) throw `DerivationCycleError` and refuse to open the vault.

## Cascade depth

Default cascade depth is 5; configure per spec via `maxDepth`. Exceeding
the bound throws `DerivationDepthError`.

## Re-derivation after strategy change

Each derived record carries a `strategyHash` in its `_derivedFrom`
metadata. When you change the `derive` function or output map and want to
back-fill existing records, call:

```ts
await vault.deriveAll('pdf-metadata')
```

## Encryption boundary

The `derive` function runs *after* DEK unwrap on plaintext source data.
Outputs encrypt with the same DEK as the source. The `_derivedFrom`
metadata lives *inside* the encrypted payload (`_data`), not in the
unencrypted envelope — so a storage backend cannot infer the derivation
graph from listing.

## What's deferred (v2+)

- Cache-tier backends (`to-cache-*`) — v1.5
- Built-in derivers (`@noy-db/derivers-pdf`, etc.) — v2
- Materialized views (`withMaterializedView`) — v2
- Scheduled refresh — v2
- Non-deterministic derivations + persistence semantics — v3
- Public CDN derivations + signed-URL access — v3
```

- [ ] **Step 2: Commit**

```bash
git add docs/subsystems/derivations.md
git commit -m "docs(hub): add derivations subsystem doc"
```

---

## Task 17: `features.yaml` registry entry

**Files:**
- Modify: `features.yaml`

- [ ] **Step 1: Add a `derivations` registry entry**

In `features.yaml`, add an entry under the appropriate top-level section. Inspect the file to find the section that registers `withHistory`, `withTransactions`, etc., and follow the same shape:

```yaml
  - id: derivations
    name: Deterministic data derivations (v1 thin core)
    cluster: hub
    spec: SUBSYSTEMS.md#derivations
    subsystem_doc: docs/subsystems/derivations.md
    package: '@noy-db/hub'
    factory: withDerivation
    status: experimental
    showcases:
      - id: 70-with-derivation
        path: showcases/src/70-with-derivation.showcase.test.ts
    recipes: []
    playground_pages: []
    diagrams: []
    invariants:
      - 'derivation function runs after DEK unwrap, on plaintext source'
      - 'outputs encrypt with the same DEK as the source (zero-knowledge preserved)'
      - 'cycle detection at vault-open refuses cyclic derivation graphs'
      - 'cascade depth bounded (default 5; configurable per spec)'
      - 'strategyHash on _derivedFrom enables drift detection and re-derivation'
    related: [vault-and-collections, encryption, transactions, history]
```

- [ ] **Step 2: Add the spec anchor in `SUBSYSTEMS.md`**

Open `SUBSYSTEMS.md`, find a logical place near the existing `withHistory` / `withTransactions` sections, and add a short subsystem entry titled `Derivations`. The minimum:

```markdown
### Derivations

`@noy-db/hub/derivations` — `withDerivation()` strategy. Source records
produce one or more typed output records via a deterministic function.
Eager and lazy lifecycles. Strict-mode rollback inside `withTransactions`.
Outputs preserve zero-knowledge — derivation runs inside the encrypted
boundary, outputs use the same DEK.

See [docs/subsystems/derivations.md](./docs/subsystems/derivations.md).
```

- [ ] **Step 3: Validate the registry**

Run:
```bash
pnpm validate:features
```

Expected: validation passes (every cross-reference resolves on disk; the showcase id `70-with-derivation` matches the filename; the spec anchor exists in `SUBSYSTEMS.md`).

- [ ] **Step 4: Commit**

```bash
git add features.yaml SUBSYSTEMS.md
git commit -m "docs(features): register derivations subsystem in features.yaml"
```

---

## Task 18: Final integration sweep

**Files:** none new.

- [ ] **Step 1: Run the full hub test suite**

Run:
```bash
pnpm vitest run packages/hub
```

Expected: all tests pass (existing + new derivation tests).

- [ ] **Step 2: Run the showcase suite**

Run:
```bash
pnpm vitest run showcases
```

Expected: all showcases pass, including the new 70.

- [ ] **Step 3: Run typecheck and build across the monorepo**

Run:
```bash
pnpm turbo typecheck
pnpm turbo build
```

Expected: both pass.

- [ ] **Step 4: Run lint**

Run:
```bash
pnpm turbo lint
```

Expected: pass.

- [ ] **Step 5: Confirm bundle-size impact**

If a bundle-size CI gate exists (`bundle-manifest.json`), inspect:
```bash
cat bundle-manifest.json | jq '.["@noy-db/hub"]'
```

Verify the floor for the default hub bundle hasn't grown — derivation code is gated behind the subpath import, so the default bundle should be unchanged. If the floor grew, the `derivations/` import is leaking into the default bundle (likely a side-effect import in `index.ts`); fix and re-verify.

- [ ] **Step 6: Final commit (if any cleanup needed)**

If lint/typecheck surfaced fixes, commit them with:
```bash
git commit -am "chore(hub): fix lint/typecheck issues from derivation integration"
```

If no fixes are needed, the previous task's commit is the terminal state.

---

## Self-review checklist (run before declaring complete)

- [ ] Every spec section has at least one task implementing it
- [ ] No "TBD" / "TODO" / "implement later" / "appropriate error handling" placeholder phrases anywhere in the plan
- [ ] Method signatures (`runForSource`, `runForSourceStrict`, `markStale`, `clearStale`, `sourcesProducing`, `deriveAll`) used in later tasks match what was defined in earlier tasks
- [ ] Type names (`DerivationStrategy`, `DerivationSpec`, `DerivedFromMeta`, `OutputSpec`, `DerivationLifecycle`) used consistently — single canonical location at `packages/hub/src/derivations/types.ts`
- [ ] Every code step shows the actual code (no "similar to Task N" without repeating)
- [ ] Every test step shows the assertion + expected outcome
- [ ] All commit messages follow `feat(hub): ...` / `test(hub): ...` / `docs(...): ...` convention
- [ ] Cycle detection covers self-loop, 2-cycle, 3-cycle, branching DAG (Task 5)
- [ ] Eager and lazy lifecycles both have integration tests (Task 10 + Task 11)
- [ ] Strict-mode rollback verified inside a transaction (Task 12)
- [ ] Cascade depth bound verified (Task 13)
- [ ] Bulk re-derivation verified (Task 14)
- [ ] Encryption boundary documented (subsystem doc + spec)
- [ ] `features.yaml` entry registered, validation runs (Task 17)
- [ ] Bundle-size impact verified (Task 18 step 5)

## Open implementation questions (decide during execution, document in code comments)

1. **Lazy stale-tracking persistence** — v1 keeps stale bits in-memory; this means a vault re-open resets stale state and reads-after-reopen will spuriously re-derive once. Acceptable for v1. **Decision:** in-memory only, doc'd as a known limitation; persist in v2.
2. **Output type validation at runtime** — v1 trusts the `derive` function. **Decision:** v1 trust + doc; Zod-style runtime validators in v2.
3. **`deriveAll` concurrency** — sequential for simplicity. **Decision:** sequential v1; parallel-with-cap in v2 once metering reveals workload shape.
4. **Cascade-depth tracking implementation** — Task 13 uses a vault-scoped counter; thread-safety in JS is not a concern (single-threaded), but ensure exception paths still decrement (the `try/finally` in Collection.put covers this).
5. **Vault-init failure recovery** — fail-fast: cycle / unknown-output errors abort `createNoydb`. **Decision:** fail-fast; partial-init fallback is not in v1.
