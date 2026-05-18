# Derivation (Dim 14 v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `withDerivation` in `@noy-db/hub` — a vault-level strategy that declares deterministic data derivations of one or more typed outputs from a source record, with eager / lazy lifecycle, automatic invalidation on source change, and atomic rollback inside `withTransactions`.

**Architecture:** A new `DerivationRegistry` holds the strategy graph (source → outputs[]). `Collection.put` invokes `DerivationRegistry.onSourceWrite` AFTER store.put succeeds. The `DerivationExecutor` runs the user's `derive` function on plaintext, validates outputs, and writes each output via the same `Collection.put` path (under the same DEK by default). Cycle detection at registration time prevents infinite recursion.

**Tech Stack:** TypeScript, Web Crypto API, Vitest. No new dependencies. Lives in `packages/hub` + showcase + doc + features.yaml.

**Spec:** `docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md`

**Issue covered:** #129 (epic).

## Subsystem positioning (tree-shakable subpath export)

`@noy-db/hub` ships subsystem-scoped subpath exports for tree-shaking — `@noy-db/hub/periods`, `@noy-db/hub/tx`, `@noy-db/hub/history`, etc. Each subsystem lives under `packages/hub/src/<name>/`, has its own `index.ts` barrel, and is wired into both `tsup.config.ts` ENTRIES and `package.json` `exports`.

**Derivations is a new subsystem in the `write-and-mutate` cluster**, parallel to `transactions` (the existing source-write-cascade primitive). Exposed as `@noy-db/hub/derivations`. Importable as:

```ts
import { withDerivation } from '@noy-db/hub'              // main barrel (re-export)
import { withDerivation } from '@noy-db/hub/derivations'  // tree-shakable subpath
```

The `features.yaml` entry uses `package: '@noy-db/hub/derivations'` and `cluster: write-and-mutate`.

---

## File Structure

**New files:**
- `packages/hub/src/derivations/with-derivation.ts` — public `withDerivation()` factory + types
- `packages/hub/src/derivations/types.ts` — `DerivationStrategy<TSource, TOutputs>`, `OutputSpec`, `DerivedFromMeta`
- `packages/hub/src/derivations/registry.ts` — `DerivationRegistry` (registration, cycle detection, dispatch)
- `packages/hub/src/derivations/executor.ts` — `DerivationExecutor` (run, validate, write outputs)
- `packages/hub/src/derivations/strategy-hash.ts` — deterministic hash for strategy drift detection
- `packages/hub/src/derivations/stale.ts` — lazy-mode stale-bit tracking
- `packages/hub/src/derivations/index.ts` — barrel exports
- `packages/hub/__tests__/derivations/registry.test.ts` — registry unit tests
- `packages/hub/__tests__/derivations/executor.test.ts` — executor unit tests
- `packages/hub/__tests__/derivations/strategy-hash.test.ts` — hash determinism tests
- `packages/hub/__tests__/derivations/eager.test.ts` — eager lifecycle integration
- `packages/hub/__tests__/derivations/lazy.test.ts` — lazy lifecycle integration
- `packages/hub/__tests__/derivations/cycle.test.ts` — cycle detection
- `packages/hub/__tests__/derivations/strict-tx.test.ts` — `withTransactions` strict-mode rollback
- `showcases/src/70-with-derivation.showcase.test.ts` — end-to-end PDF derivation showcase
- `docs/subsystems/derivations.md` — subsystem reference doc

**Modified files:**
- `packages/hub/src/errors.ts` — add `DerivationCycleError`, `DerivationDepthError`, `DerivationOutputUnknownError`, `DerivationOutputShapeError`
- `packages/hub/src/index.ts` — export `withDerivation` + types + errors
- `packages/hub/src/collection.ts` — invoke `DerivationRegistry.onSourceWrite` AFTER store.put, AFTER ledger append; add lazy stale-check on `get`
- `packages/hub/src/vault.ts` — own a `DerivationRegistry`; accept `derivationStrategies`; expose `_getDerivationRegistry()`; add `deriveAll(name)` method
- `packages/hub/src/noydb.ts` — forward derivation strategies
- `packages/hub/tsup.config.ts` — add `'derivations/index': 'src/derivations/index.ts'` to ENTRIES (NEW subsystem build entry)
- `packages/hub/package.json` — add `"./derivations": { ... }` to `exports` (NEW subpath)
- `features.yaml` — add `derivations` section under `cluster: write-and-mutate`

---

## Task 1: Error types

**Files:**
- Modify: `packages/hub/src/errors.ts`
- Test: `packages/hub/__tests__/derivations/errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  NoydbError,
  DerivationCycleError,
  DerivationDepthError,
  DerivationOutputUnknownError,
  DerivationOutputShapeError,
} from '../../src/errors.js'

describe('derivation errors', () => {
  it('DerivationCycleError lists the cycle path', () => {
    const e = new DerivationCycleError(['a', 'b', 'c', 'a'])
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('DERIVATION_CYCLE')
    expect(e.path).toEqual(['a', 'b', 'c', 'a'])
    expect(e.message).toContain('a → b → c → a')
  })

  it('DerivationDepthError reports limit + current depth', () => {
    const e = new DerivationDepthError(5, 7)
    expect(e.code).toBe('DERIVATION_DEPTH')
    expect(e.limit).toBe(5)
    expect(e.attempted).toBe(7)
  })

  it('DerivationOutputUnknownError names the missing output collection', () => {
    const e = new DerivationOutputUnknownError('pdf-text-NOT-REGISTERED')
    expect(e.code).toBe('DERIVATION_OUTPUT_UNKNOWN')
    expect(e.collection).toBe('pdf-text-NOT-REGISTERED')
  })

  it('DerivationOutputShapeError names the offending output key', () => {
    const e = new DerivationOutputShapeError('metadata', 'expected object, got string')
    expect(e.code).toBe('DERIVATION_OUTPUT_SHAPE')
    expect(e.outputKey).toBe('metadata')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/errors.test.ts`
Expected: FAIL — error classes not yet defined

- [ ] **Step 3: Add the four error classes**

Append to `packages/hub/src/errors.ts`:

```typescript
/**
 * Thrown at vault open if the derivation graph contains a cycle.
 * `path` is the offending chain (e.g. `['a', 'b', 'c', 'a']`).
 */
export class DerivationCycleError extends NoydbError {
  readonly path: readonly string[]

  constructor(path: readonly string[]) {
    super(
      'DERIVATION_CYCLE',
      `Derivation graph contains a cycle: ${path.join(' → ')}. ` +
        `Refusing to open vault — break the cycle before retrying.`,
    )
    this.name = 'DerivationCycleError'
    this.path = path
  }
}

/**
 * Thrown when a cascade of source → output → source → … exceeds the
 * configured `maxDepth` (default 5).
 */
export class DerivationDepthError extends NoydbError {
  readonly limit: number
  readonly attempted: number

  constructor(limit: number, attempted: number) {
    super(
      'DERIVATION_DEPTH',
      `Derivation cascade exceeded max depth ${limit} (attempted ${attempted}). ` +
        `Pass lifecycle: { maxDepth: N } to raise the limit if intentional.`,
    )
    this.name = 'DerivationDepthError'
    this.limit = limit
    this.attempted = attempted
  }
}

/**
 * Thrown at registration if a `withDerivation` strategy references an
 * output `collection` that isn't otherwise declared (no schema, no use
 * elsewhere). Surfacing this early catches typos in collection names.
 */
export class DerivationOutputUnknownError extends NoydbError {
  readonly collection: string

  constructor(collection: string) {
    super(
      'DERIVATION_OUTPUT_UNKNOWN',
      `Derivation output collection "${collection}" is not declared on the vault. ` +
        `Register the collection (e.g. via schema) before registering a derivation that writes to it.`,
    )
    this.name = 'DerivationOutputUnknownError'
    this.collection = collection
  }
}

/**
 * Thrown when the user's `derive` function returns a value that doesn't
 * match the declared output spec (e.g. wrong shape, wrong key set).
 */
export class DerivationOutputShapeError extends NoydbError {
  readonly outputKey: string

  constructor(outputKey: string, detail: string) {
    super(
      'DERIVATION_OUTPUT_SHAPE',
      `Derivation output "${outputKey}" has invalid shape: ${detail}.`,
    )
    this.name = 'DerivationOutputShapeError'
    this.outputKey = outputKey
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/hub/__tests__/derivations/errors.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/errors.ts packages/hub/__tests__/derivations/errors.test.ts
git commit -m "feat(hub): add derivation error types (#129)"
```

