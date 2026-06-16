# klum-db / Lobby Refactor Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `@klum-db/lobby` package in the noy-db monorepo and expose a stable `@noy-db/hub/kernel` API — the foundation the federation extraction (separate plan) binds to.

**Architecture:** `klum-db` is a separate brand/npm org that *orchestrates* noy-db vaults (Docker ↔ container). It is developed **inside the noy-db monorepo first** (publishing `@klum-db/*` from here) and graduates to its own repo once the boundary is proven. This plan does the two low-risk, high-leverage foundation pieces: (1) scaffold `@klum-db/lobby` with full build/test wiring under the `@klum-db` scope; (2) add a `@noy-db/hub/kernel` subpath that re-exports exactly the internal symbols federation needs (`readPath`, `reduceRecords`, `groupAndReduce`, `generateULID`, `sha256Hex`, the federation error classes, and the supporting types). The actual federation move is **out of scope** — see "Phase 3" at the end.

**Tech Stack:** pnpm@9.15.4 workspaces · turbo · tsup (dual ESM-split + CJS) · vitest · TypeScript 5.7 (strict, `moduleResolution: bundler`, `.js` import specifiers).

**Spec:** `docs/superpowers/specs/2026-06-16-lobby-framework-design.md` (§5 unit-tiering, §7 lexicon, §10 packaging, §11 phases).

---

## Scope & decomposition note

This plan covers **spec §11 phases 1–2 only**. Phase 3 (extract `packages/hub/src/federation/` into `@klum-db/lobby`) is deliberately a **separate downstream plan** because its exact shape — inverting the `Noydb` private-state coupling (`vaultTemplates`, `closed`, `_shardVaultProvisioned`, `_resolveBackend`) and the dynamic `import('./federation/...')` integration — must be authored against the **kernel API that Task 3 below creates**. Authoring it now would require speculative placeholders. The "Phase 3 follow-up" section at the end specifies its scope concretely so it can become its own plan immediately after this one lands.

Phases 1–2 produce working, independently-testable software: a wired, building, tested `@klum-db/lobby` package + a tested `@noy-db/hub/kernel` surface. Nothing in `hub`'s existing behaviour changes (Task 3 is purely additive).

---

## File structure

**New package — `packages/lobby/` (`@klum-db/lobby`):**
- `package.json` — manifest under `@klum-db` scope; peer-deps `@noy-db/hub`.
- `tsconfig.json` — extends root base.
- `tsup.config.ts` — dual ESM/CJS single-entry build.
- `vitest.config.ts` — project config, name `lobby`.
- `src/index.ts` — the `Lobby` core class + `createLobby` factory (minimal; federation entry lands in Phase 3).
- `__tests__/lobby.test.ts` — wires `Lobby` over an in-memory `Noydb`.
- `README.md`, `LICENSE`.

**Modified — `packages/hub/` (additive only):**
- `src/kernel/index.ts` — NEW barrel re-exporting the kernel surface.
- `tsup.config.ts` — add `'kernel/index'` entry.
- `package.json` — add `./kernel` subpath export.
- `__tests__/kernel-surface.test.ts` — NEW test asserting the surface.

---

## PHASE 1 — Scaffold `@klum-db/lobby`

### Task 1: Create the package manifest and tooling configs

**Files:**
- Create: `packages/lobby/package.json`
- Create: `packages/lobby/tsconfig.json`
- Create: `packages/lobby/tsup.config.ts`
- Create: `packages/lobby/vitest.config.ts`
- Create: `packages/lobby/README.md`
- Create: `packages/lobby/LICENSE`

- [ ] **Step 1: Create `packages/lobby/package.json`**

```json
{
  "name": "@klum-db/lobby",
  "version": "0.2.0-pre.23",
  "description": "klum-db Lobby — orchestrates a group of sovereign noy-db vaults (federation, interchange, custody). The outward framework to noy-db's inward vault.",
  "license": "MIT",
  "author": "vLannaAi <vicio@lanna.ai>",
  "homepage": "https://github.com/vLannaAi/noy-db/tree/main/packages/lobby#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/vLannaAi/noy-db.git",
    "directory": "packages/lobby"
  },
  "bugs": {
    "url": "https://github.com/vLannaAi/noy-db/issues"
  },
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@noy-db/hub": "workspace:*"
  },
  "devDependencies": {
    "@noy-db/hub": "workspace:*",
    "@noy-db/to-memory": "workspace:*",
    "@types/node": "^22.0.0"
  },
  "keywords": [
    "klum-db",
    "lobby",
    "noy-db",
    "federation",
    "vault-orchestration",
    "data-sovereignty",
    "multi-vault"
  ],
  "publishConfig": {
    "access": "public",
    "tag": "latest"
  }
}
```

