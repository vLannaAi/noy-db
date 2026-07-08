# Satellite Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement satellite collections v1 per spec `docs/superpowers/specs/2026-07-05-satellite-collections-design.md` (DRAFT v3, issue #591): a base + satellite collection pair (1:1 on record id), explicit `fields` routing, a narrow-typed joined handle, persisted pairing marker, existence-authority read filtering, and forget fan-out through the full purge suite.

**Architecture:** New archetype-③ feature at `packages/hub/src/with-shape/satellites/` — declared on `collection({ satelliteOf, fields, joined })`, with only thin call-sites in the ratcheted kernel files (each bump budgeted below). The satellite handle is a JS `Proxy` over the real `Collection` (full surface preserved; get/list/query/put overridden); the joined handle is a dedicated narrow `JoinedHandle<T>` class returned by a new `vault.joined()` accessor (never a `Collection<T>` cast). Pairing config persists as an `x-satellite` marker in `_schemas` (classified config-drift pattern). Writes are ordered fan-out + best-effort revert with the audit hardening (pre-validated legs, dirty-entry cleanup, cache invalidation).

**Tech Stack:** TypeScript ESM (`.js` import suffixes), vitest (colocated `*.test.ts`), tsup, pnpm. No new dependencies.

## Global Constraints

- Repo: `/Users/vicio/lanna-db/noy-db` (work in `packages/hub` unless a task says otherwise). Branch: `feat/591-satellites` off `main`.
- **TDD** — every task: failing test → verify fail → minimal impl → verify pass → commit.
- **No npm crypto packages; hub stays portable** — no Node built-ins anywhere under `hub/src/**` (`pnpm check:architecture` enforces).
- **Kernel-surface ratchet budget** (`scripts/check-architecture.mjs:689,846,941`; current ceilings 4647/3898/2360 with 1 line headroom each): this plan authorizes bumps of **collection.ts +6 → 4653, vault.ts +40 → 3938, noydb.ts +0**. Task 12 applies the bumps with dated justification comments (existing convention, see `check-architecture.mjs:842-845`). If an implementation step needs more, stop and flag — do not silently grow.
- **Commit style:** conventional commits referencing `#591` (e.g. `feat(satellites): #591 …`). **NEVER add Claude attribution / Co-Authored-By lines** (repo hard constraint, overrides harness default).
- Refusal error: `SatelliteConfigError` for every R-S* refusal. Spec refusal IDs (R-S1…R-S9) must appear verbatim in error messages so conformance tests can assert them.
- Run a task's tests with `pnpm vitest run <file>` from the repo root; full gate before final PR: `pnpm --filter @noy-db/hub test && pnpm --filter @noy-db/hub typecheck && pnpm --filter @noy-db/hub lint && pnpm check:architecture && pnpm validate:features && pnpm knip`.
- v1 scope guards (from spec): ONE satellite per base; new collections only (no backfill); `crdtMode` refused on pair members (R-S8); joined reactive APIs throw.

## File Structure (locked)

```
packages/hub/src/with-shape/satellites/
  types.ts        SatelliteSpec, PairingMarker, JoinedHandle<T> interface, JoinedDescription
  validate.ts     validateSatelliteDeclaration() — sync refusals R-S3/R-S5/R-S8 (+R-S1/R-S5 async cross-check)
  marker.ts       persistSatelliteMarker() / readSatelliteMarker() — R-S9 reconcile (config-drift pattern)
  registry.ts     SatelliteRegistry — pairs, poisoned-state, pair mutex, resolver mirroring
  proxy.ts        makeSatelliteProxy() — JS Proxy over Collection (existence filter, R-S6)
  existence.ts    isBaseLive(), liveBaseIdSet() — undecrypted envelope checks (shared by proxy/search/bundle)
  fanout.ts       joinedPut(), pairDelete() — ordered fan-out + revert hardening
  joined.ts       SatelliteJoinedCollection implements JoinedHandle<T>
  index.ts        subpath export surface
  *.test.ts       colocated unit tests per module
  satellites.integration.test.ts   spec conformance vectors (spy store)
Modify:
  kernel/errors.ts                     + SatelliteConfigError
  kernel/collection-config.ts          + satelliteOf/fields/joined option types
  kernel/vault.ts                      + thin call-sites: registration, joined guard, vault.joined(), forget ref-expansion
  kernel/collection.ts                 + _removeDirtyEntry seam (≤6 lines)
  with-shape/persisted-schemas/register.ts  + persistSatelliteMarker (mirrors persistClassifiedMarker)
  with-party/team/sync.ts              + removeDirty(), pair-expansion of filters, resolver mirroring hook
  with-pod/bundle.ts                   + dead-satellite envelope filter
  with-lookup/search/collection-facade.ts   + retrieve() existence post-filter
  scripts/check-architecture.mjs       + 'with-shape/satellites' exemption + ceiling bumps
  features.yaml, packages/hub/package.json, packages/hub/tsup.config.ts,
  docs/subsystems/satellites.md, SPEC.md
```

---

### Task 1: Types, error class, and declaration validation

**Files:**
- Create: `packages/hub/src/with-shape/satellites/types.ts`
- Create: `packages/hub/src/with-shape/satellites/validate.ts`
- Test: `packages/hub/src/with-shape/satellites/validate.test.ts`
- Modify: `packages/hub/src/kernel/errors.ts` (append one class)
- Modify: `packages/hub/src/kernel/collection-config.ts` (option types only)

**Interfaces:**
- Produces: `SatelliteSpec { base: string; satellite: string; fields: readonly string[]; joined?: string }`, `PairingMarker { base: string; fieldsHash: string; joined?: string }`, `JoinedHandle<T>` (used by Tasks 6–7), `SatelliteConfigError`, `validateSatelliteDeclaration(input): SatelliteSpec` (throws), `hashFields(fields): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/hub/src/with-shape/satellites/validate.test.ts
import { describe, it, expect } from 'vitest'
import { validateSatelliteDeclaration, hashFields } from './validate.js'
import { SatelliteConfigError } from '../../kernel/errors.js'

describe('validateSatelliteDeclaration', () => {
  const ok = { satellite: 'msgs_text', satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' }

  it('accepts a well-formed declaration and returns a frozen SatelliteSpec', () => {
    const spec = validateSatelliteDeclaration({ ...ok, baseIsSatellite: false, crdtMode: false })
    expect(spec).toEqual({ base: 'msgs', satellite: 'msgs_text', fields: ['subject', 'body'], joined: 'msgs_full' })
    expect(Object.isFrozen(spec)).toBe(true)
  })

  it('R-S3: refuses when the base is itself a satellite (no chains)', () => {
    expect(() => validateSatelliteDeclaration({ ...ok, baseIsSatellite: true, crdtMode: false }))
      .toThrowError(/R-S3/)
  })

  it('R-S5: refuses omitted, empty, or id-bearing fields', () => {
    for (const fields of [undefined, [], ['id', 'body']]) {
      expect(() => validateSatelliteDeclaration({ ...ok, fields: fields as never, baseIsSatellite: false, crdtMode: false }))
        .toThrowError(SatelliteConfigError)
    }
    expect(() => validateSatelliteDeclaration({ ...ok, fields: ['id'], baseIsSatellite: false, crdtMode: false }))
      .toThrowError(/R-S5/)
  })

  it('R-S5: refuses a joined name equal to base or satellite name', () => {
    expect(() => validateSatelliteDeclaration({ ...ok, joined: 'msgs', baseIsSatellite: false, crdtMode: false }))
      .toThrowError(/R-S5/)
  })

  it('R-S8: refuses crdtMode on the satellite member', () => {
    expect(() => validateSatelliteDeclaration({ ...ok, baseIsSatellite: false, crdtMode: true }))
      .toThrowError(/R-S8/)
  })

  it('hashFields is order-insensitive and stable', () => {
    expect(hashFields(['b', 'a'])).toBe(hashFields(['a', 'b']))
    expect(hashFields(['a', 'b'])).not.toBe(hashFields(['a']))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/hub/src/with-shape/satellites/validate.test.ts`
Expected: FAIL — cannot resolve `./validate.js`.

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/with-shape/satellites/types.ts
import type { CollectionDescription } from '../../kernel/collection.js'

/** One base↔satellite pair. v1: exactly one satellite per base. */
export interface SatelliteSpec {
  readonly base: string
  readonly satellite: string
  readonly fields: readonly string[]
  readonly joined?: string | undefined
}

/** Persisted into `_schemas/<satellite>` under `x-satellite` (R-S9 drift guard). */
export interface PairingMarker {
  readonly base: string
  readonly fieldsHash: string
  readonly joined?: string | undefined
}