---

## Task 2: `DerivedFromMeta` envelope extension

**Files:**
- Create: `packages/hub/src/derivations/types.ts`
- Test: `packages/hub/__tests__/derivations/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import type { DerivedFromMeta, DerivationStrategy, OutputSpec } from '../../src/derivations/types.js'

describe('Derivation types', () => {
  it('DerivedFromMeta has the documented fields', () => {
    const meta: DerivedFromMeta = {
      source: 'pdfs',
      sourceId: 'abc',
      sourceVersion: 3,
      derivedAt: '2026-05-18T00:00:00.000Z',
      strategyHash: 'sha256-…',
    }
    expect(meta.source).toBe('pdfs')
    expect(meta.strategyHash).toBe('sha256-…')
  })

  it('DerivationStrategy carries source, outputs map, derive, lifecycle', () => {
    const strategy: DerivationStrategy<{ body: string }, { meta: { len: number } }> = {
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    }
    expect(strategy.source).toBe('pdfs')
    expect(strategy.outputs.meta.collection).toBe('pdf-meta')
  })

  it('OutputSpec has shape and collection', () => {
    const spec: OutputSpec = { shape: 'record', collection: 'pdf-meta' }
    expect(spec.shape).toBe('record')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `types.ts`**

Create `packages/hub/src/derivations/types.ts`:

```typescript
/**
 * Metadata that travels inside the `_data` payload of a derived record.
 * Lives in encrypted payload, not in the unencrypted envelope — the
 * storage backend cannot infer the derivation graph from listing.
 */
export interface DerivedFromMeta {
  /** Source collection name. */
  readonly source: string
  /** Source record id. */
  readonly sourceId: string
  /** `_v` of the source at derivation time. */
  readonly sourceVersion: number
  /** ISO timestamp when this output was derived. */
  readonly derivedAt: string
  /**
   * SHA-256 of (source + outputs map keys + derive function source).
   * Changes when the strategy changes → forces `vault.deriveAll` to
   * recompute on next visit.
   */
  readonly strategyHash: string
}

/** Per-output declaration. v1: only `'record'` shape. */
export interface OutputSpec {
  shape: 'record'
  collection: string
}

/**
 * Registration shape passed to `withDerivation()`.
 *
 * @typeParam TSource - the source record type
 * @typeParam TOutputs - map of output-key → output record type
 */
export interface DerivationStrategy<
  TSource extends Record<string, unknown>,
  TOutputs extends Record<string, Record<string, unknown>>,
> {
  /** Source collection name. */
  source: string
  /** v1: only deterministic derivations supported. */
  deterministic: true
  /**
   * Output declarations keyed by name. The `derive` function's return
   * value must have the same keys.
   */
  outputs: { [K in keyof TOutputs]: OutputSpec }
  /**
   * Pure function from source to outputs. Runs on plaintext, after DEK
   * unwrap. Returns a map of named outputs. Each output is encrypted +
   * stored via the existing `Collection.put` pipeline.
   */
  derive: (source: TSource) => Promise<TOutputs> | TOutputs
  /**
   * `'eager'` runs `derive` synchronously inside the source-write
   * transaction. `'lazy'` marks outputs stale on source-change and
   * derives on first read.
   */
  lifecycle: 'eager' | 'lazy' | { mode: 'eager' | 'lazy'; maxDepth?: number }
  /**
   * `true` = any output failure rolls back the source write (only with
   * `withTransactions`). `false` = isolate per-output failure, log,
   * continue. Default `false`.
   */
  strict?: boolean
}

