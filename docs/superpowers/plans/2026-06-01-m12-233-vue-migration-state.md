# M12 #233 (Slice 4) — useMigrationState (Vue) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `useMigrationState()` composable to `@noy-db/in-vue` exposing the live schema-cutover state (`fenceState`, `schemaVersion`) as Vue refs, seeded on mount and updated on the hub's `schema:fence-changed` event.

**Architecture:** A new thin public accessor `vault.schemaFenceState()` reads the live fence (`loadFence`). The composable seeds its refs from it on mount (the event fires on change, not on mount), subscribes to `schema:fence-changed` via `db.on`, updates the refs (filtered to a vault when given), and unsubscribes on scope dispose — the existing `useSync` idiom.

**Tech Stack:** TypeScript, Vue 3 (peerDep), Vitest (`effectScope`, node env). Packages: `packages/hub` (accessor + type export), `packages/in-vue` (composable). Builds on #232 (the `schema:fence-changed` event + fence doc).

**Spec:** `docs/superpowers/specs/2026-05-31-m12-schema-migration-epic-design.md` §5 Slice 4. Issue #233.

---

## Scope

**In scope:** `vault.schemaFenceState()` accessor + public `FenceState`/`FenceDoc` type export from `@noy-db/hub`; `useMigrationState(vaultName?)` composable returning `{ fenceState, schemaVersion }` refs; export from `@noy-db/in-vue`; tests.

**Out of scope (deferred, per spec):** `activePeers` (needs a registry accessor + poll loop); `onFence: 'queue'` write-queueing; explicit lifecycle-hook callbacks / `ackQuiesced()` (the 3b watcher already acks; the reactive ref covers the UI).

---

## File structure

- **Modify** `packages/hub/src/vault.ts` — add `async schemaFenceState(): Promise<FenceDoc>`.
- **Modify** `packages/hub/src/index.ts` — export `FenceState` + `FenceDoc` types.
- **Create** `packages/in-vue/src/useMigrationState.ts` — the composable.
- **Modify** `packages/in-vue/src/index.ts` — export `useMigrationState` + its return type.
- **Create** `packages/in-vue/__tests__/useMigrationState.test.ts`.

---

## Task 1: `vault.schemaFenceState()` accessor + public types

**Files:** Modify `packages/hub/src/vault.ts`, `packages/hub/src/index.ts`; Test `packages/hub/__tests__/schema-update/fence-state-accessor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/noydb.js'
import { memory } from '../../../to-memory/src/index.js'
import { coordinatedCutover } from '../../src/schema-update/index.js'
import type { NoydbStore } from '../../src/types.js'

const oldS = z.object({ id: z.string(), total: z.number() })
const newS = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

async function open(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'a', secret: 'fence-state-pass-1234' })
  return { db, vault: await db.openVault('demo') }
}

describe('vault.schemaFenceState()', () => {
  it('reports normal generation 0 on a fresh vault', async () => {
    const { vault } = await open(memory())
    expect(await vault.schemaFenceState()).toEqual({ currentSchemaVersion: 0, fenceState: 'normal' })
  })

  it('reflects the bumped generation after a completed cutover', async () => {
    const store = memory()
    let { vault } = await open(store)
    const o = vault.collection('invoices', { schema: oldS, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()
    await o.put('i1', { id: 'i1', total: 100 })

    ;({ vault } = await open(store))
    vault.collection('invoices', { schema: newS, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })] })
    await vault._drainPendingSchemaWrites()
    await vault.runSchemaCutover()

    expect(await vault.schemaFenceState()).toEqual({ currentSchemaVersion: 1, fenceState: 'normal' })
  })
})
```

- [ ] **Step 2: Run → fail** (`cd packages/hub && npx vitest run __tests__/schema-update/fence-state-accessor.test.ts` → `schemaFenceState` missing)

- [ ] **Step 3: Add the accessor** — in `vault.ts`, add the import and the method (beside `runSchemaCutover`/`abortSchemaCutover`):