/**
 * The full-record handle — deliberately NARROW (spec § The model): never a
 * `Collection<T>` cast. `describe()` works (the @noy-db/ui contract);
 * reactive APIs are absent from the type entirely.
 */
export interface JoinedHandle<T extends Record<string, unknown> = Record<string, unknown>> {
  get(id: string): Promise<T | null>
  put(id: string, record: T): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<T[]>
  describe(): Promise<CollectionDescription>
}
```

```ts
// packages/hub/src/with-shape/satellites/validate.ts
import { SatelliteConfigError } from '../../kernel/errors.js'
import type { SatelliteSpec } from './types.js'

export interface SatelliteDeclarationInput {
  readonly satellite: string
  readonly satelliteOf: string
  readonly fields: readonly string[] | undefined
  readonly joined?: string | undefined
  /** True when the named base is itself registered as a satellite (R-S3). */
  readonly baseIsSatellite: boolean
  /** True when the declaring collection (or its base) sets crdtMode (R-S8). */
  readonly crdtMode: boolean
}

/** Sync declaration refusals R-S3/R-S5/R-S8. Async cross-checks live in registry.ts. */
export function validateSatelliteDeclaration(input: SatelliteDeclarationInput): SatelliteSpec {
  if (input.baseIsSatellite) {
    throw new SatelliteConfigError(
      `R-S3: "${input.satellite}" declares satelliteOf "${input.satelliteOf}", which is itself a satellite — no satellite-of-satellite chains.`,
    )
  }
  if (input.crdtMode) {
    throw new SatelliteConfigError(
      `R-S8: crdtMode is refused on either member of a satellite pair in v1 (revert cannot compensate a merge).`,
    )
  }
  if (!input.fields || input.fields.length === 0) {
    throw new SatelliteConfigError(`R-S5: satellite "${input.satellite}" must declare a non-empty fields list.`)
  }
  if (input.fields.includes('id')) {
    throw new SatelliteConfigError(`R-S5: fields must not contain the shared key "id".`)
  }
  if (input.joined !== undefined && (input.joined === input.satellite || input.joined === input.satelliteOf)) {
    throw new SatelliteConfigError(`R-S5: joined name "${input.joined}" collides with a pair member.`)
  }
  return Object.freeze({
    base: input.satelliteOf,
    satellite: input.satellite,
    fields: Object.freeze([...input.fields]),
    joined: input.joined,
  })
}

/** Order-insensitive stable hash of the fields list (FNV-1a over the sorted, joined names). */
export function hashFields(fields: readonly string[]): string {
  const s = [...fields].sort().join(' ')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}
```

Append to `packages/hub/src/kernel/errors.ts` (after the last error class, matching house style):

```ts
/**
 * A satellite-collection declaration or operation violated the refusal
 * matrix (R-S1…R-S9) of the satellite-collections design. The message
 * always names the R-S id.
 */
export class SatelliteConfigError extends NoydbError {
  constructor(message: string) {
    super(message)
    this.name = 'SatelliteConfigError'
  }
}
```

Append to the collection options interface in `packages/hub/src/kernel/collection-config.ts` (next to `schema` at ~line 180 — types only, no behavior):

```ts
  /** Declares this collection a satellite of `satelliteOf` (spec #591). */
  satelliteOf?: string | undefined
  /** Satellite routing table — the fields owned by this satellite (required with satelliteOf). */
  fields?: readonly string[] | undefined
  /** Registers the full-record joined handle under this name (optional; see vault.joined()). */
  joined?: string | undefined
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/hub/src/with-shape/satellites/validate.test.ts` → PASS (6 tests).
Also: `pnpm --filter @noy-db/hub typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/with-shape/satellites/ packages/hub/src/kernel/errors.ts packages/hub/src/kernel/collection-config.ts
git commit -m "feat(satellites): #591 declaration types, SatelliteConfigError, sync refusals R-S3/R-S5/R-S8"
```

---

### Task 2: Persisted pairing marker (R-S9)

**Files:**
- Create: `packages/hub/src/with-shape/satellites/marker.ts`
- Test: `packages/hub/src/with-shape/satellites/marker.test.ts`
- Modify: `packages/hub/src/with-shape/persisted-schemas/register.ts` (add `persistSatelliteMarker`, mirroring `persistClassifiedMarker` — same #583 lost-update hardening; read that function first and copy its read-merge-write shape exactly)
- Modify: `packages/hub/src/with-shape/persisted-schemas/storage.ts` only if the persisted-schema record type needs the optional `satellite?: PairingMarker` key added to its shape.

**Interfaces:**
- Consumes: `hashFields`, `PairingMarker` (Task 1); `loadPersistedSchema(store, vault, collectionName, dek)` (existing).
- Produces: `ensureSatelliteMarker(store, vaultName, spec, dek): Promise<void>` — persists on first declaration, **throws `SatelliteConfigError` "R-S9"** when an existing marker mismatches `(base, fieldsHash, joined)`.

- [ ] **Step 1: Write the failing tests** — use the in-memory store the config-drift tests use (find with `grep -rn "persistClassifiedMarker" packages/hub/src --include="*.test.ts"` and reuse its store fixture):

```ts
// packages/hub/src/with-shape/satellites/marker.test.ts
import { describe, it, expect } from 'vitest'
import { ensureSatelliteMarker } from './marker.js'
import { SatelliteConfigError } from '../../kernel/errors.js'
// Reuse the persisted-schemas test fixture for (store, dek) — same import the
// classified config-drift tests use.

const spec = { base: 'msgs', satellite: 'msgs_text', fields: ['subject', 'body'] as const, joined: 'msgs_full' }

describe('ensureSatelliteMarker (R-S9)', () => {
  it('persists on first declaration and accepts an identical re-declaration', async () => {
    const { store, dek } = await makeFixture()
    await ensureSatelliteMarker(store, 'v1', spec, dek)
    await expect(ensureSatelliteMarker(store, 'v1', spec, dek)).resolves.toBeUndefined()
  })

  it('refuses a re-declaration with a divergent fields list', async () => {
    const { store, dek } = await makeFixture()
    await ensureSatelliteMarker(store, 'v1', spec, dek)
    await expect(
      ensureSatelliteMarker(store, 'v1', { ...spec, fields: ['body'] }, dek),
    ).rejects.toThrowError(/R-S9/)
  })

  it('refuses a re-declaration with a divergent base or joined name', async () => {
    const { store, dek } = await makeFixture()
    await ensureSatelliteMarker(store, 'v1', spec, dek)
    await expect(ensureSatelliteMarker(store, 'v1', { ...spec, base: 'mail' }, dek)).rejects.toThrowError(SatelliteConfigError)
    await expect(ensureSatelliteMarker(store, 'v1', { ...spec, joined: 'other' }, dek)).rejects.toThrowError(/R-S9/)
  })
})
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/with-shape/satellites/marker.ts
import type { NoydbStore } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import { SatelliteConfigError } from '../../kernel/errors.js'
import { hashFields } from './validate.js'
import type { PairingMarker, SatelliteSpec } from './types.js'

/**
 * Persist-or-reconcile the pairing marker in `_schemas/<satellite>`.
 * First declaration writes { base, fieldsHash, joined }; later declarations
 * must match exactly or are refused (R-S9). Lazy imports keep the satellite
 * spine tree-shakeable (config-drift.ts pattern).
 */
export async function ensureSatelliteMarker(
  store: NoydbStore, vaultName: string, spec: SatelliteSpec, dek: EnclaveKey,
): Promise<void> {
  const next: PairingMarker = { base: spec.base, fieldsHash: hashFields(spec.fields), joined: spec.joined }
  const { loadPersistedSchema } = await import('../persisted-schemas/storage.js')
  const persisted = await loadPersistedSchema(store, vaultName, spec.satellite, dek)
  const prior = persisted?.satellite
  if (prior) {
    if (prior.base !== next.base || prior.fieldsHash !== next.fieldsHash || (prior.joined ?? null) !== (next.joined ?? null)) {
      throw new SatelliteConfigError(
        `R-S9: satellite "${spec.satellite}" re-declared divergently from its persisted pairing marker ` +
        `(persisted base="${prior.base}" fieldsHash=${prior.fieldsHash}; declared base="${next.base}" fieldsHash=${next.fieldsHash}). ` +
        `Evolve the marker deliberately, don't redeclare.`,
      )
    }
    return
  }
  const { persistSatelliteMarker } = await import('../persisted-schemas/register.js')
  await persistSatelliteMarker({ store, vault: vaultName, collectionName: spec.satellite, dek, marker: next })
}
```

In `persisted-schemas/register.ts`, add `persistSatelliteMarker` by copying `persistClassifiedMarker`'s body verbatim and swapping the merged key to `satellite: marker` (keep its read-merge-CAS-retry shape — that is the #583 race hardening). Add `satellite?: PairingMarker` to the persisted-schema record type where `classified?` is declared.

- [ ] **Step 4: Run** → PASS. Also run the persisted-schemas suite: `pnpm vitest run packages/hub/src/with-shape/persisted-schemas` → no regressions.

- [ ] **Step 5: Commit** — `feat(satellites): #591 persisted pairing marker with R-S9 drift refusal`

