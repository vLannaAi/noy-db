# Runtime Schema Introspection (#229) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `vault.introspect()` returning a flat snapshot of the vault's registered schema — collections (+ doc counts), guards, materialized views, schema-update strategies, and the unlocked user's grants.

**Architecture:** Reuse existing registries where they enumerate (`MaterializedViewRegistry.all()`, `vault.collections()`, `keyring.permissions`); add a `GuardRegistry.summary()` accessor and a vault-level capture of per-collection `schemaUpdate` strategy names (the only data not stored today). `introspect()` assembles these; it's post-unlock by construction (a `Vault` only exists with an `UnlockedKeyring`).

**Tech Stack:** TypeScript, Vitest, `@noy-db/to-memory`. Package: `packages/hub`. Own PR through CI.

**Spec:** `docs/superpowers/specs/2026-06-01-schema-introspection-design.md`. Issue #229.

---

## File structure

- **Modify** `packages/hub/src/guards/registry.ts` — add `summary(): { collection: string; count: number }[]`.
- **Modify** `packages/hub/src/introspection/types.ts` — add the `SchemaIntrospection` interface.
- **Modify** `packages/hub/src/vault.ts` — `#schemaUpdateNames` capture at registration; `introspect()`.
- **Modify** `packages/hub/src/index.ts` — export `SchemaIntrospection`.
- **Create** tests: `guards/registry-summary.test.ts` (unit), `schema-introspection.test.ts` (E2E).

---

## Task 1: `GuardRegistry.summary()`

**Files:** Modify `packages/hub/src/guards/registry.ts`; Test `packages/hub/__tests__/guards/registry-summary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { GuardRegistry } from '../../src/guards/registry.js'

// Minimal guard strategies (only `collection` matters for summary()).
const g = (collection: string) => ({ collection }) as never

describe('GuardRegistry.summary()', () => {
  it('returns [] when empty', () => {
    expect(new GuardRegistry().summary()).toEqual([])
  })
  it('counts guards per collection', () => {
    const r = new GuardRegistry()
    r.register(g('invoices'))
    r.register(g('invoices'))
    r.register(g('payments'))
    const s = r.summary().sort((a, b) => a.collection.localeCompare(b.collection))
    expect(s).toEqual([
      { collection: 'invoices', count: 2 },
      { collection: 'payments', count: 1 },
    ])
  })
})
```

(Confirm the registration method name with `grep -n "register\|add(" packages/hub/src/guards/registry.ts` — the spec map shows `_byCollection.set/get` inside a register-style method; use the real method name in the test. If registration is `add(spec)`, change `r.register` → `r.add`.)

- [ ] **Step 2: Run → fail** (`cd packages/hub && npx vitest run __tests__/guards/registry-summary.test.ts`)

- [ ] **Step 3: Implement** — add to the `GuardRegistry` class (beside `guardsFor`):

```ts
  /** Per-collection guard counts, for introspection (#229). */
  summary(): { collection: string; count: number }[] {
    return [...this._byCollection.entries()].map(([collection, guards]) => ({
      collection,
      count: guards.length,
    }))
  }
```

- [ ] **Step 4: Run → pass; commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/guards/registry.ts packages/hub/__tests__/guards/registry-summary.test.ts
git commit -m "feat(hub): GuardRegistry.summary() per-collection counts (#229)"
```

---

## Task 2: Capture schema-update strategy names on the Vault

**Files:** Modify `packages/hub/src/vault.ts`

- [ ] **Step 1: Add the field** — beside the other vault registries (e.g. near `i18nFieldRegistry`):

```ts
  /** #229 — per-collection registered schema-update strategy names. */
  readonly #schemaUpdateNames = new Map<string, string[]>()
```

- [ ] **Step 2: Capture at registration** — in the `collection()` body, inside the block that already reads `options.schemaUpdate` (the `if (... (options.schemaUpdate?.length ?? 0) > 0)` gate that builds the `SchemaUpdateGate`), add as the first line of that block:

```ts
        this.#schemaUpdateNames.set(collectionName, (options.schemaUpdate ?? []).map((s) => s.name))