- [ ] **Step 2: Create `packages/lobby/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `packages/lobby/tsup.config.ts`**

```typescript
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'es2022',
})
```

- [ ] **Step 4: Create `packages/lobby/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'lobby',
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 5: Create `packages/lobby/README.md`**

```markdown
# @klum-db/lobby

> The **Lobby** — klum-db's outward framework that orchestrates a *group* of sovereign [noy-db](https://github.com/vLannaAi/noy-db) vaults: federation, interchange, and custody. A vault is the container; the Lobby is the orchestrator.

Part of **klum-db** (Thai *klum* กลุ่ม, "group") — developed inside the noy-db monorepo while the kernel boundary stabilizes. See `docs/superpowers/specs/2026-06-16-lobby-framework-design.md`.

```ts
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { createLobby } from '@klum-db/lobby'

const db = await createNoydb({ store: memory(), user: 'alice', secret: '…' })
const lobby = createLobby(db)
```
```

- [ ] **Step 6: Create `packages/lobby/LICENSE`**

Run: `cp packages/at-env/LICENSE packages/lobby/LICENSE`
Expected: file copied (MIT license text, identical to other packages).

- [ ] **Step 7: Install so pnpm links the new workspace package**

Run: `pnpm install`
Expected: completes without error; output mentions the new `@klum-db/lobby` workspace package. (`packages/*` is already a workspace glob, so no `pnpm-workspace.yaml` change is needed.)

- [ ] **Step 8: Commit**

```bash
git add packages/lobby/package.json packages/lobby/tsconfig.json packages/lobby/tsup.config.ts packages/lobby/vitest.config.ts packages/lobby/README.md packages/lobby/LICENSE pnpm-lock.yaml
git commit -m "feat(lobby): scaffold @klum-db/lobby package skeleton"
```

---

### Task 2: Implement the `Lobby` core class (TDD)

**Files:**
- Create: `packages/lobby/__tests__/lobby.test.ts`
- Create: `packages/lobby/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/lobby/__tests__/lobby.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { Lobby, createLobby } from '../src/index.js'

describe('Lobby', () => {
  it('wraps the Noydb instance whose vaults it orchestrates', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'correct-horse-battery-staple',
    })
    const lobby = createLobby(db)
    expect(lobby).toBeInstanceOf(Lobby)
    expect(lobby.noydb).toBe(db)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @klum-db/lobby test`
