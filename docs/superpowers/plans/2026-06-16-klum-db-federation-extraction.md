# klum-db Federation Extraction (Phase 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the federation subsystem out of `@noy-db/hub` into `@klum-db/lobby`, binding it to the `@noy-db/hub/kernel` surface, with the `Lobby` class as the entry point and throwing deprecation shims left in hub.

**Architecture:** Federation is already acyclic (federation → hub internals) and loaded via dynamic `import()`. The only hub *private* state its entry points touch is `closed` and `vaultTemplates`. We add a public `isClosed` getter, move the template registry onto `Lobby`, copy the 10 federation files to `@klum-db/lobby` (rewriting hub-internal imports to `@noy-db/hub/kernel` / `@noy-db/hub`), give `Lobby` the `withVaultTemplate`/`openVaultGroup`/`openStateManagementVault` methods (lifted from `Noydb`), then delete federation from hub and replace the three `Noydb` methods with `FederationMovedError` shims. Tasks are sequenced so **each ends green** (additive first, removal last).

**Tech Stack:** pnpm + turbo + tsup + vitest, TS strict, ESM `.js` specifiers.

**Builds on:** PR #450 (`@klum-db/lobby` scaffold + `@noy-db/hub/kernel`). Branch: `feat/klum-db-federation-extraction` (stacked on `feat/klum-db-lobby-foundation`).

---

## ⚠️ Breaking change (intended, pre-1.0)