```

(Locate with `grep -n "options.schemaUpdate" packages/hub/src/vault.ts`. Place the capture where `options.schemaUpdate` is in scope and non-empty.)

- [ ] **Step 3: Typecheck** (`cd packages/hub && npx tsc --noEmit`) — expect clean (the map is unused until Task 3; that's fine — it's a private field that's written). If tsc flags "declared but never read" for `#schemaUpdateNames`, proceed to Task 3 which reads it, and commit together. Otherwise commit now:

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/vault.ts
git commit -m "feat(hub): capture per-collection schemaUpdate strategy names (#229)"
```

---

## Task 3: `SchemaIntrospection` type + `vault.introspect()`

**Files:** Modify `packages/hub/src/introspection/types.ts`, `packages/hub/src/vault.ts`, `packages/hub/src/index.ts`; Test `packages/hub/__tests__/schema-introspection.test.ts`

- [ ] **Step 1: Add the type** — in `packages/hub/src/introspection/types.ts`:

```ts
import type { Permission } from '../types.js'

/** Flat snapshot of a vault's registered schema (#229). */
export interface SchemaIntrospection {
  readonly collections: ReadonlyArray<{ name: string; docCount: number }>
  readonly guards: ReadonlyArray<{ collection: string; count: number }>
  readonly materializedViews: ReadonlyArray<{ name: string; sourceCollections: string[] }>
  readonly schemaUpdate: ReadonlyArray<{ collection: string; strategies: string[] }>
  readonly grants: ReadonlyArray<{ collection: string; permission: Permission }>
}
```

(If `introspection/types.ts` already imports from `../types.js`, fold `Permission` into that import.)

- [ ] **Step 2: Write the failing E2E test** `packages/hub/__tests__/schema-introspection.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb, type NoydbStore } from '../src/noydb.js'
import { memory } from '../../to-memory/src/index.js'
import { withGuard } from '../src/guards/with-guard.js'
import { withMaterializedView } from '../src/materialized-views/with-materialized-view.js'
import { additiveOnly, coordinatedCutover } from '../src/schema-update/index.js'

interface Inv extends Record<string, unknown> { id: string; amount: number }