Expected: FAIL — cannot resolve `../src/index.js` (file does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `packages/lobby/src/index.ts`:

```typescript
/**
 * **@klum-db/lobby** — the Lobby: klum-db's outward framework that
 * orchestrates a *group* of sovereign noy-db vaults.
 *
 * A noy-db vault is a complete, sovereign unit (the container). The
 * Lobby is what holds many of them side by side (the commons) and is
 * the way in (the entrance) — federation, interchange, and custody.
 *
 * This is the foundation surface; federation entry points
 * (`openVaultGroup`, `openStateManagementVault`) land when the
 * federation subsystem is extracted from `@noy-db/hub` (Phase 3).
 *
 * @packageDocumentation
 */

import type { Noydb } from '@noy-db/hub'

/**
 * Orchestrates a group of sovereign noy-db vaults sharing one
 * {@link Noydb} runtime (one store, one keyring root).
 */
export class Lobby {
  /** The Noydb runtime whose vaults this Lobby orchestrates. */
  readonly noydb: Noydb

  constructor(noydb: Noydb) {
    this.noydb = noydb
  }
}

/** Create a {@link Lobby} over an existing {@link Noydb} runtime. */
export function createLobby(noydb: Noydb): Lobby {
  return new Lobby(noydb)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @klum-db/lobby test`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck and build**

Run: `pnpm --filter @klum-db/lobby typecheck && pnpm --filter @klum-db/lobby build`
Expected: typecheck clean; build emits `packages/lobby/dist/index.js`, `index.cjs`, `index.d.ts`, `index.d.cts`.

- [ ] **Step 6: Verify the monorepo architecture check accepts the new package**

Run: `pnpm check:architecture`
Expected: PASS. If it fails because `@klum-db/lobby` is an unknown package/scope, open `scripts/check-architecture.mjs`, find the package/family allowlist or layering map, and add `@klum-db/lobby` as a package that is **allowed to depend on `@noy-db/hub`** (klum → noy is the permitted direction; noy → klum must remain forbidden). Re-run until green.

- [ ] **Step 7: Commit**

```bash
git add packages/lobby/src/index.ts packages/lobby/__tests__/lobby.test.ts
# include scripts/check-architecture.mjs only if it was edited in Step 6
git commit -m "feat(lobby): Lobby core class wrapping a Noydb runtime"
```

---

## PHASE 2 — `@noy-db/hub/kernel` stable surface

### Task 3: Create the kernel barrel and its test (TDD)

**Files:**
- Create: `packages/hub/__tests__/kernel-surface.test.ts`
- Create: `packages/hub/src/kernel/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/hub/__tests__/kernel-surface.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import * as kernel from '../src/kernel/index.js'
// Type-only smoke: fails to compile if any of these types stop being exported.
import type {
  ChangeEvent, Vault, Collection, Noydb, Operator, Query, JoinStrategy,
  LiveQuery, AggregateResult, AggregateSpec, LiveAggregation, IndexDef,
} from '../src/kernel/index.js'

describe('@noy-db/hub/kernel surface', () => {
  it('exposes the runtime kernel functions federation needs', () => {
    expect(typeof kernel.readPath).toBe('function')
    expect(typeof kernel.reduceRecords).toBe('function')
    expect(typeof kernel.groupAndReduce).toBe('function')
    expect(typeof kernel.generateULID).toBe('function')
    expect(typeof kernel.sha256Hex).toBe('function')
  })

  it('exposes the federation error classes', () => {
    const names = [
      'CrossShardJoinError', 'DataResidencyError', 'ReservedVaultNameError',
      'ShardProvisioningError', 'UnknownShardError', 'ValidationError',
      'VaultTemplateNotFoundError',
    ] as const
    for (const n of names) {
      expect(typeof (kernel as Record<string, unknown>)[n]).toBe('function')
    }
  })

  it('generateULID returns a 26-char Crockford ULID', () => {
    expect(kernel.generateULID()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})

// Compile-time assertion that the type surface is present (no runtime cost).
type _TypeSurface = [
  ChangeEvent, Vault, Collection, Noydb, Operator, Query, JoinStrategy,
  LiveQuery, AggregateResult, AggregateSpec, LiveAggregation, IndexDef,
]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @noy-db/hub test -- kernel-surface`
Expected: FAIL — cannot resolve `../src/kernel/index.js` (does not exist yet).

- [ ] **Step 3: Create the kernel barrel**

Create `packages/hub/src/kernel/index.ts`:

```typescript
/**
 * **@noy-db/hub/kernel** — the stable internal surface that outward
 * frameworks (klum-db / Lobby) bind to *instead of* reaching into hub
 * internals via relative paths.
 *
 * This is the "kernel-surface extraction" (spec §10): the minimal set
 * of runtime helpers, error classes, and types the federation /
 * orchestration layer needs from the vault core. Treat it as a
 * contract — additive changes only; removals are breaking.
 *
 * @packageDocumentation
 */

// ─── runtime helpers ──────────────────────────────────────────────
export { readPath } from '../query/predicate.js'
export { reduceRecords } from '../aggregate/aggregation.js'
export { groupAndReduce } from '../aggregate/groupby.js'
export { generateULID } from '../bundle/ulid.js'
export { sha256Hex } from '../crypto.js'

// ─── error classes ────────────────────────────────────────────────
export {
  CrossShardJoinError,
  DataResidencyError,
  ReservedVaultNameError,
  ShardProvisioningError,
  UnknownShardError,
  ValidationError,
  VaultTemplateNotFoundError,
} from '../errors.js'

// ─── types ────────────────────────────────────────────────────────
export type { ChangeEvent } from '../types.js'
export type { Vault } from '../vault.js'
export type { Collection } from '../collection.js'
export type { Noydb } from '../noydb.js'
export type { Operator } from '../query/predicate.js'
export type { Query } from '../query/builder.js'
export type { JoinStrategy } from '../query/join.js'
export type { LiveQuery } from '../query/live.js'
export type {
  AggregateResult,
  AggregateSpec,
  LiveAggregation,
} from '../aggregate/aggregation.js'
export type { IndexDef } from '../indexing/eager-indexes.js'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @noy-db/hub test -- kernel-surface`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/hub/src/kernel/index.ts packages/hub/__tests__/kernel-surface.test.ts
git commit -m "feat(hub): add @noy-db/hub/kernel stable internal surface"
```

---

### Task 4: Publish the `./kernel` subpath (build wiring)

**Files:**
- Modify: `packages/hub/tsup.config.ts:51` (add to `ENTRIES`)
- Modify: `packages/hub/package.json:269-278` (add `./kernel` export after `./attestation`)

- [ ] **Step 1: Add the tsup entry**

In `packages/hub/tsup.config.ts`, inside the `ENTRIES` object, add this line immediately after `'attestation/index': 'src/attestation/index.ts',`:

```typescript
  'kernel/index': 'src/kernel/index.ts',
```

- [ ] **Step 2: Add the package export**

In `packages/hub/package.json`, in the `"exports"` map, add this block immediately after the `"./attestation": { … }` block (after the closing `}` on line 278, before the `}` that closes `"exports"`):

```json
    ,"./kernel": {
      "import": {
        "types": "./dist/kernel/index.d.ts",
        "default": "./dist/kernel/index.js"
      },
      "require": {
        "types": "./dist/kernel/index.d.cts",
        "default": "./dist/kernel/index.cjs"
      }
    }