This moves `@noy-db/hub`'s federation **public API** to `@klum-db/lobby`:
- **Runtime:** `db.openVaultGroup()`, `db.openStateManagementVault()`, `db.withVaultTemplate()` → throw `FederationMovedError`. New usage: `import { createLobby } from '@klum-db/lobby'; const lobby = createLobby(db); lobby.withVaultTemplate(...); await lobby.openVaultGroup(...)`.
- **Types:** `VaultGroup`, `VaultTemplate`, `VaultGroupOptions`, `CrossVaultDerivationSpec`, etc. are no longer exported from `@noy-db/hub` — import them from `@klum-db/lobby`.
- **Kept in hub:** the federation error classes (`UnknownShardError`, …) and `STATE_VAULT_NAME` stay public on `@noy-db/hub` (they're general / reserved-name concerns).

---

## Import-rewrite map (used by Tasks 2 & 3)

When a federation file is copied into `packages/lobby/src/federation/`, rewrite its **hub-internal** imports per this table. **Sibling** imports (`./x.js`) stay unchanged.

| Original (in hub) | Symbols | Rewrite to |
|---|---|---|
| `../errors.js` | CrossShardJoinError, DataResidencyError, ReservedVaultNameError, ShardProvisioningError, UnknownShardError, ValidationError, NoAccessError | `@noy-db/hub/kernel` |
| `../aggregate/aggregation.js` | reduceRecords, AggregateResult, AggregateSpec, LiveAggregation | `@noy-db/hub/kernel` |
| `../aggregate/groupby.js` | groupAndReduce | `@noy-db/hub/kernel` |
| `../query/predicate.js` | readPath, Operator | `@noy-db/hub/kernel` |
| `../query/join.js` | JoinStrategy | `@noy-db/hub/kernel` |
| `../query/builder.js` | Query | `@noy-db/hub/kernel` |
| `../query/live.js` | LiveQuery | `@noy-db/hub/kernel` |
| `../bundle/ulid.js` | generateULID | `@noy-db/hub/kernel` |
| `../crypto.js` | sha256Hex | `@noy-db/hub/kernel` |
| `../indexing/eager-indexes.js` | IndexDef | `@noy-db/hub/kernel` |
| `../noydb.js` | Noydb (type) | `@noy-db/hub/kernel` |
| `../vault.js` | Vault (type) | `@noy-db/hub/kernel` |
| `../collection.js` | Collection (type) | `@noy-db/hub/kernel` |
| `../types.js` | ChangeEvent (type) | `@noy-db/hub/kernel` |
| `./constants.js` (STATE_VAULT_NAME) | — | leave as `./constants.js`; klum's `constants.ts` re-exports from `@noy-db/hub` (Task 2) |

All listed symbols are confirmed present on `@noy-db/hub/kernel`. If any import fails to resolve, STOP and report — do not invent a path.

---

## Task 1 — Hub prep (additive; hub stays green)

**Files:**
- Modify: `packages/hub/src/noydb.ts` (add `isClosed` getter; relocate STATE_VAULT_NAME import)
- Create: `packages/hub/src/constants.ts`
- Modify: `packages/hub/src/federation/constants.ts` (re-export shim)
- Modify: `packages/hub/src/index.ts` (STATE_VAULT_NAME source + export FederationMovedError)
- Modify: `packages/hub/src/errors.ts` (add `FederationMovedError`)
- Modify: `scripts/check-architecture.mjs` (add noy→klum guard)
- Test: `packages/hub/__tests__/federation-moved.test.ts` (new)

- [ ] **Step 1: Create `packages/hub/src/constants.ts`**
```typescript
/**
 * Hub-core constants that must be referenceable without pulling any
 * subsystem chunk. Kept import-free.
 */

/** Reserved fleet-wide control-plane vault name. Hub reserves it; @klum-db/lobby's StateManagementVault uses it. */
export const STATE_VAULT_NAME = '__noydb_state__'
```

- [ ] **Step 2: Re-point the federation constants file to the new home** — replace the entire body of `packages/hub/src/federation/constants.ts` with:
```typescript
// Relocated to hub core (src/constants.ts). Kept as a re-export so the
// federation chunk and any importer keep working until federation is extracted.
export { STATE_VAULT_NAME } from '../constants.js'
```

- [ ] **Step 3: Re-point hub's two STATE_VAULT_NAME importers**
  - In `packages/hub/src/noydb.ts:25`, change `import { STATE_VAULT_NAME } from './federation/constants.js'` → `import { STATE_VAULT_NAME } from './constants.js'`.
  - In `packages/hub/src/index.ts:348`, change `export { STATE_VAULT_NAME } from './federation/constants.js'` → `export { STATE_VAULT_NAME } from './constants.js'`.

- [ ] **Step 4: Add `FederationMovedError` to `packages/hub/src/errors.ts`** — immediately after the `VaultTemplateNotFoundError` class (it lives near the other federation errors). Follow the `NoydbError` convention:
```typescript
export class FederationMovedError extends NoydbError {
  constructor(api: string) {
    super(
      'FEDERATION_MOVED',
      `${api} has moved to @klum-db/lobby. Install @klum-db/lobby, then: `
      + `import { createLobby } from '@klum-db/lobby'; `
      + `const lobby = createLobby(db); await lobby.${api}(...)`,
    )
    this.name = 'FederationMovedError'
  }
}
```
Then export it from `packages/hub/src/index.ts` — append `FederationMovedError` to the existing federation-error export line (349):
`export { UnknownShardError, ShardProvisioningError, VaultTemplateNotFoundError, ReservedVaultNameError, DataResidencyError, FederationMovedError } from './errors.js'`

- [ ] **Step 5: Add a public `isClosed` getter to `Noydb`** — in `packages/hub/src/noydb.ts`, add this method in the class body immediately above `withVaultTemplate` (currently line 1095):
```typescript
  /**
   * @internal True once `close()` has been called. Read by
   * `@klum-db/lobby`'s Lobby entry points (which can't see the private
   * `closed` field).
   */
  get isClosed(): boolean {
    return this.closed
  }
```

- [ ] **Step 6: Add the noy→klum architecture guard** — in `scripts/check-architecture.mjs`, add this function (mirror the existing `checkHubPortable`/`walkTsFiles` style) and call it in the main run block alongside the other checks:
```javascript
// ─── Check: no-outbound-klum-import (hub core must not depend on @klum-db) ───
function checkNoOutboundKlumImport() {
  const hubSrc = join(PACKAGES_DIR, 'hub', 'src')
  const klumPattern = /from\s+['"]@klum-db\/[^'"]+['"]/
  walkTsFiles(hubSrc, (file, content) => {
    if (klumPattern.test(stripComments(content))) {
      fail(
        'no-outbound-klum-import',
        `${relative(ROOT, file)} imports from @klum-db. Hub core must NOT depend on the extracted orchestration package — the dependency runs the other way (@klum-db/lobby depends on @noy-db/hub/kernel).`,
        file,
      )
    }
  })
}
```
Add `checkNoOutboundKlumImport()` to the sequence of check calls near the end of the file.

- [ ] **Step 7: Test the new error + getter (TDD)** — create `packages/hub/__tests__/federation-moved.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { FederationMovedError } from '../src/errors.js'
import { memory } from '@noy-db/to-memory'

describe('hub prep for federation extraction', () => {
  it('FederationMovedError carries the stable code + API name', () => {
    const err = new FederationMovedError('openVaultGroup')
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('FEDERATION_MOVED')
    expect(err.message).toContain('@klum-db/lobby')
    expect(err.message).toContain('openVaultGroup')
  })

  it('Noydb exposes isClosed reflecting lifecycle', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'correct-horse-battery-staple' })
    expect(db.isClosed).toBe(false)
    await db.close()
    expect(db.isClosed).toBe(true)
  })
})
```
(If `@noy-db/to-memory` isn't already a hub devDependency, add it; check `packages/hub/package.json` first. If `db.close()` has a different name, read the Noydb class and use the actual close method.)

- [ ] **Step 8: Verify + commit**
```bash
pnpm --filter @noy-db/hub test -- federation-moved
pnpm --filter @noy-db/hub typecheck
pnpm check:architecture
git add packages/hub/src/constants.ts packages/hub/src/federation/constants.ts packages/hub/src/noydb.ts packages/hub/src/index.ts packages/hub/src/errors.ts scripts/check-architecture.mjs packages/hub/__tests__/federation-moved.test.ts
git commit -m "feat(hub): prep for federation extraction (isClosed, FederationMovedError, STATE_VAULT_NAME core, noy->klum guard)"
```
Expected: new test passes; full hub suite still green; architecture check passes (no klum imports in hub yet).

---

## Task 2 — Copy federation into `@klum-db/lobby` + Lobby entry API (additive; both packages green)

**Files:**
- Create: `packages/lobby/src/federation/*` (copies of the 10 hub files, imports rewritten)
- Create: `packages/lobby/src/federation/constants.ts` (re-export from hub)
- Modify: `packages/lobby/src/index.ts` (Lobby entry methods + federation public re-exports)

- [ ] **Step 1: Copy the federation sources**
```bash
mkdir -p packages/lobby/src/federation
cp packages/hub/src/federation/*.ts packages/lobby/src/federation/
```

- [ ] **Step 2: Rewrite hub-internal imports** in every copied file under `packages/lobby/src/federation/` per the **Import-rewrite map** above. Sibling `./x.js` imports stay. Then replace `packages/lobby/src/federation/constants.ts` body with:
```typescript
export { STATE_VAULT_NAME } from '@noy-db/hub'
```
Verify there are no remaining `from '../` specifiers in `packages/lobby/src/federation/`:
`grep -rn "from '\.\./" packages/lobby/src/federation/` → must return nothing.

- [ ] **Step 3: Give `Lobby` the entry API** — in `packages/lobby/src/index.ts`, extend the `Lobby` class with the template registry + the three entry methods, lifted from `Noydb` (`noydb.ts:1095-1148`) but reading templates from the Lobby and `db.isClosed` instead of `this.closed`. Use dynamic `import()` of klum's own `./federation/*.js` so federation stays a lazy chunk:
```typescript
import type { Noydb } from '@noy-db/hub'
import type { VaultGroup } from './federation/vault-group.js'
import type { VaultTemplate, VaultGroupOptions } from './federation/types.js'
import type { StateManagementVault } from './federation/state-vault.js'
import { ValidationError, ReservedVaultNameError, VaultTemplateNotFoundError } from '@noy-db/hub/kernel'
import { STATE_VAULT_NAME } from '@noy-db/hub'

export class Lobby {
  readonly noydb: Noydb
  private readonly vaultTemplates = new Map<string, VaultTemplate>()

  constructor(noydb: Noydb) {
    this.noydb = noydb
  }

  /** Register a shard schema blueprint used by `openVaultGroup`. */
  withVaultTemplate(name: string, template: VaultTemplate): void {
    this.vaultTemplates.set(name, template)
  }

  /** Open a VaultGroup — transparent routing over per-partition shard vaults. */
  async openVaultGroup<T>(name: string, opts: VaultGroupOptions<T>): Promise<VaultGroup<T>> {
    const db = this.noydb
    if (db.isClosed) throw new ValidationError('Instance is closed')
    if (name === STATE_VAULT_NAME) throw new ReservedVaultNameError(name)
    const template = this.vaultTemplates.get(opts.sharding.vaultTemplate)
    if (!template) throw new VaultTemplateNotFoundError(opts.sharding.vaultTemplate)
    const { VaultGroup } = await import('./federation/vault-group.js')
    const { StateManagementVault } = await import('./federation/state-vault.js')
    const stateVault = opts.registry ? undefined : await StateManagementVault.open(db)
    const registry = opts.registry ?? stateVault!.registry
    const group = new VaultGroup<T>(db, name, registry, opts.sharding, template, opts.migrateOnOpen ?? false)
    if (stateVault) {
      group._attachStateVault(stateVault)
      await stateVault.recordManifest(opts.sharding.vaultTemplate, template)
      try {
        await stateVault.appendEvent({ type: 'manifest-recorded', group: name, templateName: opts.sharding.vaultTemplate, version: template.version })
        await stateVault.appendEvent({ type: 'group-opened', group: name })
      } catch { /* best-effort */ }
    }
    return group
  }

  /** Open the reserved StateManagement control-plane vault. */
  async openStateManagementVault(): Promise<StateManagementVault> {
    const db = this.noydb
    if (db.isClosed) throw new ValidationError('Instance is closed')
    const { StateManagementVault } = await import('./federation/state-vault.js')
    return StateManagementVault.open(db)
  }
}

export function createLobby(noydb: Noydb): Lobby {
  return new Lobby(noydb)
}
```
(Cross-check the exact body against `noydb.ts:1095-1148` and replicate faithfully — including the `_attachStateVault`/`recordManifest`/`appendEvent` calls. If `VaultGroup`/`StateManagementVault` signatures differ from what's shown, match the actual signatures in the copied files.)

- [ ] **Step 4: Re-export federation's public types from klum** — append to `packages/lobby/src/index.ts` the same type surface hub used to expose (from `index.ts:325-347`), sourced from `./federation/index.js`:
```typescript
export type {
  VaultGroup, ShardedCollection, ShardedQuery, StateManagementVault,
  VaultTemplate, VaultRegistryRow, ShardingConfig, VaultGroupOptions,
  FanoutQueryOptions, FanoutResult, SkippedVault,
  CrossVaultAggregation, CrossVaultGroupedAggregation, ShardedGroupedQuery,
  CrossVaultLiveQuery, CrossVaultLiveAggregation, LiveQueryOptions,
  SchemaManifestRow, DeploymentEvent, CapturedBlueprint,
  CrossVaultDerivationSpec, CrossVaultDerivationContext, RefreshInsightsResult,
  MigrationStatusRow, FleetMigrationResult,
} from './federation/index.js'
export type { GroupedRow as CrossVaultGroupedRow } from './federation/index.js'
```
(Match the exact names in klum's `federation/index.js`; it was copied from hub so they should align.)

- [ ] **Step 5: Verify + commit**
```bash
pnpm --filter @klum-db/lobby typecheck
pnpm --filter @klum-db/lobby build
pnpm --filter @klum-db/lobby test   # existing 2 tests still pass
pnpm check:architecture             # klum→hub allowed; hub still has no klum imports
git add packages/lobby/src/
git commit -m "feat(lobby): copy federation subsystem + Lobby entry API (bound to @noy-db/hub/kernel)"
```
Expected: klum typechecks/builds; hub untouched and green. Federation now exists in both packages (temporary; removed from hub in Task 4).

---

## Task 3 — Move + rewrite the federation tests into klum (proves the moved code)

**Files:**
- Create: `packages/lobby/__tests__/federation-*.test.ts` (the 7 tests, rewritten)

- [ ] **Step 1: Copy the 7 federation tests**
```bash
cp packages/hub/__tests__/federation-*.test.ts packages/lobby/__tests__/
```

- [ ] **Step 2: Rewrite imports** in each copied test:
  - `../src/federation/<x>.js` → `../src/federation/<x>.js` (unchanged — federation now lives in klum's src).
  - `../src/noydb.js` (`createNoydb`, `Noydb`) → `@noy-db/hub`.
  - `../src/errors.js` (error classes) → `@noy-db/hub`.
  - `../src/vault.js` (`Vault`), `../src/types.js` (`NoydbStore`, etc.) → `@noy-db/hub`.
  - `../src/guards/index.js` → `@noy-db/hub/guards`.
  - any other `../src/<sub>/index.js` → the matching `@noy-db/hub/<sub>` subpath.
  - Add `import { createLobby } from '../src/index.js'`.

- [ ] **Step 3: Rewrite the entry calls** in each test:
  - Introduce `const lobby = createLobby(db)` right after each `createNoydb(...)`.
  - `db.withVaultTemplate(...)` → `lobby.withVaultTemplate(...)`
  - `db.openVaultGroup(...)` → `lobby.openVaultGroup(...)`
  - `db.openStateManagementVault()` → `lobby.openStateManagementVault()`
  - Direct `new StateManagementVault(...)` / `StateManagementVault.open(db)` / `captureBlueprint(...)` etc. stay (they import from `../src/federation/...`).

- [ ] **Step 4: Run + fix until green**
```bash
pnpm --filter @klum-db/lobby test
```
Expected: all federation tests pass under klum (2 original + the migrated suites). Fix any import/path slips. If a test relies on a hub internal not on a public subpath, STOP and report (it may indicate a missing public export rather than a test bug).

- [ ] **Step 5: Commit**
```bash
git add packages/lobby/__tests__/
git commit -m "test(lobby): migrate federation test suites to @klum-db/lobby (Lobby API)"
```

---

## Task 4 — Remove federation from hub + install deprecation shims (hub green)

**Files:**
- Delete: `packages/hub/src/federation/` (all 10 files)
- Delete: `packages/hub/__tests__/federation-*.test.ts` (the 7, now in klum)
- Modify: `packages/hub/src/noydb.ts` (shims; remove withVaultTemplate/vaultTemplates + federation imports)
- Modify: `packages/hub/src/index.ts` (remove federation type re-exports)

- [ ] **Step 1: Delete the federation source + tests**
```bash
git rm -r packages/hub/src/federation
git rm packages/hub/__tests__/federation-*.test.ts
```

- [ ] **Step 2: Replace the three Noydb methods with shims** — in `packages/hub/src/noydb.ts`:
  - Remove the `private readonly vaultTemplates = new Map…` field (line 214) and the `withVaultTemplate` method (1095-1097).
  - Remove the federation imports at the top (line 26 `import type { StateManagementVault } from './federation/state-vault.js'`, and the `VaultTemplate`/`VaultGroup`/`VaultGroupOptions` type imports if they came from federation).
  - Replace the bodies of `openVaultGroup` and `openStateManagementVault` with shims that throw, and drop their federation-typed signatures in favor of `never`-returning stubs:
```typescript
  /** @deprecated Moved to @klum-db/lobby. */
  async openVaultGroup(): Promise<never> {
    throw new FederationMovedError('openVaultGroup')
  }

  /** @deprecated Moved to @klum-db/lobby. */
  async openStateManagementVault(): Promise<never> {
    throw new FederationMovedError('openStateManagementVault')
  }

  /** @deprecated Moved to @klum-db/lobby (Lobby.withVaultTemplate). */
  withVaultTemplate(): never {
    throw new FederationMovedError('withVaultTemplate')
  }
```
  - Import `FederationMovedError` from `./errors.js` (add to the existing errors import on line 24).
  - Keep the `isClosed` getter, `_shardVaultProvisioned`, `_resolveBackend` (klum calls the latter two).
  - Remove any now-unused federation type imports flagged by typecheck.

- [ ] **Step 3: Remove the federation type re-exports from `packages/hub/src/index.ts`** — delete lines 318-347 (the `// Federation —` comment block through the last `} from './federation/index.js'`). KEEP line 348 (`STATE_VAULT_NAME` from `./constants.js`) and line 349 (federation error classes, incl. the `FederationMovedError` added in Task 1).

- [ ] **Step 4: Make hub green**
```bash
pnpm --filter @noy-db/hub typecheck
pnpm --filter @noy-db/hub test
pnpm --filter @noy-db/hub build
```
Expected: typecheck clean (fix any dangling federation type references it surfaces — they should only be the ones removed above); full hub suite passes (federation tests are gone); build succeeds with no `dist/federation` chunk.

- [ ] **Step 5: Commit**
```bash
git add packages/hub/
git commit -m "refactor(hub)!: extract federation to @klum-db/lobby; openVaultGroup/etc. now throw FederationMovedError"
```

---

## Task 5 — Update showcases to the Lobby API

**Files:**
- Modify: `showcases/src/98-vault-group-federation.showcase.test.ts`, `99-…`, `100-…`, `108-…`, `109-…`, `110-…`

- [ ] **Step 1: For each of the 6 showcases**, add `import { createLobby } from '@klum-db/lobby'`, introduce `const lobby = createLobby(db)`, and rewrite `db.withVaultTemplate` / `db.openVaultGroup` / `db.openStateManagementVault` → the `lobby.*` equivalents. Federation types imported from `@noy-db/hub` (e.g. `VaultRegistryRow`) → import from `@klum-db/lobby`. Methods on the returned group (`firm.withCrossVaultDerivation`, `firm.refreshInsights`, `firm.query`, …) are unchanged.

- [ ] **Step 2: Ensure showcases can resolve `@klum-db/lobby`** — if `showcases/package.json` lists explicit deps, add `"@klum-db/lobby": "workspace:*"` (devDependency). Check first; the showcases workspace may already resolve all `@*` packages.

- [ ] **Step 3: Run the 6 showcases**
```bash
pnpm --filter ./showcases test -- vault-group federation state-management insight fleet-migration data-residency
```
Expected: all 6 pass against the Lobby API. (Run the whole showcase suite if filtering by name is awkward.)

- [ ] **Step 4: Commit**
```bash
git add showcases/
git commit -m "docs(showcases): use @klum-db/lobby Lobby API for federation showcases"
```

---

## Task 6 — Whole-repo verification + bundle/spec/memory

- [ ] **Step 1: Full monorepo green**
```bash
pnpm build && pnpm test
```
Expected: all build tasks succeed; suite green (the two known unrelated timeout flakes — `as-csv`, `hub` cross-vault `minRole` — may appear; disregard). If anything federation/lobby-related fails, fix before proceeding.

- [ ] **Step 2: Architecture guard proves the boundary**
```bash
pnpm check:architecture
```
Expected: PASS, including the new `no-outbound-klum-import` check (hub has no `@klum-db` imports; klum→hub is the only edge).

- [ ] **Step 3: Confirm hub shrank**
```bash
pnpm --filter @noy-db/hub bundle-check   # canaries must stay ✓; size should DROP vs before (federation chunk gone)
```
Note known stale-baseline drift; judge by canaries + relative drop, not the absolute baseline.

- [ ] **Step 4: Update the spec** — in `docs/superpowers/specs/2026-06-16-lobby-framework-design.md`, mark §9 / §11-step-7 federation re-homing as DONE (Phase 3 shipped), and note the public-API migration (federation types/methods now on `@klum-db/lobby`). Commit.

- [ ] **Step 5: Update memory pointer** — note Phase 3 complete in `project_klum_db_lobby` (controller does this post-merge).

---

## Self-Review

**1. Spec coverage (spec §9, §11 step 7, Phase-3 follow-up):** Task 1 (hub prep + guard) + Task 2 (move + Lobby API) + Task 3 (tests) + Task 4 (removal + shims + public-API drop) + Task 5 (showcases) + Task 6 (verify) cover every item in the spec's Phase-3 list: multi-file move, kernel binding, vault-template→Lobby, deprecation shims, STATE_VAULT_NAME relocation, noy→klum guard, test/showcase migration.

**2. Placeholder scan:** Hub-side changes (Tasks 1, 4) have exact code. Tasks 2/3/5 are move+rewrite governed by the explicit Import-rewrite map and call-rewrite rules — exact transformations, not vague directions. No "handle errors"/"etc." in executable steps.

**3. Green-per-task:** Task 1 additive (hub green). Task 2 additive (klum gains federation; hub untouched — both green; federation duplicated temporarily). Task 3 klum tests green. Task 4 removes from hub (hub green; federation now only in klum). Task 5 showcases green. Task 6 whole-repo green. No task leaves the tree broken at its commit.

**4. Name/type consistency:** `createLobby`/`Lobby.openVaultGroup`/`withVaultTemplate`/`openStateManagementVault` consistent across Tasks 2/3/5. `FederationMovedError`('FEDERATION_MOVED') consistent Tasks 1/4. `isClosed` getter (Task 1) consumed in Task 2. `@noy-db/hub/kernel` import target matches the surface shipped in PR #450 (incl. `NoAccessError`).

**5. Risk notes baked in:** breaking-change called out up top; "STOP and report" guards on any unresolved import or hub-internal a test needs; bundle-check judged by canaries; zsh-safe commands.