---

### Task 3: SatelliteRegistry (pairs, pair mutex, poisoned cross-check)

**Files:**
- Create: `packages/hub/src/with-shape/satellites/registry.ts`
- Test: `packages/hub/src/with-shape/satellites/registry.test.ts`

**Interfaces:**
- Consumes: `SatelliteSpec`, `validateSatelliteDeclaration` (Task 1).
- Produces (used by Tasks 4–9, 11–12):

```ts
class SatelliteRegistry {
  register(spec: SatelliteSpec): void                        // R-S1 one-satellite-per-base + name collisions (R-S5)
  satelliteOf(base: string): SatelliteSpec | null
  bysatellite(name: string): SatelliteSpec | null
  byJoined(name: string): SatelliteSpec | null
  isPairMember(name: string): boolean
  expandNames(names: readonly string[]): string[]            // pair-unit filter expansion (sync)
  poison(satellite: string, reason: string): void            // async cross-check failure → next write throws
  assertNotPoisoned(satellite: string): void
  withPairLock<R>(base: string, fn: () => Promise<R>): Promise<R>  // per-base async mutex
  allSpecs(): readonly SatelliteSpec[]
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/hub/src/with-shape/satellites/registry.test.ts
import { describe, it, expect } from 'vitest'
import { SatelliteRegistry } from './registry.js'

const spec = { base: 'msgs', satellite: 'msgs_text', fields: ['body'] as const, joined: 'msgs_full' }

describe('SatelliteRegistry', () => {
  it('registers a pair and resolves by base, satellite, and joined name', () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    expect(r.satelliteOf('msgs')?.satellite).toBe('msgs_text')
    expect(r.bySatellite('msgs_text')?.base).toBe('msgs')
    expect(r.byJoined('msgs_full')?.base).toBe('msgs')
    expect(r.isPairMember('msgs')).toBe(true)
  })

  it('R-S1(v1): refuses a second satellite on the same base', () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    expect(() => r.register({ base: 'msgs', satellite: 'msgs_att', fields: ['att'] })).toThrowError(/R-S1/)
  })

  it('R-S5: refuses a joined name that collides with any registered collection role', () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    expect(() => r.register({ base: 'docs', satellite: 'docs_body', fields: ['b'], joined: 'msgs_text' }))
      .toThrowError(/R-S5/)
  })

  it('poison → assertNotPoisoned throws with the recorded reason', () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    r.poison('msgs_text', 'R-S1: fields overlap base schema field "subject"')
    expect(() => r.assertNotPoisoned('msgs_text')).toThrowError(/R-S1.*subject/)
  })

  it('withPairLock serializes concurrent sections per base', async () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    const order: number[] = []
    await Promise.all([
      r.withPairLock('msgs', async () => { order.push(1); await new Promise(res => setTimeout(res, 20)); order.push(2) }),
      r.withPairLock('msgs', async () => { order.push(3) }),
    ])
    expect(order).toEqual([1, 2, 3])
  })

  it('expandNames adds satellites of named bases (and vice versa) without duplicates', () => {
    const r = new SatelliteRegistry()
    r.register(spec)
    expect(r.expandNames(['msgs', 'other']).sort()).toEqual(['msgs', 'msgs_text', 'other'])
    expect(r.expandNames(['msgs_text']).sort()).toEqual(['msgs', 'msgs_text'])
  })
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/hub/src/with-shape/satellites/registry.ts
import { SatelliteConfigError } from '../../kernel/errors.js'
import type { SatelliteSpec } from './types.js'

export class SatelliteRegistry {
  private readonly byBase = new Map<string, SatelliteSpec>()
  private readonly bySat = new Map<string, SatelliteSpec>()
  private readonly byJoin = new Map<string, SatelliteSpec>()
  private readonly poisoned = new Map<string, string>()
  private readonly locks = new Map<string, Promise<unknown>>()

  register(spec: SatelliteSpec): void {
    if (this.byBase.has(spec.base)) {
      throw new SatelliteConfigError(`R-S1: base "${spec.base}" already has satellite "${this.byBase.get(spec.base)!.satellite}" — v1 allows exactly one satellite per base.`)
    }
    const taken = (n: string) => this.byBase.has(n) || this.bySat.has(n) || this.byJoin.has(n)
    if (spec.joined !== undefined && taken(spec.joined)) {
      throw new SatelliteConfigError(`R-S5: joined name "${spec.joined}" collides with an existing pair member or joined name.`)
    }
    this.byBase.set(spec.base, spec)
    this.bySat.set(spec.satellite, spec)
    if (spec.joined !== undefined) this.byJoin.set(spec.joined, spec)
  }

  satelliteOf(base: string): SatelliteSpec | null { return this.byBase.get(base) ?? null }
  bySatellite(name: string): SatelliteSpec | null { return this.bySat.get(name) ?? null }
  byJoined(name: string): SatelliteSpec | null { return this.byJoin.get(name) ?? null }
  isPairMember(name: string): boolean { return this.byBase.has(name) || this.bySat.has(name) }
  allSpecs(): readonly SatelliteSpec[] { return [...this.byBase.values()] }

  expandNames(names: readonly string[]): string[] {
    const out = new Set(names)
    for (const n of names) {
      const asBase = this.byBase.get(n); if (asBase) out.add(asBase.satellite)
      const asSat = this.bySat.get(n); if (asSat) out.add(asSat.base)
    }
    return [...out]
  }

  poison(satellite: string, reason: string): void { this.poisoned.set(satellite, reason) }
  assertNotPoisoned(satellite: string): void {
    const reason = this.poisoned.get(satellite)
    if (reason !== undefined) throw new SatelliteConfigError(reason)
  }

  /** Per-base async mutex: chains sections on a stored promise tail. */
  async withPairLock<R>(base: string, fn: () => Promise<R>): Promise<R> {
    const tail = this.locks.get(base) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(res => { release = res })
    this.locks.set(base, tail.then(() => gate))
    await tail
    try { return await fn() } finally { release() }
  }
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(satellites): #591 pairing registry with pair mutex, poison state, name-collision refusals`

---

### Task 4: Vault registration wiring (thin kernel call-site)

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` — (a) private field `satelliteRegistry: SatelliteRegistry | null = null` + lazy getter; (b) inside `collection()` **after** the reserved-name guards (~line 878, after the `isSecretBearingReservedCollection` guard) and before the cache lookup, add the registration block below; (c) a guard rejecting `collection(<joinedName>)` with a pointer to `vault.joined()`.
- Test: `packages/hub/src/with-shape/satellites/registration.test.ts` (drives everything through the public `createNoydb`/`openVault` API with `to-memory` — find the canonical fixture with `grep -rn "createNoydb" packages/hub/src/kernel/vault*.test.ts | head` and copy it).

**Interfaces:**
- Consumes: Tasks 1–3. **Static import into vault.ts is allowed for the thin seam** (matches links/i18n precedent — `vault.ts:86-100`); the heavy modules (marker/fanout/joined) are dynamic-imported from within `with-shape/satellites` itself.
- Produces: declaring `collection('msgs_text', { satelliteOf: 'msgs', fields, joined })` registers the pair, persists the marker (fire-and-forget with poison-on-mismatch), runs R-S7 and the async R-S1/R-S5 cross-check.

- [ ] **Step 1: Write the failing tests** (public-API level):

```ts
// packages/hub/src/with-shape/satellites/registration.test.ts
// Fixture: createNoydb({ store: toMemory(), user, encryption on }) → openVault('v1')
import { describe, it, expect } from 'vitest'
import { SatelliteConfigError } from '../../kernel/errors.js'