```ts
import { loadFence, type FenceDoc } from './schema-update/fence.js'
```
```ts
  /** Current schema-cutover fence state for this vault (#232/#233). Thin live read. */
  async schemaFenceState(): Promise<FenceDoc> {
    return loadFence(this.adapter, this.name)
  }
```
(If `loadFence` is already imported in `vault.ts`, fold `FenceDoc` into the existing import; confirm with `grep -n "schema-update/fence.js" packages/hub/src/vault.ts`.)

- [ ] **Step 4: Export the types** — in `packages/hub/src/index.ts`, near the other schema-update exports:

```ts
export type { FenceState, FenceDoc } from './schema-update/fence.js'
```

- [ ] **Step 5: Run → pass; typecheck; commit**

```bash
cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run __tests__/schema-update/fence-state-accessor.test.ts && npx tsc --noEmit
cd /Users/vicio/_github/noy-db && git add packages/hub/src/vault.ts packages/hub/src/index.ts packages/hub/__tests__/schema-update/fence-state-accessor.test.ts
git commit -m "feat(hub): vault.schemaFenceState() + public FenceState/FenceDoc (#233)"
```

---

## Task 2: `useMigrationState()` composable

**Files:** Create `packages/in-vue/src/useMigrationState.ts`; Modify `packages/in-vue/src/index.ts`; Test `packages/in-vue/__tests__/useMigrationState.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/in-vue/__tests__/useMigrationState.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { effectScope } from 'vue'
import { z } from 'zod'
import {
  createNoydb,
  coordinatedCutover,
  type Noydb,
  type NoydbStore,
  type EncryptedEnvelope,
  type VaultSnapshot,
} from '@noy-db/hub'
import { NoydbPlugin } from '../src/plugin.js'
import { useMigrationState } from '../src/useMigrationState.js'
import { inject } from 'vue'
import { NoydbKey } from '../src/plugin.js'

// Minimal in-memory store (mirrors the inline store in useBlobURL.test.ts).
function memory(): NoydbStore {
  const s = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const bucket = (v: string, c: string) => {
    let comp = s.get(v); if (!comp) { comp = new Map(); s.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return s.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env) { bucket(v, c).set(id, env) },
    async delete(v, c, id) { s.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(s.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const out: VaultSnapshot = {}; const comp = s.get(v)
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; out[n] = r } }
      return out
    },
    async saveAll() { /* unused */ },
  }
}

const oldS = z.object({ id: z.string(), total: z.number() })
const newS = z.object({ id: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], amount: { gross: d['total'] } })

/** Run a composable inside a scope with the plugin's injection active. */
function runWithDb<T>(db: Noydb, fn: () => T): { result: T; stop: () => void } {
  const scope = effectScope()
  const result = scope.run(() => {
    // emulate NoydbPlugin's provide() inside this scope
    // (provide requires an app; inject in tests reads from the scope's parent — use the plugin install on a throwaway app instead)
    return fn()
  })!
  return { result, stop: () => scope.stop() }
}

describe('useMigrationState', () => {
  it('seeds from the current fence and updates on schema:fence-changed', async () => {
    const store = memory()
    // gen 0 old data
    let db = await createNoydb({ store, user: 'a', secret: 'mig-state-pass-1234' })
    let vault = await db.openVault('demo')
    const o = vault.collection('invoices', { schema: oldS, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()
    await o.put('i1', { id: 'i1', total: 100 })

    // reopen with NEW schema + cutover; mount composable BEFORE the cutover
    db = await createNoydb({ store, user: 'a', secret: 'mig-state-pass-1234' })
    vault = await db.openVault('demo')
    vault.collection('invoices', { schema: newS, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })] })
    await vault._drainPendingSchemaWrites()

    const scope = effectScope()
    const state = scope.run(() => useMigrationState(db, 'demo'))!
    // seed: normal @ 0 (event hasn't fired yet)
    await Promise.resolve()
    expect(state.fenceState.value).toBe('normal')
    expect(state.schemaVersion.value).toBe(0)

    await vault.runSchemaCutover()
    // events drove the refs to the final generation
    expect(state.schemaVersion.value).toBe(1)
    expect(state.fenceState.value).toBe('normal')

    scope.stop()
  })

  it('a freshly-mounted composable seeds the post-cutover generation', async () => {
    const store = memory()
    let db = await createNoydb({ store, user: 'a', secret: 'mig-state-pass-1234' })
    let vault = await db.openVault('demo')
    const o = vault.collection('invoices', { schema: oldS, persistJsonSchema: true })
    await vault._drainPendingSchemaWrites()
    await o.put('i1', { id: 'i1', total: 100 })
    db = await createNoydb({ store, user: 'a', secret: 'mig-state-pass-1234' })
    vault = await db.openVault('demo')
    vault.collection('invoices', { schema: newS, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })] })
    await vault._drainPendingSchemaWrites()
    await vault.runSchemaCutover()

    const scope = effectScope()
    const state = scope.run(() => useMigrationState(db, 'demo'))!
    await new Promise((r) => setTimeout(r, 0)) // let the async seed resolve
    expect(state.schemaVersion.value).toBe(1)
    expect(state.fenceState.value).toBe('normal')
    scope.stop()
  })

  it('unsubscribes on scope dispose (no update after stop)', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'a', secret: 'mig-state-pass-1234' })
    await db.openVault('demo')
    const scope = effectScope()
    const state = scope.run(() => useMigrationState(db, 'demo'))!
    scope.stop()
    // after stop, the handler is removed; the ref keeps its last value
    expect(state.fenceState.value).toBe('normal')
  })
})
```