```

(If you prefer trailing-comma-free JSON: put the comma after the `./attestation` block's closing brace instead and drop the leading comma above — the result must be valid JSON. Verify with `node -e "require('./packages/hub/package.json')"`.)

- [ ] **Step 3: Build hub and verify the subpath artifacts exist**

Run: `pnpm --filter @noy-db/hub build`
Expected: build succeeds; then:

Run: `ls packages/hub/dist/kernel/`
Expected: lists `index.js`, `index.cjs`, `index.d.ts`, `index.d.cts`.

- [ ] **Step 4: Verify the subpath resolves as a real package export**

Run: `node --input-type=module -e "import('@noy-db/hub/kernel').then(m => { if (typeof m.generateULID !== 'function') throw new Error('kernel subpath broken'); console.log('kernel subpath OK:', m.generateULID().length) })"`
Expected: prints `kernel subpath OK: 26`. (Resolves the built `@noy-db/hub/kernel` via the workspace symlink + the new export map.)

- [ ] **Step 5: Confirm nothing else regressed**

Run: `pnpm --filter @noy-db/hub test`
Expected: PASS (full hub suite, including the new kernel-surface test). Then:

Run: `pnpm --filter @noy-db/hub bundle-check`
Expected: PASS or the pre-existing baseline drift only (per `project_bundle_baseline_stale` — judge by leak canaries, not headline gz; the new `kernel` subpath must not pull federation/orchestration code into the main bundle).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/tsup.config.ts packages/hub/package.json
git commit -m "feat(hub): export ./kernel subpath (dual ESM/CJS)"
```

---

### Task 5: Point `@klum-db/lobby` at the kernel (proves the boundary)

**Files:**
- Modify: `packages/lobby/package.json` (add `@noy-db/hub/kernel` usage is via the existing `@noy-db/hub` dep — no manifest change needed)
- Modify: `packages/lobby/__tests__/lobby.test.ts` (add a kernel-consumption test)

- [ ] **Step 1: Write a failing test that consumes the kernel from Lobby's side**

Append to `packages/lobby/__tests__/lobby.test.ts`:

```typescript
import { generateULID } from '@noy-db/hub/kernel'

describe('kernel boundary', () => {
  it('Lobby can consume the @noy-db/hub/kernel surface', () => {
    const id = generateULID()
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })
})
```

- [ ] **Step 2: Run it to verify it passes (kernel was built in Task 4)**

Run: `pnpm --filter @klum-db/lobby test`
Expected: PASS (2 describe blocks). This proves `@klum-db/lobby` resolves and consumes the stable kernel surface across the package boundary — the exact channel Phase 3's federation code will use.

- [ ] **Step 3: Full-monorepo green check**

Run: `pnpm build && pnpm test`
Expected: turbo builds all packages and the full suite passes. (Confirms the new package + subpath integrate with the existing pipeline.)

- [ ] **Step 4: Commit**

```bash
git add packages/lobby/__tests__/lobby.test.ts
git commit -m "test(lobby): consume @noy-db/hub/kernel across the package boundary"
```