describe('satellite declaration wiring', () => {
  it('registers the pair; base and satellite behave as plain collections for writes', async () => {
    const vault = await openTestVault()
    vault.collection('msgs', {})
    vault.collection('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'], joined: 'msgs_full' })
    await vault.collection('msgs').put('x', { from: 'a', subject_short: 's' })
    // No auto-created satellite envelope (audit reversal):
    expect(await rawStore.get('v1', 'msgs_text', 'x')).toBeNull()
  })

  it('R-S3: refuses satelliteOf pointing at a registered satellite', async () => {
    const vault = await openTestVault()
    vault.collection('msgs_text', { satelliteOf: 'msgs', fields: ['body'] })
    expect(() => vault.collection('deep', { satelliteOf: 'msgs_text', fields: ['x'] }))
      .toThrowError(/R-S3/)
  })

  it('R-S7: refuses a satellite without perRecordKeys when the base is forget-covered', async () => {
    const vault = await openTestVault({ forgetStrategy: withForgetCascade({ subjects: { msgs: 'from' } }) })
    expect(() => vault.collection('msgs_text', { satelliteOf: 'msgs', fields: ['body'] }))
      .toThrowError(/R-S7/)
    // With perRecordKeys it registers fine:
    expect(() => vault.collection('msgs_text2', { satelliteOf: 'msgs', fields: ['body'], perRecordKeys: true }))
      .not.toThrow()
  })

  it('rejects vault.collection(<joinedName>) with a pointer to vault.joined()', async () => {
    const vault = await openTestVault()
    vault.collection('msgs_text', { satelliteOf: 'msgs', fields: ['body'], joined: 'msgs_full' })
    expect(() => vault.collection('msgs_full')).toThrowError(/vault\.joined/)
  })

  it('poisons the satellite when the async fields-vs-schema cross-check finds overlap (R-S1)', async () => {
    const vault = await openTestVault()
    vault.collection('msgs', { schema: zodSchemaWith({ subject: true, from: true }) }) // zod-4: subject derivable on base
    vault.collection('msgs_text', { satelliteOf: 'msgs', fields: ['subject', 'body'] })
    await vi.waitFor(async () => {
      await expect(vault.collection('msgs_text').put('x', { subject: 's' })).rejects.toThrowError(/R-S1/)
    })
  })
})
```

- [ ] **Step 2: Run** → FAIL (options ignored today).

- [ ] **Step 3: Implement** — vault.ts block (target ≤ 30 lines; static imports of `SatelliteRegistry`, `validateSatelliteDeclaration`, `SatelliteConfigError` types at top):

```ts
    // Satellite pairing (spec #591, archetype-③). Thin call-site: validation,
    // marker persistence, and cross-checks all live in with-shape/satellites.
    if (this.satelliteRegistry?.byJoined(collectionName)) {
      throw new SatelliteConfigError(
        `"${collectionName}" is a joined handle — use vault.joined('${collectionName}'), not vault.collection().`)
    }
    if (options?.satelliteOf !== undefined) {
      const reg = (this.satelliteRegistry ??= new SatelliteRegistry())
      const spec = validateSatelliteDeclaration({
        satellite: collectionName, satelliteOf: options.satelliteOf,
        fields: options.fields, joined: options.joined,
        baseIsSatellite: reg.bySatellite(options.satelliteOf) !== null,
        crdtMode: options.crdtMode === true,
      })
      if (this.forgetStrategy.subjects[spec.base] !== undefined && options.perRecordKeys !== true) {
        throw new SatelliteConfigError(
          `R-S7: satellite "${collectionName}" of forget-covered base "${spec.base}" must declare perRecordKeys ` +
          `(the heavy fields must get the strong shred). Retro-coverage additionally requires a CEK migration.`)
      }
      reg.register(spec)
      // Fire-and-forget: marker reconcile (R-S9) + fields-vs-derivable-schema
      // cross-check (R-S1/R-S5) poison the satellite instead of throwing async.
      void import('../with-shape/satellites/post-register.js')
        .then(m => m.postRegister(this.adapter, this.name, spec, this.getDEK, options?.schema, reg))
    }
```

Create `packages/hub/src/with-shape/satellites/post-register.ts`:

```ts
import type { NoydbStore } from '../../kernel/types.js'
import type { SatelliteSpec } from './types.js'
import type { SatelliteRegistry } from './registry.js'
import { ensureSatelliteMarker } from './marker.js'

/** Async post-registration: R-S9 marker reconcile + R-S1/R-S5 derivable-schema cross-check. Failures poison, never throw. */
export async function postRegister(
  store: NoydbStore, vaultName: string, spec: SatelliteSpec,
  getDEK: () => Promise<import('../../kernel/enclave/index.js').EnclaveKey>,
  baseSchema: unknown, registry: SatelliteRegistry,
): Promise<void> {
  try {
    await ensureSatelliteMarker(store, vaultName, spec, await getDEK())
  } catch (err) {
    registry.poison(spec.satellite, (err as Error).message); return
  }
  if (baseSchema !== undefined) {
    try {
      const { derivePersistedSchema } = await import('../persisted-schemas/derive.js')
      const envelope = await derivePersistedSchema(baseSchema)
      const baseFields: string[] = Object.keys(envelope?.jsonSchema?.properties ?? {})
      const overlap = spec.fields.filter(f => baseFields.includes(f))
      if (overlap.length > 0) {
        registry.poison(spec.satellite,
          `R-S1: satellite "${spec.satellite}" fields overlap the base schema: ${overlap.join(', ')} — routing must be unambiguous.`)
      }
    } catch { /* non-derivable validator → cross-check unavailable, by design (spec R-S5) */ }
  }
}
```

Note for the implementer: `getDEK` and the exact `derivePersistedSchema` return shape must be taken from the existing call-sites (`vault.ts:2239` uses `this.getDEK`; `with-shape/introspection/describe.ts:126` shows the envelope shape). Adjust the two property accesses to match — the test in Step 1 is the arbiter.

- [ ] **Step 4: Run** → PASS. Then `wc -l packages/hub/src/kernel/vault.ts` — record the count; must be ≤ 3938 (budget).
- [ ] **Step 5: Commit** — `feat(satellites): #591 vault registration wiring — R-S7 gate, marker + cross-check via poison state`

---

### Task 5: Satellite read/write proxy (existence authority + R-S6)

**Files:**
- Create: `packages/hub/src/with-shape/satellites/existence.ts`, `packages/hub/src/with-shape/satellites/proxy.ts`
- Test: `packages/hub/src/with-shape/satellites/proxy.test.ts`
- Modify: `packages/hub/src/kernel/vault.ts` — in `collection()`, after the collection is constructed/cached, wrap: `if (this.satelliteRegistry?.bySatellite(collectionName)) return makeSatelliteProxy(coll, spec, baseAccessor, this.satelliteRegistry) as Collection<T,S,Q,M>` (≤ 5 lines; `baseAccessor = () => this.collection(spec.base)`).

**Interfaces:**
- Consumes: `SatelliteRegistry` (Task 3); raw adapter via the wrapped collection's internals.
- Produces:

```ts
// existence.ts
export function isEnvelopeLive(env: EncryptedEnvelope | null): boolean   // null → false; tombstone (_iv==='' && _data==='') → false
export async function isBaseLive(adapter: NoydbStore, vault: string, base: string, id: string): Promise<boolean>
export async function liveBaseIdSet(adapter: NoydbStore, vault: string, base: string): Promise<Set<string>>
// proxy.ts
export function makeSatelliteProxy<T>(target: Collection<T>, spec: SatelliteSpec,
  base: () => Collection<Record<string, unknown>>, registry: SatelliteRegistry): Collection<T>
```