Note: `useMigrationState` takes `db` as an explicit param here (like `useCollection(db, ...)`) to keep the test free of plugin-injection plumbing; the implementation supports both — see Step 3. Drop the unused `NoydbPlugin`/`inject`/`runWithDb` scaffold if the final implementation is param-based (keep the test lean).

- [ ] **Step 2: Run → fail**

- [ ] **Step 3: Implement** `packages/in-vue/src/useMigrationState.ts`

```ts
import { ref, getCurrentScope, onScopeDispose, type Ref } from 'vue'
import type { Noydb, FenceState } from '@noy-db/hub'
import { useNoydb } from './useNoydb.js'

export interface UseMigrationStateReturn {
  /** Live cutover fence state for the watched vault. */
  readonly fenceState: Ref<FenceState>
  /** Live schema generation counter for the watched vault. */
  readonly schemaVersion: Ref<number>
}

/**
 * Reactive schema-cutover state (#233). Seeds from the current fence on
 * mount, then updates on every `schema:fence-changed` event for `vaultName`
 * (or any vault when omitted). Pass `db` explicitly, or rely on the injected
 * instance (`NoydbPlugin`).
 */
export function useMigrationState(vaultName?: string): UseMigrationStateReturn
export function useMigrationState(db: Noydb, vaultName?: string): UseMigrationStateReturn
export function useMigrationState(
  dbOrVault?: Noydb | string,
  maybeVault?: string,
): UseMigrationStateReturn {
  const db: Noydb = typeof dbOrVault === 'object' ? dbOrVault : useNoydb()
  const vaultName: string | undefined = typeof dbOrVault === 'string' ? dbOrVault : maybeVault

  const fenceState = ref<FenceState>('normal') as Ref<FenceState>
  const schemaVersion = ref(0)

  // Seed from the live fence (the event fires on change, not on mount).
  if (vaultName !== undefined) {
    try {
      void db.vault(vaultName).schemaFenceState().then((s) => {
        fenceState.value = s.fenceState
        schemaVersion.value = s.currentSchemaVersion
      }, () => { /* vault not open / no fence yet → keep defaults */ })
    } catch {
      /* db.vault() throws if not open yet → keep defaults; events will catch up */
    }
  }

  const handler = (e: { vault: string; currentSchemaVersion: number; fenceState: FenceState }) => {
    if (vaultName !== undefined && e.vault !== vaultName) return
    fenceState.value = e.fenceState
    schemaVersion.value = e.currentSchemaVersion
  }
  db.on('schema:fence-changed', handler)

  if (getCurrentScope()) {
    onScopeDispose(() => { db.off('schema:fence-changed', handler) })
  }

  return { fenceState, schemaVersion }
}
```