---

## PHASE 3 — Federation extraction (SEPARATE follow-up plan)

**Not part of this plan's checklist.** Author this as its own plan (`docs/superpowers/plans/<date>-klum-db-federation-extraction.md`) once Phases 1–2 land, because its precise steps depend on the kernel API created above and on inverting `Noydb` private-state coupling. Concrete scope for that plan:

1. **Extend the kernel** with the inversion hooks federation entry points need from `Noydb`: a stable way to read `closed` state and call `_shardVaultProvisioned` / `_resolveBackend`. Move the **vault-template registry** (`withVaultTemplate` / `vaultTemplates`) out of `Noydb` into the `Lobby` (templates are a federation concern).
2. **Relocate `STATE_VAULT_NAME`** from `packages/hub/src/federation/constants.ts` to a hub-core file (`packages/hub/src/constants.ts`); update `noydb.ts:25` and `index.ts:348` imports. The reserved-name guard (`noydb.ts:1106`) stays in hub.
3. **Move** `packages/hub/src/federation/*` (10 files: `vault-group`, `aggregate-across`, `cross-shard-join`, `cross-vault-live`, `state-vault`, `schema-manifest`, `classify-skip`, `types`, `index`, `constants`-minus-STATE_VAULT_NAME) into `packages/lobby/src/federation/`, rewriting every `../X.js` hub-internal import to `@noy-db/hub/kernel` (per the kernel map) and `Noydb`/`Vault`/`Collection` to `@noy-db/hub`.
4. **Implement Lobby entry points** (`Lobby.withVaultTemplate`, `Lobby.openVaultGroup`, `Lobby.openStateManagementVault`) in klum-db, lifting the logic from `noydb.ts:1095–1148`, reading templates from the Lobby instead of `db.vaultTemplates`.
5. **Deprecation shims in hub:** replace `Noydb.openVaultGroup` / `openStateManagementVault` / `withVaultTemplate` bodies with a new `FederationMovedError` (added to `errors.ts`) + one-time `console.warn`, pointing to `@klum-db/lobby`. (Pre-1.0 throwing shim — no `hub → klum` dependency, preserving the acyclic architecture.) Remove the federation type re-exports from `index.ts:318–347`; they move to `@klum-db/lobby`'s public API.
6. **Migrate tests:** move the 7 `packages/hub/__tests__/federation-*.test.ts` to `packages/lobby/__tests__/`, rewriting them to the Lobby API.
7. **Update showcases** 98, 99, 100, 108, 109, 110 in `showcases/src/` to import from `@klum-db/lobby`.
8. **Verify** `pnpm check:architecture` (noy → klum must remain forbidden; klum → noy allowed), full `pnpm build && pnpm test`, and `bundle-check` (hub core shrinks; federation chunk gone).

---

## Self-Review

**1. Spec coverage (§11 phases 1–2):**
- §11.1 "Establish Lobby package skeleton + unit-driver contract" → Tasks 1–2 establish the package + `Lobby` class. (Unit-driver *contract* is deferred with Phase 3/§5 — the foundation only needs the package + core class; noted, not silently dropped.)
- §11.2 "Kernel-surface extraction — stable internal vault API" → Tasks 3–4 (`@noy-db/hub/kernel`) + Task 5 proves cross-boundary consumption.
- §11.3+ (federation move) → explicitly scoped to the Phase 3 follow-up plan.

**2. Placeholder scan:** No "TBD/TODO/handle errors" in executable steps. Every code step shows complete file contents or the exact lines to insert. The Phase 3 section is labelled non-executable design, not a placeholder in the checklist.

**3. Type/name consistency:** `Lobby` / `createLobby` used identically in Tasks 1, 2, 5. Kernel symbol names (`readPath`, `reduceRecords`, `groupAndReduce`, `generateULID`, `sha256Hex`, the 7 error classes, the 12 types) match the verified hub source. `@noy-db/hub/kernel` path is consistent across the barrel, the export map, the tsup entry, and both consuming tests. Package name `@klum-db/lobby` and dir `packages/lobby` consistent throughout.

**4. Known environmental caveats baked in:** zsh word-splitting avoided (no unquoted list vars in commands); `bundle-check` baseline-drift expectation noted; architecture-check allowlist update flagged as a conditional step; no publish steps (publishing is gated on explicit confirmation, out of scope here).