The proxy is a JS `Proxy` delegating **everything** to the real collection (full ~50-member surface preserved automatically — this is why we don't hand-stub), overriding exactly: `get` (null when base not live — via one *undecrypted* `adapter.get` on the base), `list`/`query` results (filter ids against `liveBaseIdSet`), `put` (R-S6: inside `registry.withPairLock(spec.base, …)` check `isBaseLive` then `registry.assertNotPoisoned` then delegate), `delete` (delegate unchanged — "clear the heavy side" is legal).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/hub/src/with-shape/satellites/proxy.test.ts (public-API fixture from Task 4)
describe('satellite proxy — existence authority + R-S6', () => {
  it('satellite.get returns null when the base row is absent or tombstoned; dead ciphertext remains', async () => {
    const { vault, rawStore } = await openPair()          // msgs / msgs_text(['body'])
    await vault.collection('msgs').put('x', { from: 'a' })
    await vault.collection('msgs_text').put('x', { body: 'B' })
    await rawStore.delete('v1', 'msgs', 'x')              // simulate offline resurrection state
    expect(await vault.collection('msgs_text').get('x')).toBeNull()
    expect(await rawStore.get('v1', 'msgs_text', 'x')).not.toBeNull()  // no sweep
  })

  it('satellite.list/query exclude base-less ids', async () => {
    const { vault, rawStore } = await openPair()
    await vault.collection('msgs').put('a', { from: 'a' }); await vault.collection('msgs_text').put('a', { body: '1' })
    await vault.collection('msgs').put('b', { from: 'b' }); await vault.collection('msgs_text').put('b', { body: '2' })
    await rawStore.delete('v1', 'msgs', 'b')
    expect((await vault.collection('msgs_text').list()).map(r => r.body)).toEqual(['1'])
  })

  it('R-S6: satellite.put with no base record refuses', async () => {
    const { vault } = await openPair()
    await expect(vault.collection('msgs_text').put('ghost', { body: 'B' })).rejects.toThrowError(/R-S6/)
  })

  it('store-shape: satellite.get does one undecrypted base get (spy counts decrypts)', async () => {
    const { vault, spy } = await openPair()
    await vault.collection('msgs').put('x', { from: 'a' })
    await vault.collection('msgs_text').put('x', { body: 'B' })
    spy.reset()
    await vault.collection('msgs_text').get('x')
    expect(spy.gets).toEqual(expect.arrayContaining([['msgs', 'x'], ['msgs_text', 'x']]))
    expect(spy.decryptsFor('msgs')).toBe(0)
  })

  it('the proxy preserves the full Collection surface (describe, count, putMany exist)', async () => {
    const { vault } = await openPair()
    const sat = vault.collection('msgs_text')
    expect(typeof sat.describe).toBe('function')
    expect(typeof sat.putMany).toBe('function')
  })
})
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** existence.ts + proxy.ts:

```ts
// existence.ts
import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
export function isEnvelopeLive(env: EncryptedEnvelope | null): boolean {
  return env !== null && !(env._iv === '' && env._data === '')   // tombstone shape per buildTombstone()
}
export async function isBaseLive(adapter: NoydbStore, vault: string, base: string, id: string): Promise<boolean> {
  return isEnvelopeLive(await adapter.get(vault, base, id))
}
export async function liveBaseIdSet(adapter: NoydbStore, vault: string, base: string): Promise<Set<string>> {
  const ids = await adapter.list(vault, base)
  const out = new Set<string>()
  for (const id of ids) if (await isBaseLive(adapter, vault, base, id)) out.add(id)
  return out
}
```

```ts
// proxy.ts — overriding handler; everything else falls through to the target.
import { SatelliteConfigError } from '../../kernel/errors.js'
import { isBaseLive, liveBaseIdSet } from './existence.js'
import type { SatelliteSpec } from './types.js'
import type { SatelliteRegistry } from './registry.js'

export function makeSatelliteProxy(target: any, spec: SatelliteSpec, registry: SatelliteRegistry): any {
  const adapter = target.adapter; const vaultName = target.vault   // same internals putManyAtomic uses (collection.ts:3223)
  const overrides: Record<string, unknown> = {
    async get(id: string) {
      if (!(await isBaseLive(adapter, vaultName, spec.base, id))) return null
      return target.get(id)
    },
    async list() {
      const live = await liveBaseIdSet(adapter, vaultName, spec.base)
      return (await target.list()).filter((r: any) => live.has(r.id))
    },
    async put(id: string, record: unknown) {
      registry.assertNotPoisoned(spec.satellite)
      return registry.withPairLock(spec.base, async () => {
        if (!(await isBaseLive(adapter, vaultName, spec.base, id))) {
          throw new SatelliteConfigError(`R-S6: satellite "${spec.satellite}" put for "${id}" with no live base record in "${spec.base}" — create the base first (or write through the joined handle).`)
        }
        return target.put(id, record)
      })
    },
  }
  return new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop]
      const v = Reflect.get(t, prop, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}
```

Note: `query()` filtering — inspect how `query()` executes (`kernel/query/builder.ts`); if its terminal methods call `list()`/`snapshot()` on the collection, the `list` override covers it; otherwise add a `query` override that post-filters terminal results the same way. The Step 1 list/query test is the arbiter. Records carry `id` in decoded form (the join layer relies on `readPath(record,'id')` — `join.ts:hashJoin`), so filtering on `r.id` is sound.

- [ ] **Step 4: Run** → PASS. `wc -l` vault.ts within budget.
- [ ] **Step 5: Commit** — `feat(satellites): #591 satellite proxy — existence-filtered reads, R-S6 under pair mutex`

---

### Task 6: Fan-out writes with revert hardening (`fanout.ts` + sync/kernel seams)

**Files:**
- Create: `packages/hub/src/with-shape/satellites/fanout.ts`
- Test: `packages/hub/src/with-shape/satellites/fanout.test.ts`
- Modify: `packages/hub/src/with-party/team/sync.ts` — add method (below `trackChange`, ~line 119):

```ts
  /** Remove a dirty entry (satellite fan-out revert cleanup — spec #591). */
  async removeDirty(collection: string, id: string): Promise<void> {
    const before = this.dirty.length
    this.dirty = this.dirty.filter(d => !(d.collection === collection && d.id === id))
    if (this.dirty.length !== before) await this.persistMeta()
  }
```

- Modify: `packages/hub/src/kernel/collection.ts` — one internal seam (≤ 6 lines, inside the class near `_invalidateCacheEntry`):

```ts
  /** @internal Satellite fan-out revert cleanup: drop the sync dirty entry and re-announce the restored state. */
  async _compensateRevertedWrite(id: string): Promise<void> {
    await this._invalidateCacheEntry(id)
    await this.syncTracker?.removeDirty?.(this.name, id)   // use the actual onDirty/sync field name at collection.ts:2192
    this.emitChange?.(id, 'revert')                        // use the actual emitter invoked at collection.ts:2194-2199
  }
```

(The two field names must be read off `collection.ts:2192-2199` — the anchor lines the audit verified; wire to whatever is invoked there.)

**Interfaces:**
- Consumes: registry pair lock (Task 3); `revertExecuted(executed, adapter)` (`with-commit/tx/transaction.ts:610`) — **do not import from with-commit** (it's a gated service); `fanout.ts` re-implements the 8-line restore loop locally (raw `adapter.put(prior)` / `adapter.delete`), which is the pattern-reuse the spec pins.
- Produces:

```ts
export async function joinedPut<T>(deps: FanoutDeps, id: string, record: T): Promise<void>   // split → validate both → base leg → satellite leg → revert+compensate on failure
export async function pairDelete(deps: FanoutDeps, id: string): Promise<void>                // satellite leg first → base leg → revert+compensate on failure
export interface FanoutDeps {
  spec: SatelliteSpec
  base: () => any; satellite: () => any                    // Collection accessors (satellite = the UNPROXIED target for internal writes)
  adapter: NoydbStore; vaultName: string
  registry: SatelliteRegistry
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// fanout.test.ts (public fixture; failure injection via a spy store that can be armed to fail the Nth put)
describe('joined fan-out', () => {
  it('splits by the fields routing table and writes base leg first', async () => {
    const { vault, spy } = await openPair()               // fields: ['subject','body']
    await vault.joined('msgs_full').put('x', { from: 'a', subject: 's', body: 'B' })
    expect(spy.putOrder).toEqual([['msgs', 'x'], ['msgs_text', 'x']])
    expect(await vault.collection('msgs').get('x')).toEqual({ from: 'a' })
    expect((await vault.collection('msgs_text').get('x'))?.body).toBe('B')
  })

  it('pre-validates both legs: an invalid satellite field aborts with ZERO adapter writes', async () => {
    const { vault, spy } = await openPair({ satelliteSchema: zodRequiring({ body: 'string' }) })
    await expect(vault.joined('msgs_full').put('x', { from: 'a', body: 42 })).rejects.toThrow()
    expect(spy.putOrder).toEqual([])
  })

  it('satellite-leg adapter failure: base leg reverted, compensating change emitted, no dirty entry survives', async () => {
    const { vault, spy, dirtyLog, changes } = await openPair()
    spy.failNextPutFor('msgs_text')
    await expect(vault.joined('msgs_full').put('x', { from: 'a', body: 'B' })).rejects.toThrow()
    expect(await spy.raw.get('v1', 'msgs', 'x')).toBeNull()          // prior (absent) restored
    expect(dirtyLog.entriesFor('msgs', 'x')).toEqual([])             // dirty entry removed
    expect(changes.last('msgs')).toMatchObject({ id: 'x', kind: 'revert' })
  })

  it('pair delete removes the satellite leg first; failure reverts', async () => {
    const { vault, spy } = await openPair()
    await vault.joined('msgs_full').put('x', { from: 'a', body: 'B' })
    spy.reset()
    await vault.collection('msgs').delete('x')
    expect(spy.deleteOrder).toEqual([['msgs_text', 'x'], ['msgs', 'x']])
    spyRearm: {
      await vault.joined('msgs_full').put('y', { from: 'b', body: 'C' })
      spy.failNextDeleteFor('msgs')
      await expect(vault.collection('msgs').delete('y')).rejects.toThrow()
      expect(await spy.raw.get('v1', 'msgs_text', 'y')).not.toBeNull() // satellite restored
    }
  })
})
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```ts
// fanout.ts
import { SatelliteConfigError } from '../../kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import type { SatelliteSpec } from './types.js'
import type { SatelliteRegistry } from './registry.js'

export interface FanoutDeps {
  spec: SatelliteSpec
  base: () => any; satellite: () => any
  adapter: NoydbStore; vaultName: string
  registry: SatelliteRegistry
}

type Leg = { coll: string; id: string; prior: EncryptedEnvelope | null; wasDelete: boolean; handle: any }

async function revertAndCompensate(deps: FanoutDeps, executed: Leg[]): Promise<void> {
  for (const leg of [...executed].reverse()) {
    try {
      if (leg.prior !== null) await deps.adapter.put(deps.vaultName, leg.coll, leg.id, leg.prior)
      else await deps.adapter.delete(deps.vaultName, leg.coll, leg.id)
    } catch { /* best-effort, matches revertExecuted semantics */ }
    await leg.handle._compensateRevertedWrite(leg.id)
  }
}

export async function joinedPut(deps: FanoutDeps, id: string, record: Record<string, unknown>): Promise<void> {
  deps.registry.assertNotPoisoned(deps.spec.satellite)
  const satFields = new Set(deps.spec.fields)
  const baseRec: Record<string, unknown> = {}; const satRec: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) (satFields.has(k) ? satRec : baseRec)[k] = v
  // Pre-validate BOTH legs before any adapter write (audit hardening).
  await deps.base()._preflightValidate?.(baseRec)
  await deps.satellite()._preflightValidate?.(satRec)
  return deps.registry.withPairLock(deps.spec.base, async () => {
    const executed: Leg[] = []
    const run = async (handle: any, coll: string, rec: Record<string, unknown>) => {
      executed.push({ coll, id, prior: await deps.adapter.get(deps.vaultName, coll, id), wasDelete: false, handle })
      await handle.put(id, rec)
    }
    try {
      await run(deps.base(), deps.spec.base, baseRec)          // base leg FIRST (convergence rule 3)
      await run(deps.satellite(), deps.spec.satellite, satRec)
    } catch (err) {
      await revertAndCompensate(deps, executed)
      throw err
    }
  })
}

export async function pairDelete(deps: FanoutDeps, id: string): Promise<void> {
  return deps.registry.withPairLock(deps.spec.base, async () => {
    const executed: Leg[] = []
    const run = async (handle: any, coll: string) => {
      executed.push({ coll, id, prior: await deps.adapter.get(deps.vaultName, coll, id), wasDelete: true, handle })
      await handle.delete(id)
    }
    try {
      await run(deps.satellite(), deps.spec.satellite)         // satellite leg FIRST (convergence rule 3)
      await run(deps.base(), deps.spec.base)
    } catch (err) {
      await revertAndCompensate(deps, executed)
      throw err
    }
  })
}
```

`_preflightValidate` seam: add to collection.ts **only if** a public validation entry doesn't already exist — check first (`grep -n "validate" packages/hub/src/kernel/collection.ts | head -20`); the schema-validation call inside `put()` (see `kernel/schema.ts` header contract) is the body to extract into a ≤4-line internal method. This is inside the collection.ts +6 budget together with `_compensateRevertedWrite`.

Base-delete fan-out wiring: in vault.ts `collection()`, when `this.satelliteRegistry?.satelliteOf(collectionName)` exists, wrap the returned handle's `delete` via a tiny override (same Proxy technique as Task 5, or fold into the satellite proxy module as `makeBaseProxy(target, spec, deps)` with the single `delete` override calling `pairDelete`). Keep it in `proxy.ts`.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(satellites): #591 ordered fan-out with revert hardening (pre-validated legs, dirty cleanup, compensating events)`

---

### Task 7: JoinedHandle + `vault.joined()`

**Files:**
- Create: `packages/hub/src/with-shape/satellites/joined.ts`
- Test: `packages/hub/src/with-shape/satellites/joined.test.ts`
- Modify: `packages/hub/src/kernel/vault.ts` — add public method (≤ 10 lines):

```ts
  /** Full-record handle for a satellite pair registered with `joined:` (spec #591). Narrow type — not a Collection. */
  joined<T extends Record<string, unknown>>(name: string): JoinedHandle<T> {
    const spec = this.satelliteRegistry?.byJoined(name)
    if (!spec) throw new SatelliteConfigError(`No joined handle "${name}" is registered — declare it via collection(satellite, { joined: '${name}' }).`)
    return makeJoinedHandle<T>(spec, {
      base: () => this.collection(spec.base), satellite: () => this.collection(spec.satellite),
      adapter: this.adapter, vaultName: this.name, registry: this.satelliteRegistry!,
    })
  }
```

**Interfaces:**
- Consumes: `joinedPut`/`pairDelete` (Task 6), `isBaseLive` (Task 5), `JoinedHandle<T>` (Task 1).
- Produces: `makeJoinedHandle<T>(spec, deps): JoinedHandle<T>`.

- [ ] **Step 1: Write the failing tests**

```ts
// joined.test.ts
describe('JoinedHandle', () => {
  it('get merges base ⊕ satellite; absent satellite reads all-null for declared fields', async () => {
    const { vault } = await openPair()                     // fields ['subject','body']
    await vault.collection('msgs').put('x', { from: 'a' })
    expect(await vault.joined('msgs_full').get('x')).toEqual({ from: 'a', subject: null, body: null })
    await vault.collection('msgs_text').put('x', { subject: 's', body: 'B' })
    expect(await vault.joined('msgs_full').get('x')).toEqual({ from: 'a', subject: 's', body: 'B' })
  })

  it('get returns null when the base is absent or tombstoned, even if a satellite envelope exists', async () => {
    const { vault, rawStore } = await openPair()
    await vault.joined('msgs_full').put('x', { from: 'a', body: 'B' })
    await rawStore.delete('v1', 'msgs', 'x')
    expect(await vault.joined('msgs_full').get('x')).toBeNull()
  })

  it('delete removes the pair (delegates to pairDelete, satellite first)', async () => {
    const { vault, spy } = await openPair()
    await vault.joined('msgs_full').put('x', { from: 'a', body: 'B' })
    spy.reset()
    await vault.joined('msgs_full').delete('x')
    expect(spy.deleteOrder).toEqual([['msgs_text', 'x'], ['msgs', 'x']])
  })

  it('describe() works and unions both sides fields (UI contract); no narrow member is undefined', async () => {
    const { vault } = await openPair()
    const d = await vault.joined('msgs_full').describe()
    const names = d.fields.map(f => f.name)
    expect(names).toEqual(expect.arrayContaining(['from', 'subject', 'body']))
    for (const m of ['get', 'put', 'delete', 'list', 'describe'] as const)
      expect(typeof vault.joined('msgs_full')[m]).toBe('function')
  })

  it('list returns merged records for live-base ids only', async () => { /* mirror of proxy list test through joined */ })

  it('reactive API names are simply absent from the type (compile-time) and not present at runtime', async () => {
    expect((vault.joined('msgs_full') as any).subscribe).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

```ts
// joined.ts
import type { JoinedHandle, SatelliteSpec } from './types.js'
import type { FanoutDeps } from './fanout.js'
import { joinedPut, pairDelete } from './fanout.js'
import { isBaseLive, liveBaseIdSet } from './existence.js'

export function makeJoinedHandle<T extends Record<string, unknown>>(spec: SatelliteSpec, deps: FanoutDeps): JoinedHandle<T> {
  const nullSat = (): Record<string, null> => Object.fromEntries(spec.fields.map(f => [f, null]))
  const merge = (base: Record<string, unknown>, sat: Record<string, unknown> | null): T =>
    ({ ...nullSat(), ...(sat ?? {}), ...base }) as T   // disjoint by R-S1; base spread last is inert on satellite fields
  return {
    async get(id) {
      if (!(await isBaseLive(deps.adapter, deps.vaultName, spec.base, id))) return null
      const base = await deps.base().get(id)
      if (base === null) return null
      const sat = await deps.satellite().get(id)     // proxied handle: already existence-safe
      return merge(base, sat)
    },
    async put(id, record) { await joinedPut(deps, id, record as Record<string, unknown>) },
    async delete(id) { await pairDelete(deps, id) },
    async list() {
      const live = await liveBaseIdSet(deps.adapter, deps.vaultName, spec.base)
      const bases: Record<string, unknown>[] = (await deps.base().list()).filter((r: any) => live.has(r.id))
      const out: T[] = []
      for (const b of bases) out.push(merge(b, await deps.satellite().get((b as any).id)))
      return out
    },
    async describe() {
      const [b, s] = await Promise.all([deps.base().describe({}), deps.satellite().describe({})])
      return { ...b, name: spec.joined ?? `${spec.base}+${spec.satellite}`, fields: [...b.fields, ...s.fields] }
    },
  }
}
```

(`describe()` return shape: match `CollectionDescription` from `with-shape/introspection/describe.ts:76` — adjust spread keys to its actual required members; the test asserts the fields union only.)

- [ ] **Step 4: Run** → PASS. vault.ts line budget check.
- [ ] **Step 5: Commit** — `feat(satellites): #591 JoinedHandle + vault.joined() accessor (narrow type, working describe)`

---

### Task 8: Forget integration (synthesized refs, classification inheritance, R-S4)

**Files:**
- Modify: `packages/hub/src/kernel/vault.ts` `forget()` — two anchored edits:
  1. After `const refs = await lookupSubject(…)` (~line 2276): expand refs.
  2. The `perRecordKeys` derivation (~line 2296): honor inheritance.
- Test: `packages/hub/src/with-shape/satellites/forget.test.ts`

**Interfaces:**
- Consumes: registry (Task 3). The synthesized ref carries `satelliteOf` so downstream classification can inherit.

- [ ] **Step 1: Write the failing tests**

```ts
// forget.test.ts (fixture: withForgetCascade({ subjects: { msgs: 'from' } }), perRecordKeys on both members per R-S7)
describe('forget fan-out through the full purge suite', () => {
  it('shreds the satellite via a synthesized ref (never in the subject index)', async () => {
    const { vault, rawStore } = await openForgetPair()
    await vault.joined('msgs_full').put('x', { from: 'alice@x', subject: 's', body: 'SECRET' })
    const result = await vault.forget('alice@x')
    expect(result.recordsShredded).toBe(2)                       // base + satellite
    const satEnv = await rawStore.get('v1', 'msgs_text', 'x')
    expect(satEnv?._data).toBe('')                               // tombstoned, not merely deleted
  })

  it('purges the satellite search index postings for the shredded body', async () => {
    const { vault, rawStore } = await openForgetPair({ satelliteSearch: ['subject', 'body'] })
    await vault.joined('msgs_full').put('x', { from: 'alice@x', subject: 's', body: 'zebra unique' })
    await vault.forget('alice@x')
    expect(await searchSatellite(vault, 'zebra')).toEqual([])    // _ftindex purged via the same per-ref suite
  })

  it('classification inheritance: an unmigrated (no-_cek) satellite record is REPORTED in unmigratedRecords', async () => {
    const { vault, rawStore } = await openForgetPair()
    await vault.joined('msgs_full').put('x', { from: 'alice@x', body: 'B' })
    await stripCek(rawStore, 'v1', 'msgs_text', 'x')             // forge legacy shared-DEK record
    const result = await vault.forget('alice@x')
    expect(result.unmigratedRecords).toContain('msgs_text:x')
  })

  it('R-S4: a satellite ref that cannot be processed fails the forget loudly', async () => {
    const { vault, spy } = await openForgetPair()
    await vault.joined('msgs_full').put('x', { from: 'alice@x', body: 'B' })
    spy.failNextPutFor('msgs_text')                              // tombstone write fails
    await expect(vault.forget('alice@x')).rejects.toThrowError(/R-S4/)
  })
})
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — vault.ts, after ref resolution (~2276):

```ts
    // Satellite fan-out (spec #591): synthesize a same-id ref for every base
    // ref whose collection has a declared satellite, INTO THE SAME refs list —
    // the whole per-ref purge suite below must traverse it (indexes, history,
    // blobs, sealed, vectors), not just the envelope tombstone.
    const satRefs = this.satelliteRegistry
      ? refs.flatMap(ref => {
          const spec = this.satelliteRegistry!.satelliteOf(ref.collection)
          return spec ? [{ collection: spec.satellite, id: ref.id, satelliteOf: ref.collection }] : []
        })
      : []
    const allRefs = [...refs, ...satRefs]
```

Then the loop iterates `allRefs`, and the classification line (~2296) becomes:

```ts
      const perRecordKeys =
        this.forgetStrategy.subjects[(ref as { satelliteOf?: string }).satelliteOf ?? ref.collection] !== undefined
```

R-S4 fail-loud: the existing loop's per-ref error handling must NOT swallow a synthesized-ref failure — wrap the satellite ref's `_writeTombstone` call site so an error rethrows as `SatelliteConfigError('R-S4: forget could not fan out to satellite "…" — aborting rather than leaving the heavy side', { cause })`. Read the loop's current try/catch topology first (vault.ts:2294-2420) and place the rethrow so base refs keep the existing resilient semantics.

- [ ] **Step 4: Run** → PASS. Also run the whole existing forget suite (`pnpm vitest run packages/hub/src/with-audit`) → no regressions.
- [ ] **Step 5: Commit** — `feat(satellites): #591 forget fan-out — synthesized refs through the full purge suite, residue classification inheritance, R-S4`

---

### Task 9: Search `retrieve()` existence post-filter

**Files:**
- Modify: `packages/hub/src/with-lookup/search/collection-facade.ts` — where `retrieve()` materializes hits, post-filter satellite hits by base liveness.
- Test: `packages/hub/src/with-shape/satellites/search-filter.test.ts`

**Interfaces:**
- Consumes: `liveBaseIdSet` (Task 5); the registry via the facade's collection reference (the facade holds the collection/vault context — locate its constructor injections first: `grep -n "constructor" packages/hub/src/with-lookup/search/collection-facade.ts`). Inject an optional `existenceFilter?: (ids: readonly string[]) => Promise<Set<string>>` supplied at facade construction when the collection is a registered satellite (wired where the vault builds the facade).

- [ ] **Step 1: Failing test:** index `body` on the satellite; write pair; raw-delete the base; `retrieve('zebra')` on the satellite returns `[]` while the posting physically remains (spy store shows the `_ftindex` blob untouched).

```ts
it('satellite search hits are filtered to live-base ids', async () => {
  const { vault, rawStore } = await openPair({ satelliteSearch: ['body'] })
  await vault.joined('msgs_full').put('x', { from: 'a', body: 'zebra unique' })
  await rawStore.delete('v1', 'msgs', 'x')
  expect(await vault.collection('msgs_text').search('zebra')).toEqual([])
})
```

- [ ] **Step 2: Run** → FAIL (hit returned).
- [ ] **Step 3: Implement:** in the facade's hit-materialization path: `if (this.existenceFilter) { const live = await this.existenceFilter(hitIds); hits = hits.filter(h => live.has(h.id)) }`. Wire `existenceFilter` in vault.ts where the search facade/strategy binds the collection (find with `grep -n "searchIndexStore\|collection-facade" packages/hub/src/kernel/*.ts`) — for satellites pass `(ids) => liveBaseIdSet(adapter, vaultName, spec.base)` narrowed to the queried ids.
- [ ] **Step 4: Run** → PASS + existing search suite green.
- [ ] **Step 5: Commit** — `feat(satellites): #591 search retrieve post-filter to live-base ids`

---

### Task 10: Bundle export dead-satellite filter

**Files:**
- Modify: `packages/hub/src/with-pod/bundle.ts` — in the export record loop where `collectionsFilter` / `_ts` / `_tier` filters run (~lines 1058-1134), add a satellite-liveness filter.
- Test: `packages/hub/src/with-shape/satellites/bundle-filter.test.ts`

- [ ] **Step 1: Failing test:** create a pair, write both sides, raw-delete the base, export a bundle → the bundle's `msgs_text` records exclude `x`; a live pair exports both.

```ts
it('as-noydb bundle export skips satellite envelopes whose base is absent/tombstoned', async () => {
  const { vault, rawStore, db } = await openPair()
  await vault.joined('msgs_full').put('x', { from: 'a', body: 'B' })
  await vault.joined('msgs_full').put('y', { from: 'b', body: 'C' })
  await rawStore.delete('v1', 'msgs', 'x')
  const bundle = await exportBundle(db, 'v1')
  expect(recordIds(bundle, 'msgs_text')).toEqual(['y'])
  expect(recordIds(bundle, 'msgs')).toEqual(['y'])
})
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement:** bundle.ts already iterates per collection with envelope-level filters. Before the loop, build `const satLive = new Map<string, Set<string>>()` — for each registered satellite spec (registry reachable from the vault/db handle the export receives; if the export path only has the raw store, read the pairing markers from `_schemas` via `readSatelliteMarker` instead — pick whichever the existing call signature supports, marker-read is the fallback that always works), `satLive.set(spec.satellite, await liveBaseIdSet(store, vaultName, spec.base))`. In the record loop: `const live = satLive.get(collName); if (live && !live.has(id)) continue`.
- [ ] **Step 4: Run** → PASS + with-pod suite green.
- [ ] **Step 5: Commit** — `feat(satellites): #591 bundle export excludes dead-ciphertext satellites`

---

### Task 11: Sync pair-expansion + resolver mirroring

**Files:**
- Modify: `packages/hub/src/with-party/team/sync.ts` —
  1. Optional engine field `pairExpander?: (names: readonly string[]) => readonly string[]` (settable via a new `setPairExpander()` method; wired from vault registration in Task 4's block: `this.syncEngine?.setPairExpander?.(names => reg.expandNames(names))` — find the vault→engine reference with `grep -n "syncEngine\|SyncEngine" packages/hub/src/kernel/vault.ts | head`).
  2. In `push()` (~line 134) and `pull()` (~line 226): expand the filter before the membership test: `const filter = options?.collections ? new Set(this.pairExpander?.(options.collections) ?? options.collections) : null`.
  3. In `registerConflictResolver` (~line 90): `for (const n of this.pairExpander?.([collection]) ?? [collection]) this.conflictResolvers.set(n, resolver)` — registering for one pair member registers for both (spec convergence rule 5b).
- Test: `packages/hub/src/with-shape/satellites/sync-pair.test.ts`

- [ ] **Step 1: Failing tests:** (a) `push({ collections: ['msgs'] })` transmits the pair's satellite dirty entries too (spy remote sees both); (b) registering a resolver on `msgs` resolves conflicts on `msgs_text` with the same function (assert via a resolver spy invoked for a satellite conflict).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per the three anchored edits above.
- [ ] **Step 4: Run** → PASS + existing sync suite green (`pnpm vitest run packages/hub/src/with-party/team`).
- [ ] **Step 5: Commit** — `feat(satellites): #591 sync filters treat a pair as a unit; conflict resolvers pair-coupled`

---

### Task 12: Architecture guards, features.yaml, exports, docs

**Files:**
- Modify: `scripts/check-architecture.mjs` — add `'with-shape/satellites'` to `SCHEMA_DECLARED_OR_INFRA_EXEMPT` (~line 445) with a one-line comment (`satelliteOf/fields/joined declaration on collection(); joined handle via vault.joined()`); bump `kernel-surface` ceilings to the **actual** post-implementation `wc -l` + 1 for collection.ts and vault.ts, each with a dated justification comment matching the house pattern (`check-architecture.mjs:842-845`) and staying within the plan budget (≤ 4653 / ≤ 3938).
- Modify: `features.yaml` — add the satellite-collections feature entry (copy an adjacent `with-shape` entry's key set; validate with `pnpm validate:features`).
- Modify: `packages/hub/package.json` — add subpath export `"./satellites": { … dist/satellites.js }` mirroring an existing with-shape subpath; add the entry to `packages/hub/tsup.config.ts`.
- Create: `packages/hub/src/with-shape/satellites/index.ts`:

```ts
export type { SatelliteSpec, PairingMarker, JoinedHandle } from './types.js'
export { SatelliteConfigError } from '../../kernel/errors.js'
```

- Create: `docs/subsystems/satellites.md` — condensed from the spec: model, three handles table, refusal matrix, convergence rules, v1 scope caveats (one satellite, new collections only, R-S8, joined reactive throws), link to the spec + #591.
- Modify: `SPEC.md` — one subsection referencing the satellites doc page (match how other subsystems are listed).

- [ ] **Step 1:** Run `pnpm check:architecture` → observe the exact failures (exemption + ceilings).
- [ ] **Step 2:** Apply the modifications above.
- [ ] **Step 3:** Run: `pnpm check:architecture && pnpm validate:features && pnpm --filter @noy-db/hub build && pnpm knip` → all green. Verify the bundle-size gate: `pnpm --filter @noy-db/hub test -- bundle` if the gate is a test, else the CI script named in SERVICES.md:359-367 — satellites must not be reachable from the root `@noy-db/hub` entry (the archetype-③ lazy imports guarantee it; the gate verifies).
- [ ] **Step 4: Commit** — `chore(satellites): #591 architecture exemption, ceiling bumps (budgeted), features.yaml, subpath export, docs page`

---

### Task 13: Integration conformance suite (spec vectors end-to-end)

**Files:**
- Create: `packages/hub/src/with-shape/satellites/satellites.integration.test.ts`

**Interfaces:** consumes everything; this is the spec's § Conformance vectors transcribed. Most vectors already have unit coverage in Tasks 1–11 — this file covers the **cross-cutting** ones only (no duplication):

- [ ] **Step 1: Write the tests** (each maps to a named spec vector):

```ts
describe('spec conformance — cross-cutting vectors', () => {
  it('base put touches exactly one envelope: 1 put, 0 satellite ops (store-shape)', async () => { /* spy assertions */ })

  it('crash injection after the first fan-out op leaves only safe-direction states', async () => {
    // joined put: kill after base leg → base present, satellite absent (joined reads all-null heavy)
    // pair delete: kill after satellite leg → satellite gone, base present
    // assert: a fresh base-less satellite is never produced LOCALLY
  })

  it('offline resurrection containment: re-injected satellite unreachable via get/list/query/search/joined; envelope remains', async () => { /* raw-store injection */ })

  it('post-forget late-arriving satellite put is unreachable through every enumerated surface (observational containment — resurrection PREVENTION is #590, not asserted here)', async () => { /* tombstone base + raw satellite put */ })

  it('field-group conflict granularity is the documented behavior: divergent joined writes converge to a mixed record (asserted as documented, not fixed)', async () => { /* two engines, one remote, LWW */ })

  it('R-S7 retro clause: adding forget coverage over a base with a pre-existing non-perRecordKeys satellite refuses at config time', async () => { /* re-open vault with withForgetCascade */ })
})
```

- [ ] **Step 2–4:** Run → implement any small gaps they expose → PASS.
- [ ] **Step 5: Commit** — `test(satellites): #591 cross-cutting conformance vectors (crash, resurrection, tearing, retro-R-S7)`

---

### Task 14: Full gate + PR

- [ ] **Step 1:** `pnpm --filter @noy-db/hub test && pnpm --filter @noy-db/hub typecheck && pnpm --filter @noy-db/hub lint` → all green (lint too — CI runs ESLint, not just tsc).
- [ ] **Step 2:** `pnpm check:architecture && pnpm validate:features && pnpm knip && pnpm build` → all green.
- [ ] **Step 3:** `pnpm --filter @noy-db/showcases test` → green (no public-surface regressions).
- [ ] **Step 4:** Grep the full branch diff for forbidden content: no Claude attribution anywhere; no reference to the private pilot client.
- [ ] **Step 5:** Push `feat/591-satellites`, open PR titled `feat(satellites): #591 satellite collections v1 (base+satellite pair, joined handle)` with a body linking the spec, the plan, and issues #588/#589/#590 context. **Do not merge, do not publish** — human review gate.

---

## Self-Review (performed at plan-writing time)

- **Spec coverage:** model/routing → T1,T3,T4; marker/R-S9 → T2; existence authority (enumerated scope) → T5 (handles), T9 (search), T10 (export); no-auto-create → T4 test; fan-out+revert hardening → T6; joined handle + describe + vault.joined → T7; forget (full suite, inheritance, R-S4, R-S7 both clauses) → T8 + T13; sync pair-unit + resolver coupling → T11; conflict-granularity documentation vector → T13; shipping obligations → T12; crash/ordering vectors → T13. Not in scope by spec: sweep, N-satellites, CRDT support, backfill, joined reactive (all deferred).
- **Type consistency:** `SatelliteSpec`/`JoinedHandle`/`FanoutDeps`/registry method names cross-checked across tasks; `bySatellite` (not `bySat`) is the public name used everywhere.
- **Placeholder scan:** every code step carries real code; the four "read the anchor first" notes (T2 register.ts shape, T4 derive shape, T6 emitter field names, T9 facade injection) are deliberate anchored-adaptation points with the test as arbiter, not TBDs.