- [ ] **Step 4: Export** — in `packages/in-vue/src/index.ts`:

```ts
export { useMigrationState } from './useMigrationState.js'
export type { UseMigrationStateReturn } from './useMigrationState.js'
```

- [ ] **Step 5: Run → pass; typecheck; commit**

```bash
cd /Users/vicio/_github/noy-db/packages/in-vue && npx vitest run __tests__/useMigrationState.test.ts && npx tsc --noEmit
cd /Users/vicio/_github/noy-db && git add packages/in-vue/src/useMigrationState.ts packages/in-vue/src/index.ts packages/in-vue/__tests__/useMigrationState.test.ts
git commit -m "feat(in-vue): useMigrationState composable (#233)"
```

---

## Task 3: features.yaml + final verification

**Files:** Modify `features.yaml`

- [ ] **Step 1: Decide the registry touch**

Run: `grep -n "in-vue\|frameworks:" features.yaml | head`. If there is an `in-vue` entry under `frameworks:`, add a note/showcase only if the schema requires it; otherwise add a Vue-surface invariant to the `schema-update-strategies` feature:
```yaml
      - 'in-vue useMigrationState() surfaces fenceState + schemaVersion as refs, seeded from vault.schemaFenceState() and updated on schema:fence-changed'
```
(Adding code to an existing package does not by itself create a dangling spec ref; the invariant keeps the registry honest about the new public surface.)

- [ ] **Step 2: Validate** — `node scripts/validate-features.mjs` (Expected: PASS)

- [ ] **Step 3: Full verification (both packages)**

```bash
cd /Users/vicio/_github/noy-db/packages/hub && npx vitest run && npx tsc --noEmit && npm run lint
cd /Users/vicio/_github/noy-db/packages/in-vue && npx vitest run && npx tsc --noEmit && npm run lint
```
Expected: all PASS, vitest exits cleanly.

- [ ] **Step 4: Commit + clean tree**

```bash
cd /Users/vicio/_github/noy-db && git add features.yaml
git commit -m "chore(features): record useMigrationState surface (#233)"
git status
```

---

## Self-review checklist (already applied)

- **Spec coverage (§5 Slice 4):** `{ fenceState, schemaVersion }` refs → Task 2; seed via `vault.schemaFenceState()` → Task 1; update on `schema:fence-changed` + dispose cleanup → Task 2; `vaultName` filter → Task 2; deferred items (activePeers / onFence:queue / lifecycle callbacks) explicitly out of scope.
- **Type consistency:** `FenceState`/`FenceDoc` exported from hub (Task 1) and imported by the composable (Task 2); `UseMigrationStateReturn` + `useMigrationState` names match between composable, index export, and tests; `schemaFenceState()` returns `FenceDoc` (`{ currentSchemaVersion, fenceState }`) consistently.
- **Verify-before-trust:** Task 1 confirms whether `loadFence` is already imported in `vault.ts`; Task 3 confirms the `frameworks`/`in-vue` registry shape before touching it. Both are real lookups.
- **Test idiom:** mirrors `useBlobURL.test.ts` (inline `memory()`, `effectScope`, `scope.run`/`scope.stop`, real `Noydb`); param-based `useMigrationState(db, vault)` keeps tests free of plugin plumbing while the overload still supports injected use.
- **No placeholders:** every code step has complete code; every run step states command + expected result.