/** Returned by `withDerivation()` and consumed by `createNoydb`. */
export interface DerivationStrategyHandle {
  readonly __noydb_strategy: 'derivation'
  readonly spec: DerivationStrategy<any, any>
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/hub/__tests__/derivations/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/derivations/types.ts packages/hub/__tests__/derivations/types.test.ts
git commit -m "feat(hub): derivation type surface — DerivationStrategy, OutputSpec, DerivedFromMeta (#129)"
```

---

## Task 3: `strategyHash` — deterministic hash for drift detection

**Files:**
- Create: `packages/hub/src/derivations/strategy-hash.ts`
- Test: `packages/hub/__tests__/derivations/strategy-hash.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/strategy-hash.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { computeStrategyHash } from '../../src/derivations/strategy-hash.js'

describe('computeStrategyHash', () => {
  it('returns identical hash for identical inputs', async () => {
    const fn = (s: { x: number }) => ({ out: { y: s.x + 1 } })
    const h1 = await computeStrategyHash('src', ['out'], fn)
    const h2 = await computeStrategyHash('src', ['out'], fn)
    expect(h1).toBe(h2)
  })

  it('changes when source name changes', async () => {
    const fn = (s: { x: number }) => ({ out: { y: s.x } })
    const a = await computeStrategyHash('src-a', ['out'], fn)
    const b = await computeStrategyHash('src-b', ['out'], fn)
    expect(a).not.toBe(b)
  })

  it('changes when output keys change', async () => {
    const fn = (_s: any) => ({} as any)
    const a = await computeStrategyHash('src', ['out1'], fn)
    const b = await computeStrategyHash('src', ['out1', 'out2'], fn)
    expect(a).not.toBe(b)
  })

  it('changes when derive function body changes', async () => {
    const a = await computeStrategyHash('src', ['out'], (s: any) => ({ out: { y: s.x + 1 } }))
    const b = await computeStrategyHash('src', ['out'], (s: any) => ({ out: { y: s.x + 2 } }))
    expect(a).not.toBe(b)
  })

  it('returns a hex string', async () => {
    const h = await computeStrategyHash('s', ['o'], () => ({ o: {} } as any))
    expect(h).toMatch(/^[0-9a-f]+$/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/strategy-hash.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `computeStrategyHash`**

Create `packages/hub/src/derivations/strategy-hash.ts`:

```typescript
/**
 * Deterministic hash of a derivation strategy's "shape": source
 * collection, output keys, derive function source. Used to detect
 * strategy drift: a record whose `_derivedFrom.strategyHash` doesn't
 * match the current strategy is considered stale.
 *
 * Web Crypto SHA-256 — no extra deps.
 */
export async function computeStrategyHash(
  source: string,
  outputKeys: readonly string[],
  derive: (...args: any[]) => any,
): Promise<string> {
  const canonical = JSON.stringify({
    source,
    outputs: [...outputKeys].sort(),
    derive: derive.toString(),
  })
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/hub/__tests__/derivations/strategy-hash.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/derivations/strategy-hash.ts packages/hub/__tests__/derivations/strategy-hash.test.ts
git commit -m "feat(hub): computeStrategyHash for derivation drift detection (#129)"
```

---

## Task 4: `withDerivation()` factory

**Files:**
- Create: `packages/hub/src/derivations/with-derivation.ts`
- Test: `packages/hub/__tests__/derivations/with-derivation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/with-derivation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { withDerivation } from '../../src/derivations/with-derivation.js'

describe('withDerivation factory', () => {
  it('returns a handle with __noydb_strategy: "derivation"', () => {
    const h = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s: { body: string }) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    })
    expect(h.__noydb_strategy).toBe('derivation')
    expect(h.spec.source).toBe('pdfs')
  })

  it('rejects missing source', () => {
    expect(() =>
      withDerivation({
        source: '',
        deterministic: true,
        outputs: { o: { shape: 'record', collection: 'x' } },
        derive: () => ({ o: {} } as any),
        lifecycle: 'eager',
      } as any),
    ).toThrow(/source/i)
  })

  it('rejects empty outputs map', () => {
    expect(() =>
      withDerivation({
        source: 's',
        deterministic: true,
        outputs: {},
        derive: () => ({} as any),
        lifecycle: 'eager',
      } as any),
    ).toThrow(/outputs/i)
  })

  it('rejects non-deterministic spec in v1', () => {
    expect(() =>
      withDerivation({
        source: 's',
        deterministic: false as unknown as true,
        outputs: { o: { shape: 'record', collection: 'x' } },
        derive: () => ({ o: {} } as any),
        lifecycle: 'eager',
      } as any),
    ).toThrow(/deterministic/i)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/with-derivation.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `withDerivation()`**

Create `packages/hub/src/derivations/with-derivation.ts`:

```typescript
import { ValidationError } from '../errors.js'
import type { DerivationStrategy, DerivationStrategyHandle } from './types.js'

/**
 * Register a deterministic derivation: one source collection → one or
 * more typed outputs, computed by the user's `derive` function on
 * plaintext after DEK unwrap. Outputs are encrypted with the same DEK
 * as the source and written via the standard `Collection.put` path.
 *
 * See docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md.
 */
export function withDerivation<
  TSource extends Record<string, unknown>,
  TOutputs extends Record<string, Record<string, unknown>>,
>(spec: DerivationStrategy<TSource, TOutputs>): DerivationStrategyHandle {
  if (!spec.source || spec.source.length === 0) {
    throw new ValidationError('withDerivation: source collection name is required')
  }
  if (!spec.outputs || Object.keys(spec.outputs).length === 0) {
    throw new ValidationError('withDerivation: at least one output must be declared')
  }
  if (spec.deterministic !== true) {
    throw new ValidationError('withDerivation: v1 only supports deterministic derivations')
  }
  if (typeof spec.derive !== 'function') {
    throw new ValidationError('withDerivation: derive must be a function')
  }
  return {
    __noydb_strategy: 'derivation',
    spec: spec as DerivationStrategy<any, any>,
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/hub/__tests__/derivations/with-derivation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/derivations/with-derivation.ts packages/hub/__tests__/derivations/with-derivation.test.ts
git commit -m "feat(hub): withDerivation() factory (#129)"
```

---

## Task 5: `DerivationRegistry` — registration + cycle detection

**Files:**
- Create: `packages/hub/src/derivations/registry.ts`
- Test: `packages/hub/__tests__/derivations/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { DerivationRegistry } from '../../src/derivations/registry.js'
import { withDerivation } from '../../src/derivations/with-derivation.js'
import { DerivationCycleError } from '../../src/errors.js'

describe('DerivationRegistry', () => {
  it('register + lookup by source', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => ({ meta: {} }),
      lifecycle: 'eager',
    }).spec)
    expect(reg.strategiesForSource('pdfs')).toHaveLength(1)
    expect(reg.strategiesForSource('nope')).toHaveLength(0)
  })

  it('reverse lookup — output collection → source strategies', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => ({ meta: {} }),
      lifecycle: 'eager',
    }).spec)
    expect(reg.strategiesProducingOutput('pdf-meta')).toHaveLength(1)
  })

  it('detects self-cycle at register-and-validate', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'a' } }, // a → a
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    expect(() => reg.validate()).toThrow(DerivationCycleError)
  })

  it('detects A → B → A cycle', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    await reg.register(withDerivation({
      source: 'b',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'a' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    expect(() => reg.validate()).toThrow(DerivationCycleError)
  })

  it('accepts an acyclic graph', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    await reg.register(withDerivation({
      source: 'b',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'c' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    expect(() => reg.validate()).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `DerivationRegistry`**

Create `packages/hub/src/derivations/registry.ts`:

```typescript
import { DerivationCycleError } from '../errors.js'
import { computeStrategyHash } from './strategy-hash.js'
import type { DerivationStrategy } from './types.js'

interface RegisteredStrategy {
  spec: DerivationStrategy<any, any>
  strategyHash: string
}

/**
 * Vault-internal registry of derivation strategies. Owned by `Vault`;
 * not exported.
 *
 * @internal
 */
export class DerivationRegistry {
  private readonly _bySource = new Map<string, RegisteredStrategy[]>()
  private readonly _byOutput = new Map<string, RegisteredStrategy[]>()

  async register(spec: DerivationStrategy<any, any>): Promise<void> {
    const outputKeys = Object.keys(spec.outputs)
    const strategyHash = await computeStrategyHash(spec.source, outputKeys, spec.derive)
    const reg: RegisteredStrategy = { spec, strategyHash }

    const fromSource = this._bySource.get(spec.source)
    if (fromSource) fromSource.push(reg)
    else this._bySource.set(spec.source, [reg])

    for (const key of outputKeys) {
      const outputCollection = spec.outputs[key].collection
      const arr = this._byOutput.get(outputCollection)
      if (arr) arr.push(reg)
      else this._byOutput.set(outputCollection, [reg])
    }
  }

  strategiesForSource(source: string): ReadonlyArray<RegisteredStrategy> {
    return this._bySource.get(source) ?? []
  }

  strategiesProducingOutput(collection: string): ReadonlyArray<RegisteredStrategy> {
    return this._byOutput.get(collection) ?? []
  }

  /**
   * Tarjan-style cycle detection over the source → output → … graph.
   * Call after all `register()` calls complete (i.e. at vault open).
   * Throws `DerivationCycleError` on the first cycle found.
   */
  validate(): void {
    const visited = new Set<string>()
    const stack: string[] = []

    const visit = (node: string): void => {
      if (stack.includes(node)) {
        const cycle = stack.slice(stack.indexOf(node)).concat(node)
        throw new DerivationCycleError(cycle)
      }
      if (visited.has(node)) return
      stack.push(node)
      const strategies = this._bySource.get(node)
      if (strategies) {
        for (const s of strategies) {
          for (const key of Object.keys(s.spec.outputs)) {
            visit(s.spec.outputs[key].collection)
          }
        }
      }
      stack.pop()
      visited.add(node)
    }

    for (const src of this._bySource.keys()) visit(src)
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/hub/__tests__/derivations/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/derivations/registry.ts packages/hub/__tests__/derivations/registry.test.ts
git commit -m "feat(hub): DerivationRegistry — registration + cycle detection (#129)"
```

---

## Task 6: `DerivationExecutor` — eager mode, single + multi output

**Files:**
- Create: `packages/hub/src/derivations/executor.ts`
- Test: `packages/hub/__tests__/derivations/executor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/executor.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { DerivationExecutor } from '../../src/derivations/executor.js'
import { withDerivation } from '../../src/derivations/with-derivation.js'
import { DerivationOutputShapeError } from '../../src/errors.js'

interface Source { id: string; body: string }
interface Meta { len: number }
interface Text { content: string }

describe('DerivationExecutor.run', () => {
  it('runs derive, returns per-output success/failure', async () => {
    const strategy = withDerivation<Source, { meta: Meta; text: Text }>({
      source: 'pdfs',
      deterministic: true,
      outputs: {
        meta: { shape: 'record', collection: 'pdf-meta' },
        text: { shape: 'record', collection: 'pdf-text' },
      },
      derive: (s) => ({ meta: { len: s.body.length }, text: { content: s.body.toUpperCase() } }),
      lifecycle: 'eager',
    }).spec
    const result = await DerivationExecutor.run(strategy, { id: 'p1', body: 'hi' }, 1, 'hash')
    expect(result.outputs).toEqual({
      meta: { value: { len: 2 }, ok: true },
      text: { value: { content: 'HI' }, ok: true },
    })
  })

  it('captures per-output exceptions in non-strict mode', async () => {
    const strategy = withDerivation<Source, { good: Meta; bad: Meta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: {
        good: { shape: 'record', collection: 'g' },
        bad: { shape: 'record', collection: 'b' },
      },
      derive: () => { throw new Error('boom') },
      lifecycle: 'eager',
    }).spec
    const result = await DerivationExecutor.run(strategy, { id: 'p1', body: '' }, 1, 'hash')
    expect(result.failed).toBe(true)
    expect(result.outputs.good.ok).toBe(false)
  })

  it('throws DerivationOutputShapeError when derive returns missing keys', async () => {
    const strategy = withDerivation<Source, { meta: Meta; text: Text }>({
      source: 'pdfs',
      deterministic: true,
      outputs: {
        meta: { shape: 'record', collection: 'pdf-meta' },
        text: { shape: 'record', collection: 'pdf-text' },
      },
      // missing 'text' in the returned object
      derive: ((s: Source) => ({ meta: { len: s.body.length } })) as any,
      lifecycle: 'eager',
    }).spec
    await expect(
      DerivationExecutor.run(strategy, { id: 'p1', body: 'x' }, 1, 'h'),
    ).rejects.toBeInstanceOf(DerivationOutputShapeError)
  })

  it('stamps _derivedFrom onto every output', async () => {
    const strategy = withDerivation<Source, { meta: Meta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    }).spec
    const result = await DerivationExecutor.run(strategy, { id: 'p1', body: 'hi' }, 3, 'STRAT')
    const out = result.outputs.meta.value as Meta & { _derivedFrom: any }
    expect(out._derivedFrom.source).toBe('pdfs')
    expect(out._derivedFrom.sourceId).toBe('p1')
    expect(out._derivedFrom.sourceVersion).toBe(3)
    expect(out._derivedFrom.strategyHash).toBe('STRAT')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/executor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `DerivationExecutor`**

Create `packages/hub/src/derivations/executor.ts`:

```typescript
import { DerivationOutputShapeError } from '../errors.js'
import type { DerivationStrategy, DerivedFromMeta } from './types.js'

export interface RunResult {
  outputs: Record<string, OutputResult>
  failed: boolean
}

export interface OutputResult {
  value: Record<string, unknown>
  ok: boolean
  error?: Error
}

/**
 * Stateless functions that execute a derivation strategy. Persistence
 * (encrypt + store.put) is the caller's job — typically
 * `DerivationRegistry.onSourceWrite` which iterates run() results and
 * writes each output via `Collection.put`.
 */
export const DerivationExecutor = {
  /**
   * Run `derive` once, validate output shape against the spec, stamp
   * `_derivedFrom` onto every output. Returns per-output success or
   * failure; throws only for shape mismatches (a contract violation).
   */
  async run<TSource extends Record<string, unknown>, TOutputs extends Record<string, Record<string, unknown>>>(
    strategy: DerivationStrategy<TSource, TOutputs>,
    source: TSource & { id: string },
    sourceVersion: number,
    strategyHash: string,
  ): Promise<RunResult> {
    const outputs: Record<string, OutputResult> = {}
    let derived: Partial<TOutputs>
    let failed = false

    try {
      derived = await Promise.resolve(strategy.derive(source as TSource))
    } catch (err) {
      for (const key of Object.keys(strategy.outputs)) {
        outputs[key] = {
          value: {},
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        }
      }
      return { outputs, failed: true }
    }

    const meta: DerivedFromMeta = {
      source: strategy.source,
      sourceId: source.id,
      sourceVersion,
      derivedAt: new Date().toISOString(),
      strategyHash,
    }

    for (const key of Object.keys(strategy.outputs)) {
      const value = (derived as Record<string, unknown>)[key]
      if (value === undefined || value === null || typeof value !== 'object') {
        throw new DerivationOutputShapeError(
          key,
          `expected object, got ${value === undefined ? 'undefined' : typeof value}`,
        )
      }
      outputs[key] = {
        value: { ...(value as Record<string, unknown>), _derivedFrom: meta },
        ok: true,
      }
    }
    return { outputs, failed }
  },
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/hub/__tests__/derivations/executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/derivations/executor.ts packages/hub/__tests__/derivations/executor.test.ts
git commit -m "feat(hub): DerivationExecutor — run + multi-output dispatch + shape validation (#129)"
```

---

## Task 7: Barrel + hub exports

**Files:**
- Create: `packages/hub/src/derivations/index.ts`
- Modify: `packages/hub/src/index.ts`

- [ ] **Step 1: Create barrel**

Create `packages/hub/src/derivations/index.ts`:

```typescript
export { withDerivation } from './with-derivation.js'
export { DerivationRegistry } from './registry.js'
export { DerivationExecutor } from './executor.js'
export type {
  DerivationStrategy,
  DerivationStrategyHandle,
  DerivedFromMeta,
  OutputSpec,
} from './types.js'
```

- [ ] **Step 2: Add to hub index**

In `packages/hub/src/index.ts`, add:

```typescript
// Derivations (Dim 14) — see docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md
export { withDerivation } from './derivations/index.js'
export type {
  DerivationStrategy,
  DerivationStrategyHandle,
  DerivedFromMeta,
  OutputSpec,
} from './derivations/index.js'

export {
  DerivationCycleError,
  DerivationDepthError,
  DerivationOutputUnknownError,
  DerivationOutputShapeError,
} from './errors.js'
```

- [ ] **Step 3: Build**

Run: `pnpm turbo build --filter=@noy-db/hub`
Expected: green

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/derivations/index.ts packages/hub/src/index.ts
git commit -m "feat(hub): export withDerivation + derivation types + errors (#129)"
```

---

## Task 7b: Register `derivations` as a subsystem subpath (tree-shakable)

**Files:**
- Modify: `packages/hub/tsup.config.ts`
- Modify: `packages/hub/package.json`
- Modify: `packages/hub/src/derivations/index.ts` (re-export errors for self-contained subpath)
- Test: `packages/hub/__tests__/derivations/subpath-export.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/subpath-export.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'

describe('@noy-db/hub/derivations subpath', () => {
  it('exposes withDerivation + error classes via subpath import', async () => {
    const mod = await import('@noy-db/hub/derivations')
    expect(typeof mod.withDerivation).toBe('function')
    expect(typeof mod.DerivationCycleError).toBe('function')
    expect(typeof mod.DerivationDepthError).toBe('function')
    expect(typeof mod.DerivationOutputUnknownError).toBe('function')
    expect(typeof mod.DerivationOutputShapeError).toBe('function')
  })

  it('instanceof works across main + subpath imports (ESM splitting)', async () => {
    const main = await import('@noy-db/hub')
    const sub = await import('@noy-db/hub/derivations')
    const e = new sub.DerivationCycleError(['a', 'b', 'a'])
    expect(e).toBeInstanceOf(main.DerivationCycleError)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/subpath-export.test.ts`
Expected: FAIL — module `@noy-db/hub/derivations` cannot be resolved

- [ ] **Step 3: Re-export errors from the derivations barrel**

Edit `packages/hub/src/derivations/index.ts` to also re-export the four error classes:

```typescript
export { withDerivation } from './with-derivation.js'
export { DerivationRegistry } from './registry.js'
export { DerivationExecutor } from './executor.js'
export type {
  DerivationStrategy,
  DerivationStrategyHandle,
  DerivedFromMeta,
  OutputSpec,
} from './types.js'

// Re-export error classes so `@noy-db/hub/derivations` is self-contained.
// Splitting: true in tsup.config.ts deduplicates the class definitions
// across subpath boundaries, so `instanceof` works.
export {
  DerivationCycleError,
  DerivationDepthError,
  DerivationOutputUnknownError,
  DerivationOutputShapeError,
} from '../errors.js'
```

- [ ] **Step 4: Add the tsup entry**

In `packages/hub/tsup.config.ts`, add to the `ENTRIES` object — insert alongside `'tx/index'` since derivations is in the same `write-and-mutate` cluster:

```typescript
const ENTRIES = {
  index: 'src/index.ts',
  // ... existing entries ...
  'tx/index': 'src/tx/index.ts',
  'derivations/index': 'src/derivations/index.ts',  // ← NEW (sibling of tx)
  // ... rest ...
}
```

- [ ] **Step 5: Add the package.json subpath export**

In `packages/hub/package.json`, add the `./derivations` block to `exports`. Place it adjacent to `./tx` (cluster-siblings):

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

- [ ] **Step 6: Build**

Run: `pnpm turbo build --filter=@noy-db/hub`
Expected: green — `dist/derivations/index.{js,cjs,d.ts,d.cts}` all emitted

- [ ] **Step 7: Run to verify pass**

Run: `pnpm vitest run packages/hub/__tests__/derivations/subpath-export.test.ts`
Expected: PASS — both tests green

- [ ] **Step 8: Verify bundle-size CI doesn't regress unexpectedly**

Run: `pnpm --filter=@noy-db/hub bundle-check`
Expected: PASS — within `bundle-manifest.json` limits. If `all-on` shifts by more than ~2 KB minified, investigate before continuing. If small expected bump, update the manifest in this same commit.

- [ ] **Step 9: Commit**

```bash
git add packages/hub/tsup.config.ts packages/hub/package.json packages/hub/src/derivations/index.ts packages/hub/__tests__/derivations/subpath-export.test.ts packages/hub/bundle-manifest.json
git commit -m "feat(hub): expose derivations as @noy-db/hub/derivations subpath (#129)"
```

---

## Task 8: Wire `DerivationRegistry` into `Vault`

**Files:**
- Modify: `packages/hub/src/vault.ts`
- Modify: `packages/hub/src/noydb.ts`

- [ ] **Step 1: Add `derivationRegistry` field + open-time validation**

In `packages/hub/src/vault.ts`:

```typescript
import { DerivationRegistry } from './derivations/registry.js'
import type { DerivationStrategyHandle } from './derivations/types.js'

// inside class Vault:
private readonly derivationRegistry: DerivationRegistry

// in constructor:
this.derivationRegistry = new DerivationRegistry()
```

Add an async init helper called from the `openVault` path (since `register` is async):

```typescript
/** @internal — called by Noydb.openVault after construction. */
async _initDerivations(handles: ReadonlyArray<DerivationStrategyHandle>): Promise<void> {
  for (const h of handles) {
    await this.derivationRegistry.register(h.spec)
  }
  this.derivationRegistry.validate() // throws DerivationCycleError if cyclic
}

/** @internal */
_getDerivationRegistry(): DerivationRegistry {
  return this.derivationRegistry
}
```

- [ ] **Step 2: Forward strategies through createNoydb / openVault**

In `packages/hub/src/noydb.ts`, find `openVault`. After Vault construction:

```typescript
const derivationHandles = (opts.derivationStrategies ?? this.derivationStrategies ?? [])
  .filter(h => h.__noydb_strategy === 'derivation')
await vault._initDerivations(derivationHandles)
```

Add `derivationStrategies` to `NoydbOptions`:

```typescript
derivationStrategies?: ReadonlyArray<DerivationStrategyHandle>
```

- [ ] **Step 3: Build**

Run: `pnpm turbo build --filter=@noy-db/hub`
Expected: green

- [ ] **Step 4: Commit**

```bash
git add packages/hub/src/vault.ts packages/hub/src/noydb.ts
git commit -m "feat(hub): wire DerivationRegistry into Vault + Noydb (#129)"
```

---

## Task 9: Eager-mode integration in `Collection.put`

**Files:**
- Modify: `packages/hub/src/collection.ts`
- Test: `packages/hub/__tests__/derivations/eager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/eager.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation } from '../../src/index.js'
import { memory } from '@noy-db/to-memory'

interface Pdf { id: string; body: string }
interface PdfMeta { len: number; _derivedFrom?: any }

describe('Derivation — eager lifecycle', () => {
  it('writes derived outputs immediately after source write', async () => {
    const strategy = withDerivation<Pdf, { meta: PdfMeta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-eager-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hello' })
    const meta = await v.collection<PdfMeta>('pdf-meta').get('p1')
    expect(meta?.len).toBe(5)
    expect(meta?._derivedFrom?.source).toBe('pdfs')
  })

  it('re-derives on source change', async () => {
    const strategy = withDerivation<Pdf, { meta: PdfMeta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-rederive-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hi' })
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'longer text' })
    const meta = await v.collection<PdfMeta>('pdf-meta').get('p1')
    expect(meta?.len).toBe('longer text'.length)
  })

  it('writes multiple outputs', async () => {
    interface Text { content: string }
    const strategy = withDerivation<Pdf, { meta: PdfMeta; text: Text }>({
      source: 'pdfs',
      deterministic: true,
      outputs: {
        meta: { shape: 'record', collection: 'pdf-meta' },
        text: { shape: 'record', collection: 'pdf-text' },
      },
      derive: (s) => ({ meta: { len: s.body.length }, text: { content: s.body.toUpperCase() } }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-multi-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hi' })
    const meta = await v.collection<PdfMeta>('pdf-meta').get('p1')
    const text = await v.collection<Text>('pdf-text').get('p1')
    expect(meta?.len).toBe(2)
    expect(text?.content).toBe('HI')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/eager.test.ts`
Expected: FAIL — derivation not yet hooked into `Collection.put`

- [ ] **Step 3: Hook eager mode into `Collection.put`**

In `packages/hub/src/collection.ts`, find the END of `Collection.put` — AFTER `adapter.put(...)` (line 1114) AND AFTER any ledger append block (lines 1131-1151). Add:

```typescript
// --- Derivation dispatch (after store + ledger commit) ---
const derivationRegistry = this.vault._getDerivationRegistry?.()
if (derivationRegistry) {
  const strategies = derivationRegistry.strategiesForSource(this.name)
  for (const { spec, strategyHash } of strategies) {
    const mode = typeof spec.lifecycle === 'string' ? spec.lifecycle : spec.lifecycle.mode
    if (mode === 'eager') {
      const { DerivationExecutor } = await import('./derivations/executor.js')
      const sourceWithId = { ...(record as Record<string, unknown>), id } as any
      const result = await DerivationExecutor.run(spec, sourceWithId, version, strategyHash)
      for (const key of Object.keys(spec.outputs)) {
        const out = result.outputs[key]
        if (!out.ok) {
          if (spec.strict) throw out.error
          // Non-strict: log and continue. Project convention may be to use a logger.
          // eslint-disable-next-line no-console
          console.warn(`[derivation] output "${key}" failed:`, out.error)
          continue
        }
        const outputCollection = spec.outputs[key].collection
        await this.vault.collection(outputCollection).put(id, out.value as any)
      }
    } else {
      // Lazy mode — mark dependent outputs stale. Implemented in Task 11.
      const { markStale } = await import('./derivations/stale.js')
      await markStale(this.vault, spec, id)
    }
  }
}
```

**Implementation note:** Use the existing `version` variable already bound in `Collection.put` (the new `_v` of the source). If the variable name differs in the actual file, adapt — the value is "the new envelope's `_v`".

- [ ] **Step 4: Create a stub `stale.ts` to satisfy the import**

Create `packages/hub/src/derivations/stale.ts`:

```typescript
import type { Vault } from '../vault.js'
import type { DerivationStrategy } from './types.js'

/**
 * Mark every output id stale for this source-id. v1: in-memory only;
 * Task 11 adds persistence.
 *
 * @internal
 */
export async function markStale(
  _vault: Vault,
  _strategy: DerivationStrategy<any, any>,
  _sourceId: string,
): Promise<void> {
  // Filled in by Task 11.
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/hub/__tests__/derivations/eager.test.ts`
Expected: PASS — all 3 eager tests green

- [ ] **Step 6: Run the full hub test suite to check for regressions**

Run: `pnpm vitest run packages/hub`
Expected: PASS — only intentional changes; no broken pre-existing tests

- [ ] **Step 7: Commit**

```bash
git add packages/hub/src/collection.ts packages/hub/src/derivations/stale.ts packages/hub/__tests__/derivations/eager.test.ts
git commit -m "feat(hub): eager derivation dispatch in Collection.put (#129)"
```

---

## Task 10: Cycle detection at vault open

**Files:**
- Test: `packages/hub/__tests__/derivations/cycle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/cycle.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, DerivationCycleError } from '../../src/index.js'
import { memory } from '@noy-db/to-memory'

describe('Derivation cycle detection', () => {
  it('refuses to open a vault with a self-cycle', async () => {
    const bad = withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'a' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-cycle-passphrase-2026',
      derivationStrategies: [bad],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
  })

  it('refuses A → B → A', async () => {
    const a = withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const b = withDerivation({
      source: 'b',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'a' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-cycle2-passphrase-2026',
      derivationStrategies: [a, b],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
  })
})
```

- [ ] **Step 2: Run to verify pass**

Cycle detection is already wired in Task 8's `_initDerivations` (which calls `.validate()`). Run:

`pnpm vitest run packages/hub/__tests__/derivations/cycle.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/derivations/cycle.test.ts
git commit -m "test(hub): cycle detection at vault open for derivations (#129)"
```

---

## Task 11: Lazy lifecycle — stale tracking + on-read derive

**Files:**
- Modify: `packages/hub/src/derivations/stale.ts`
- Modify: `packages/hub/src/collection.ts` — add lazy-resolve on `get`
- Test: `packages/hub/__tests__/derivations/lazy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/lazy.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createNoydb, withDerivation } from '../../src/index.js'
import { memory } from '@noy-db/to-memory'

interface Pdf { id: string; body: string }
interface PdfText { content: string }

describe('Derivation — lazy lifecycle', () => {
  it('does NOT derive on source write', async () => {
    const derive = vi.fn((s: Pdf) => ({ text: { content: s.body.toUpperCase() } }))
    const strategy = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { text: { shape: 'record', collection: 'pdf-text' } },
      derive,
      lifecycle: 'lazy',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-lazy-noderive-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hello' })
    expect(derive).not.toHaveBeenCalled()
  })

  it('derives on first read of the stale output', async () => {
    const derive = vi.fn((s: Pdf) => ({ text: { content: s.body.toUpperCase() } }))
    const strategy = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { text: { shape: 'record', collection: 'pdf-text' } },
      derive,
      lifecycle: 'lazy',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-lazy-onread-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hi' })
    const text = await v.collection<PdfText>('pdf-text').get('p1')
    expect(derive).toHaveBeenCalledTimes(1)
    expect(text?.content).toBe('HI')
  })

  it('does not re-derive on a second read', async () => {
    const derive = vi.fn((s: Pdf) => ({ text: { content: s.body.toUpperCase() } }))
    const strategy = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { text: { shape: 'record', collection: 'pdf-text' } },
      derive,
      lifecycle: 'lazy',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-lazy-twice-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'hi' })
    await v.collection<PdfText>('pdf-text').get('p1')
    await v.collection<PdfText>('pdf-text').get('p1')
    expect(derive).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/lazy.test.ts`
Expected: FAIL — lazy mode not implemented

- [ ] **Step 3: Implement `markStale` + `resolveStaleOnRead`**

Replace `packages/hub/src/derivations/stale.ts`:

```typescript
import type { Vault } from '../vault.js'
import type { DerivationStrategy } from './types.js'
import { DerivationExecutor } from './executor.js'
import { computeStrategyHash } from './strategy-hash.js'

/**
 * In-memory stale map: vault → "<source>/<sourceId>" → strategies that
 * need to re-derive. v1 keeps this in memory; on vault close the map
 * is lost and the on-read path recomputes on first access (which is
 * correct because the derived record's `_derivedFrom.strategyHash`
 * mismatch triggers recompute anyway).
 */
const _staleByVault = new WeakMap<Vault, Map<string, Set<DerivationStrategy<any, any>>>>()

const keyFor = (source: string, sourceId: string) => `${source}/${sourceId}`

/** Mark every output of (strategy, sourceId) as stale. */
export async function markStale(
  vault: Vault,
  strategy: DerivationStrategy<any, any>,
  sourceId: string,
): Promise<void> {
  let map = _staleByVault.get(vault)
  if (!map) {
    map = new Map()
    _staleByVault.set(vault, map)
  }
  const k = keyFor(strategy.source, sourceId)
  let set = map.get(k)
  if (!set) {
    set = new Set()
    map.set(k, set)
  }
  set.add(strategy)
}

/**
 * Called from `Collection.get` on lazy-mode output collections. If the
 * id has a pending stale flag, re-derive before returning the record.
 */
export async function resolveStaleOnRead(
  vault: Vault,
  outputCollection: string,
  id: string,
): Promise<void> {
  const registry = vault._getDerivationRegistry()
  const strategies = registry.strategiesProducingOutput(outputCollection)
  if (strategies.length === 0) return

  const map = _staleByVault.get(vault)
  if (!map) return

  for (const { spec, strategyHash } of strategies) {
    const k = keyFor(spec.source, id)
    const pending = map.get(k)
    if (!pending || !pending.has(spec)) continue

    // Read the source and re-derive
    const source = await vault.collection<any>(spec.source).get(id)
    if (!source) {
      // Source deleted — clear stale and skip
      pending.delete(spec)
      continue
    }
    // The source record may not have `id` baked in; ensure we pass it.
    const sourceWithId = { ...source, id }
    // We need the source version; fetch the envelope for `_v`.
    // Simplified: pass the strategyHash; sourceVersion can be 0 if not
    // available without re-fetching the envelope (v1 acceptable trade-off).
    const result = await DerivationExecutor.run(spec, sourceWithId, 0, strategyHash)
    for (const key of Object.keys(spec.outputs)) {
      const out = result.outputs[key]
      if (!out.ok) continue
      await vault.collection(spec.outputs[key].collection).put(id, out.value as any)
    }
    pending.delete(spec)
  }
}
```

- [ ] **Step 4: Hook lazy resolution into `Collection.get`**

In `packages/hub/src/collection.ts`, find the public `get(id)` method. Near the top, before fetching from the adapter, add:

```typescript
// --- Lazy derivation resolution ---
const derivationRegistry = this.vault._getDerivationRegistry?.()
if (derivationRegistry) {
  const producers = derivationRegistry.strategiesProducingOutput(this.name)
  if (producers.length > 0) {
    const { resolveStaleOnRead } = await import('./derivations/stale.js')
    await resolveStaleOnRead(this.vault, this.name, id)
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run packages/hub/__tests__/derivations/lazy.test.ts`
Expected: PASS — all 3 lazy tests green

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/derivations/stale.ts packages/hub/src/collection.ts packages/hub/__tests__/derivations/lazy.test.ts
git commit -m "feat(hub): lazy derivation — stale tracking + on-read resolution (#129)"
```

---

## Task 12: `withTransactions` strict-mode rollback

**Files:**
- Test: `packages/hub/__tests__/derivations/strict-tx.test.ts`
- Modify: `packages/hub/src/collection.ts` (verify strict throws propagate inside tx)

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/strict-tx.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, withTransactions } from '../../src/index.js'
import { memory } from '@noy-db/to-memory'

interface Pdf { id: string; body: string }

describe('Derivation strict mode + withTransactions', () => {
  it('rolls back source write if derive throws', async () => {
    const strategy = withDerivation<Pdf, { meta: { len: number } }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => { throw new Error('always-fails') },
      lifecycle: 'eager',
      strict: true,
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-strict-passphrase-2026',
      derivationStrategies: [strategy],
      strategies: [withTransactions()],
    })
    const v = await db.openVault('demo')
    await expect(
      db.transaction(async (tx) => {
        tx.vault('demo').collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'x' })
      }),
    ).rejects.toThrow('always-fails')
    const pdf = await v.collection<Pdf>('pdfs').get('p1')
    expect(pdf).toBeNull()  // rolled back
  })

  it('non-strict mode commits source even if derive fails', async () => {
    const strategy = withDerivation<Pdf, { meta: { len: number } }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => { throw new Error('soft-fail') },
      lifecycle: 'eager',
      // strict: false (default)
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-nonstrict-passphrase-2026',
      derivationStrategies: [strategy],
      strategies: [withTransactions()],
    })
    const v = await db.openVault('demo')
    await db.transaction(async (tx) => {
      tx.vault('demo').collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'x' })
    })
    const pdf = await v.collection<Pdf>('pdfs').get('p1')
    expect(pdf).not.toBeNull()  // committed
    const meta = await v.collection('pdf-meta').get('p1')
    expect(meta).toBeNull()  // derive failed, output absent
  })
})
```

- [ ] **Step 2: Run to verify**

Strict mode rollback works because the dispatch in Task 9 throws when `spec.strict && !out.ok`. The thrown error propagates out of `Collection.put`, which is buffered inside the transaction body — `runTransaction`'s Phase 3 revert pass rolls back the source op.

Run: `pnpm vitest run packages/hub/__tests__/derivations/strict-tx.test.ts`
Expected: PASS

If strict-mode test fails because the throw isn't propagating cleanly out of the dispatch loop, ensure the dispatch in `Collection.put` (Task 9) doesn't swallow strict failures. The relevant block:

```typescript
if (!out.ok) {
  if (spec.strict) throw out.error  // ← propagates; tx revert pass catches it
  console.warn(...)
  continue
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/derivations/strict-tx.test.ts
git commit -m "test(hub): derivation strict-mode + withTransactions rollback (#129)"
```

---

## Task 13: `vault.deriveAll(name)` — bulk recompute

**Files:**
- Modify: `packages/hub/src/vault.ts`
- Test: `packages/hub/__tests__/derivations/derive-all.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/derivations/derive-all.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation } from '../../src/index.js'
import { memory } from '@noy-db/to-memory'

interface Pdf { id: string; body: string }

describe('vault.deriveAll', () => {
  it('re-derives every record in the source collection', async () => {
    let version = 1
    const strategy = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s: Pdf) => ({ meta: { len: s.body.length, version } }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-deriveall-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<Pdf>('pdfs').put('p1', { id: 'p1', body: 'a' })
    await v.collection<Pdf>('pdfs').put('p2', { id: 'p2', body: 'bb' })
    version = 2
    const result = await v.deriveAll('pdfs')
    expect(result.derived).toBe(2)
    expect(result.failed).toBe(0)
    const m1 = await v.collection<any>('pdf-meta').get('p1')
    const m2 = await v.collection<any>('pdf-meta').get('p2')
    expect(m1.version).toBe(2)
    expect(m2.version).toBe(2)
  })

  it('returns zero counts when no strategy targets the collection', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-deriveall-empty-passphrase-2026',
    })
    const v = await db.openVault('demo')
    const result = await v.deriveAll('absent')
    expect(result.derived).toBe(0)
    expect(result.failed).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/__tests__/derivations/derive-all.test.ts`
Expected: FAIL — `vault.deriveAll` not defined

- [ ] **Step 3: Implement `deriveAll`**

In `packages/hub/src/vault.ts`, add the method:

```typescript
/**
 * Re-derive every record in the named source collection. Useful after
 * a strategy change to bring previously-derived records up-to-date
 * with the new shape.
 *
 * Sequential in v1; parallelisation deferred to v2.
 */
async deriveAll(sourceCollection: string): Promise<{ derived: number; failed: number }> {
  const registry = this._getDerivationRegistry()
  const strategies = registry.strategiesForSource(sourceCollection)
  if (strategies.length === 0) return { derived: 0, failed: 0 }

  const { DerivationExecutor } = await import('./derivations/executor.js')

  const sourceColl = this.collection<any>(sourceCollection)
  const ids = await sourceColl.list()
  let derived = 0
  let failed = 0
  for (const record of ids) {
    if (typeof record !== 'object' || record === null) continue
    const id = (record as any).id
    if (typeof id !== 'string') continue
    for (const { spec, strategyHash } of strategies) {
      const sourceWithId = { ...(record as Record<string, unknown>), id }
      const result = await DerivationExecutor.run(spec, sourceWithId, 0, strategyHash)
      let anyFailed = false
      for (const key of Object.keys(spec.outputs)) {
        const out = result.outputs[key]
        if (!out.ok) { anyFailed = true; continue }
        await this.collection(spec.outputs[key].collection).put(id, out.value as any)
      }
      if (anyFailed) failed++
      else derived++
    }
  }
  return { derived, failed }
}
```

**Note:** `Collection.list()` returns records (not just ids) per the project convention; if it returns ids, use `Promise.all(ids.map(id => sourceColl.get(id)))`. Adapt to actual surface.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/hub/__tests__/derivations/derive-all.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/vault.ts packages/hub/__tests__/derivations/derive-all.test.ts
git commit -m "feat(hub): vault.deriveAll() bulk recompute primitive (#129)"
```

---

## Task 14: Showcase 70 — end-to-end PDF derivation

**Files:**
- Create: `showcases/src/70-with-derivation.showcase.test.ts`

- [ ] **Step 1: Write the showcase**

Create `showcases/src/70-with-derivation.showcase.test.ts`:

```typescript
/**
 * Showcase 70 — withDerivation (Dim 14)
 *
 * Source collection `pdfs` is derived into two outputs: `pdf-meta`
 * (size, page count) and `pdf-text` (extracted text). The derive
 * function is deterministic, runs on plaintext after DEK unwrap, and
 * its outputs are encrypted with the same DEK as the source.
 *
 * Spec: docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, withTransactions } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Pdf { id: string; filename: string; body: string }
interface PdfMeta { len: number; pages: number; filename: string }
interface PdfText { content: string }

const pdfMetaStrategy = withDerivation<Pdf, { meta: PdfMeta; text: PdfText }>({
  source: 'pdfs',
  deterministic: true,
  outputs: {
    meta: { shape: 'record', collection: 'pdf-meta' },
    text: { shape: 'record', collection: 'pdf-text' },
  },
  derive: (pdf) => ({
    meta: {
      len: pdf.body.length,
      pages: Math.ceil(pdf.body.length / 1000),
      filename: pdf.filename,
    },
    text: { content: pdf.body },
  }),
  lifecycle: 'eager',
})

const open = async (passphrase: string) => {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: passphrase,
    derivationStrategies: [pdfMetaStrategy],
    strategies: [withTransactions()],
  })
  const vault = await db.openVault('library')
  return { db, vault }
}

describe('Showcase 70 — withDerivation', () => {
  it('writes derived outputs after source write (eager)', async () => {
    const { vault } = await open('showcase-70-eager-passphrase-2026')
    await vault.collection<Pdf>('pdfs').put('p1', {
      id: 'p1', filename: 'a.pdf', body: 'hello world',
    })
    const meta = await vault.collection<PdfMeta>('pdf-meta').get('p1')
    const text = await vault.collection<PdfText>('pdf-text').get('p1')
    expect(meta?.len).toBe('hello world'.length)
    expect(meta?.filename).toBe('a.pdf')
    expect(text?.content).toBe('hello world')
  })

  it('re-derives on source update', async () => {
    const { vault } = await open('showcase-70-update-passphrase-2026')
    await vault.collection<Pdf>('pdfs').put('p1', { id: 'p1', filename: 'a.pdf', body: 'first' })
    await vault.collection<Pdf>('pdfs').put('p1', { id: 'p1', filename: 'a.pdf', body: 'second-longer' })
    const meta = await vault.collection<PdfMeta>('pdf-meta').get('p1')
    expect(meta?.len).toBe('second-longer'.length)
  })

  it('stamps _derivedFrom onto every output', async () => {
    const { vault } = await open('showcase-70-meta-passphrase-2026')
    await vault.collection<Pdf>('pdfs').put('p1', { id: 'p1', filename: 'a.pdf', body: 'x' })
    const meta = await vault.collection<any>('pdf-meta').get('p1')
    expect(meta._derivedFrom.source).toBe('pdfs')
    expect(meta._derivedFrom.sourceId).toBe('p1')
  })

  it('vault.deriveAll re-derives every record', async () => {
    const { vault } = await open('showcase-70-deriveall-passphrase-2026')
    await vault.collection<Pdf>('pdfs').put('p1', { id: 'p1', filename: 'a.pdf', body: 'a' })
    await vault.collection<Pdf>('pdfs').put('p2', { id: 'p2', filename: 'b.pdf', body: 'bb' })
    const { derived } = await vault.deriveAll('pdfs')
    expect(derived).toBe(2)
  })

  it('strict mode rolls back source on derive failure', async () => {
    const failing = withDerivation<Pdf, { meta: PdfMeta }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => { throw new Error('mock failure') },
      lifecycle: 'eager',
      strict: true,
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'showcase-70-strict-passphrase-2026',
      derivationStrategies: [failing],
      strategies: [withTransactions()],
    })
    const vault = await db.openVault('library')
    await expect(
      db.transaction(async (tx) => {
        tx.vault('library').collection<Pdf>('pdfs').put('p1', {
          id: 'p1', filename: 'a.pdf', body: 'x',
        })
      }),
    ).rejects.toThrow('mock failure')
    expect(await vault.collection('pdfs').get('p1')).toBeNull()
  })
})
```

- [ ] **Step 2: Run**

Run: `pnpm vitest run showcases/src/70-with-derivation.showcase.test.ts`
Expected: PASS — all 5 scenarios green

- [ ] **Step 3: Commit**

```bash
git add showcases/src/70-with-derivation.showcase.test.ts
git commit -m "test(showcases): 70-with-derivation — PDF source + meta + text outputs (#129)"
```

---

## Task 15: Subsystem doc

**Files:**
- Create: `docs/subsystems/derivations.md`

- [ ] **Step 1: Write the doc**

Create `docs/subsystems/derivations.md`:

```markdown
# Derivations (Dim 14)

> **Status:** v1, ships in 0.1.0-pre.11. Spec: `docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md`.

`withDerivation` lets a vault declare deterministic data derivations of one or
more typed outputs from a source record. The derive function runs on plaintext
(after DEK unwrap, inside the encrypted boundary) and its outputs are encrypted
with the same DEK before reaching the store.

## At a glance

```ts
import { withDerivation } from '@noy-db/hub'

const pdfDerivation = withDerivation<Pdf, { meta: PdfMeta; text: PdfText }>({
  source: 'pdfs',
  deterministic: true,
  outputs: {
    meta: { shape: 'record', collection: 'pdf-meta' },
    text: { shape: 'record', collection: 'pdf-text' },
  },
  derive: (pdf) => ({
    meta: { len: pdf.body.length, pages: pdf.pages.length },
    text: { content: extractText(pdf.body) },
  }),
  lifecycle: 'eager',  // or 'lazy'
})
```

## Lifecycles

- **`eager`** — derive runs synchronously inside the source-write transaction.
  Outputs are written via the same `Collection.put` pipeline. Recommended for
  small, fast derive functions.
- **`lazy`** — source-write marks output ids stale; first read of any output
  triggers the derive. Recommended when the derive is expensive and most
  sources are written without being read.

## Strict vs non-strict

Default (`strict: false`): per-output failures are isolated. Other outputs
commit; the failed output is absent from the store and re-attempts on next
`vault.deriveAll`.

`strict: true`: a single output failure rolls back the source write (only
when wrapped in `withTransactions`). Use for outputs that must remain
consistent with the source.

## Zero-knowledge guarantee

The derive function executes after DEK unwrap, on plaintext. The store never
sees plaintext. Outputs are encrypted with the same DEK as the source before
they reach the store — listing the storage backend cannot reveal the
derivation graph.

`_derivedFrom` metadata lives inside the encrypted payload, not in the
plaintext envelope.

## `_derivedFrom` metadata

Every derived record carries:

```ts
{
  _derivedFrom: {
    source: 'pdfs',
    sourceId: 'abc',
    sourceVersion: 3,
    derivedAt: '2026-05-18T...',
    strategyHash: 'sha256-...',  // changes when the strategy changes
  }
}
```

`strategyHash` is the v1 mechanism for detecting strategy drift: a record
whose hash doesn't match the current strategy is recomputed by
`vault.deriveAll`.

## Cycle detection

Cyclic graphs (A → B → A, self-loops, etc.) are rejected at `vault.openVault`
with `DerivationCycleError`. The graph is the union of every strategy's
source + output collection set.

## Composition with guards

Guards run **before encryption**. Derivations fire **after** the store write
+ ledger append. A guard that blocks a source write also blocks the derivation
that would have fired from it.

```
Collection.put
  1. Permission check
  2. GuardRegistry.check            ← #123
  3. Encrypt + store.put
  4. Ledger append
  5. DerivationRegistry.onSourceWrite  ← this doc
```

## `vault.deriveAll(collection)`

Re-derive every record in the named source collection. Useful after a strategy
change (the strategyHash mismatch forces a recompute on next visit, but
`deriveAll` is the explicit bulk path).

```ts
const { derived, failed } = await vault.deriveAll('pdfs')
```

## Errors

- `DerivationCycleError(path[])` — graph contains a cycle
- `DerivationDepthError(limit, attempted)` — cascade exceeded `maxDepth`
- `DerivationOutputUnknownError(collection)` — output collection unknown
- `DerivationOutputShapeError(outputKey, detail)` — derive returned wrong shape

## What's deferred to v2

- Cache-tier backends (`to-cache-*`)
- Built-in derivers (PDF, image, etc.)
- `withMaterializedView` (collection-level query derivation)
- Scheduled / cron-style refresh
- Non-deterministic derivations
- External / sandboxed derivation runtimes
- Public CDN derivations
- Streaming materialized views (over Dim 12)

See the spec for the full deferred list.

## Showcase

`showcases/src/70-with-derivation.showcase.test.ts` — PDF source + meta + text
outputs, with eager update, deriveAll, and strict-mode rollback.
```

- [ ] **Step 2: Commit**

```bash
git add docs/subsystems/derivations.md
git commit -m "docs: subsystem reference for derivations (Dim 14) (#129)"
```

---

## Task 16: `features.yaml` entry

**Files:**
- Modify: `features.yaml`

- [ ] **Step 1: Add the entry**

Add to `features.yaml`:

```yaml
- id: derivations
  name: Deterministic derived data
  cluster: write-and-mutate
  spec: docs/subsystems/derivations.md#derivations-dim-14
  subsystem_doc: docs/subsystems/derivations.md
  package: '@noy-db/hub/derivations'
  factory: withDerivation
  status: beta
  showcases:
    - id: 70-with-derivation
      path: showcases/src/70-with-derivation.showcase.test.ts
  recipes: []
  playground_pages: []
  diagrams: []
  invariants:
    - 'derive runs on plaintext, after DEK unwrap, before encrypt'
    - 'outputs encrypted with same DEK as source by default'
    - '_derivedFrom lives in encrypted payload, not unencrypted envelope'
    - 'strict: true rolls back source write on output failure inside withTransactions'
    - 'cycle detection at vault open — refuses cyclic graphs'
  related: [guards, transactions]
```

- [ ] **Step 2: Validate**

Run: `pnpm validate:features`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add features.yaml
git commit -m "chore(features): register derivations in features.yaml (#129)"
```

---

## Task 17: Conformance smoke test on `to-file`

**Files:**
- Create: `packages/hub/__tests__/derivations/cross-store.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/hub/__tests__/derivations/cross-store.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNoydb, withDerivation } from '../../src/index.js'
import { file } from '@noy-db/to-file'

describe('Derivation conformance on to-file', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noydb-derivations-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('eager derivation survives vault re-open', async () => {
    const strategy = withDerivation<{ id: string; body: string }, { meta: { len: number } }>({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    })
    const open = () => createNoydb({
      store: file({ directory: dir }),
      user: 'alice',
      secret: 'derivation-tofile-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const db1 = await open()
    const v1 = await db1.openVault('demo')
    await v1.collection('pdfs').put('p1', { id: 'p1', body: 'hello' })

    const db2 = await open()
    const v2 = await db2.openVault('demo')
    const meta = await v2.collection<{ len: number }>('pdf-meta').get('p1')
    expect(meta?.len).toBe(5)
  })
})
```

- [ ] **Step 2: Run**

Run: `pnpm vitest run packages/hub/__tests__/derivations/cross-store.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/hub/__tests__/derivations/cross-store.test.ts
git commit -m "test(hub): derivation conformance on to-file (#129)"
```

---

## Task 18: Final sweep

- [ ] **Step 1: Typecheck**

Run: `pnpm turbo typecheck`
Expected: green

- [ ] **Step 2: Lint**

Run: `pnpm turbo lint`
Expected: green

- [ ] **Step 3: Full test suite**

Run: `pnpm turbo test`
Expected: green — no regressions

- [ ] **Step 4: Validate features.yaml**

Run: `pnpm validate:features`
Expected: PASS

- [ ] **Step 5: Commit any fixups**

```bash
git status
# If fixups:
git commit -m "chore(hub): lint + typecheck fixups from derivation rollout"
```

---

## Self-review checklist

Spec coverage:

- [x] Envelope extension (`_derivedFrom`) — Task 6 stamps onto outputs
- [x] DerivationRegistry — Task 5
- [x] DerivationExecutor eager mode — Tasks 6, 9
- [x] Multi-output dispatch — Tasks 6, 9
- [x] Lazy-mode invalidation + stale tracking — Task 11
- [x] Collection.put / Collection.get integration — Tasks 9, 11
- [x] withTransactions strict-mode rollback — Task 12
- [x] vault.deriveAll — Task 13
- [x] Cycle detection at vault open — Task 10
- [x] Showcase + recipe + subsystem doc + features.yaml entry — Tasks 14, 15, 16
- [x] Conformance to-memory + to-file — Tasks 9, 17
- [x] All 4 error types exported — Task 1, Task 7

**Open questions resolved inline:**

1. Lazy stale-tracking persistence: in-memory WeakMap (Task 11). On vault close the map is lost; the on-read path recomputes on first access because the derived record's `_derivedFrom.strategyHash` will still match (no stale flag = no recompute on this session). Documented as v1 trade-off.
2. strategyHash storage: computed once at registration (Task 5), cached in `RegisteredStrategy`. Not re-hashed on every read.
3. Output type validation: shape check only (Task 6) — no deep validation. Spec says trust the deriver; deeper validation in v2.
4. deriveAll concurrency: sequential in v1 (Task 13).
5. Vault-init failure recovery: always-fail-fast on cycle (Task 8, Task 10). No partial-init.

**Type consistency:** `DerivationStrategy<TSource, TOutputs>`, `DerivedFromMeta`, `OutputSpec` consistent across files.
**Placeholder scan:** no TBDs; implementation notes reference exact existing files/lines.

---

## Issue mapping

All tasks → #129 (Dim 14 epic). Sub-PRs may split along task lines if useful.