describe('vault.introspect() (#229)', () => {
  it('reports collections with counts, guards, MVs, schemaUpdate, and grants', async () => {
    const store: NoydbStore = memory()
    const db = await createNoydb({
      store, user: 'alice', secret: 'introspect-pass-1234',
      guardStrategies: [withGuard<Inv>({ collection: 'invoices', check: () => {} })],
    })
    const v = await db.openVault('demo')
    const invoices = v.collection<Inv>('invoices', {
      schema: z.object({ id: z.string(), amount: z.number() }),
      persistJsonSchema: true,
      schemaUpdate: [coordinatedCutover({ transform: (d) => d }), additiveOnly()],
    })
    await v._drainPendingSchemaWrites()
    v.collection('notes')
    await invoices.put('i1', { id: 'i1', amount: 1 })
    await invoices.put('i2', { id: 'i2', amount: 2 })

    const snap = await v.introspect()

    const invCol = snap.collections.find(c => c.name === 'invoices')
    expect(invCol?.docCount).toBe(2)
    expect(snap.collections.map(c => c.name)).toContain('notes')

    expect(snap.guards).toContainEqual({ collection: 'invoices', count: 1 })
    expect(snap.schemaUpdate).toContainEqual({ collection: 'invoices', strategies: ['coordinatedCutover', 'additiveOnly'] })

    const inv = snap.grants.find(g => g.collection === 'invoices')
    expect(inv).toBeDefined()
    expect(['rw', 'ro']).toContain(inv!.permission)
  })

  it('a subsystems-off vault yields empty guard/MV/schemaUpdate arrays without error', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'introspect-pass-1234' })
    const v = await db.openVault('demo')
    v.collection('plain')
    const snap = await v.introspect()
    expect(snap.guards).toEqual([])
    expect(snap.materializedViews).toEqual([])
    expect(snap.schemaUpdate).toEqual([])
    expect(snap.collections.map(c => c.name)).toContain('plain')
  })
})
```

(Confirm `withGuard`'s option shape with `grep -n "export function withGuard" packages/hub/src/guards/with-guard.js` and the MV/guard helper import paths; adjust the `withGuard`/strategy construction to the real signature. The MV assertion is omitted from test 1 to avoid coupling to the MV query-builder API; if a simple MV is easy to register, add a `materializedViews` assertion.)

- [ ] **Step 3: Run → fail** (no `introspect`)

- [ ] **Step 4: Implement `introspect()`** — in `vault.ts`. Import the type:

```ts
import type { SchemaIntrospection } from './introspection/types.js'
```

Add the method (beside `dumpSchema`):

```ts
  /**
   * Lightweight read of the vault's registered schema (#229): collections
   * (+ doc counts), guards, materialized views, schema-update strategies,
   * and the unlocked user's grants. Cheap — one `adapter.list` per
   * collection, no decryption. For a full snapshot + stats use dumpSchema().
   * Post-unlock by construction.
   */
  async introspect(): Promise<SchemaIntrospection> {
    const byCol = (a: { collection: string }, b: { collection: string }) => a.collection.localeCompare(b.collection)

    const names = [...(await this.collections())].sort((a, b) => a.localeCompare(b))
    const collections: { name: string; docCount: number }[] = []
    for (const name of names) {
      const ids = await this.adapter.list(this.name, name)
      collections.push({ name, docCount: ids.length })
    }

    const guards = (this._getGuardRegistry()?.summary() ?? []).slice().sort(byCol)

    const materializedViews = (this._getMaterializedViewRegistry()?.all() ?? [])
      .map((mv) => ({ name: mv.spec.name, sourceCollections: [...mv.dependencies].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name))

    const schemaUpdate = [...this.#schemaUpdateNames.entries()]
      .map(([collection, strategies]) => ({ collection, strategies }))
      .sort(byCol)

    const grants = Object.entries(this.keyring.permissions)
      .map(([collection, permission]) => ({ collection, permission }))
      .sort(byCol)

    return { collections, guards, materializedViews, schemaUpdate, grants }
  }
```

(Confirm `_getMaterializedViewRegistry()` / `_getGuardRegistry()` names + that `mv.spec.name` is accessible — the registry map is keyed by `spec.name`, so it is. If `this.collections()` already excludes internal `_`-prefixed collections, no extra filter is needed; verify and add `.filter(n => !n.startsWith('_'))` only if internal collections leak through.)

- [ ] **Step 5: Export the type** — in `packages/hub/src/index.ts`, near the introspection / write-queue exports:

```ts
export type { SchemaIntrospection } from './introspection/types.js'
```

- [ ] **Step 6: Run → pass; typecheck**

Run: `cd packages/hub && npx vitest run __tests__/schema-introspection.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/vicio/_github/noy-db && git add packages/hub/src/introspection/types.ts packages/hub/src/vault.ts packages/hub/src/index.ts packages/hub/__tests__/schema-introspection.test.ts
git commit -m "feat(hub): vault.introspect() runtime schema introspection (#229)"
```

---

## Task 4: features.yaml + final verification

**Files:** Modify `features.yaml`

- [ ] **Step 1: Add the feature entry** (mirror `write-lifecycle-hooks`):

```yaml
  - id: schema-introspection
    name: Runtime schema introspection
    cluster: core
    spec: docs/superpowers/specs/2026-06-01-schema-introspection-design.md
    subsystem_doc: docs/superpowers/specs/2026-06-01-schema-introspection-design.md
    package: '@noy-db/hub'
    factory: null
    status: preview
    showcases: []
    recipes: []
    playground_pages: []
    diagrams: []
    invariants:
      - 'vault.introspect() reports collection doc counts via adapter.list, without decryption'
      - 'guards / materializedViews / schemaUpdate arrays are empty (not errors) when the subsystem is off'
      - 'schemaUpdate strategy names are captured at collection() registration time'
    related: [dump-schema-introspection, schema-update-strategies]
```

- [ ] **Step 2: Validate** — `node scripts/validate-features.mjs` (Expected: PASS; if `related: [dump-schema-introspection]` doesn't resolve, check the exact id with `grep -n "id: dump-schema" features.yaml` and fix).

- [ ] **Step 3: Full verify** — `cd packages/hub && npx vitest run && npx tsc --noEmit && npm run lint` (Expected: all PASS).

- [ ] **Step 4: Commit + clean tree**

```bash
cd /Users/vicio/_github/noy-db && git add features.yaml
git commit -m "chore(features): register schema-introspection (#229)"
git status
```

---

## Self-review checklist (already applied)

- **Spec coverage:** collections+counts → Task 3; guards → Tasks 1,3; MVs → Task 3 (reuse `.all()`); schemaUpdate capture+report → Tasks 2,3; grants → Task 3; post-unlock-by-construction → documented on the method; subsystems-off → empty arrays (Task 3 + test 2); type export → Task 3.
- **Type consistency:** `SchemaIntrospection` shape matches the builder; `Permission` is `'rw'|'ro'` (per `types.ts`); `GuardRegistry.summary()` return shape matches its consumer; `mv.spec.name`/`mv.dependencies` match `RegisteredMV`.
- **Verify-before-trust:** Task 1 confirms the guard registration method name; Task 3 confirms `withGuard`/MV helper signatures + `_get*Registry` names + whether `collections()` filters internal names. Real lookups, flagged.
- **Existing-suite safety:** purely additive (a new method + a new registry accessor + a written-only map); no existing path changes → the 1948-test suite is untouched.
- **No placeholders:** every code step has complete code; every run step states command + expected result.
