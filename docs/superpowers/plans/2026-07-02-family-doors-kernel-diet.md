# S5 Family Doors + Kernel Diet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the hub a countable, golden-frozen contract-per-family interface ("doors"), rename adapter→to / bundle→pod / subsystem→service, evict ~2,100 LOC of secondary code from the kernel, and freeze the kernel API, root barrel, and enclave surfaces.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-02-family-doors-kernel-diet-design.md` (read it first — the door table, layering law, and naming table there are binding). All moves are behavior-preserving `git mv` + import rewrites with the suite pinned green; new public surfaces get golden tests mirroring the existing four (`__tests__/{kernel,cargo,adapter,pod}-surface-golden.test.ts`).

**Tech Stack:** pnpm + turbo monorepo, tsup builds, vitest, `scripts/check-architecture.mjs` guards.

## Global Constraints

- **Never** add Claude attribution to commits/PRs. Never reference the private pilot client. Never publish.
- Every phase validates with the FULL cross-package suite: `pnpm turbo test --concurrency=1 --filter '!@noy-db/showcases'` (from repo root) — hub-only validation is forbidden for hub API changes. Plus `pnpm check:architecture`, `pnpm turbo typecheck`, `pnpm turbo lint`.
- DTS builds need `NODE_OPTIONS=--max-old-space-size=8192` (already set in CI; export locally if tsup OOMs).
- Renamed symbols ALWAYS keep a deprecated alias: `/** @deprecated Use newName. */ export const oldName = newName` (values) or `export type OldName = NewName` (types). Error-class aliases must preserve `instanceof` for the OLD name → alias the same class object, never subclass.
- Layering law (spec): imports point inward only — `family → door → service layer → kernel spine → enclave`. Kernel spine never statically imports `with-*` or a door folder (except `kernel/with/`); dynamic `import()` is allowed (S4 gates).
- **Exempt from bundle→pod:** the JS bundle-size gate, `bundle-manifest.json`, "bundler" wording, the `.noydb` file extension.
- Commit style: match `git log` conventions (`refactor(hub): …`, `feat(hub): …`), no footer.
- Work on branch `s5-family-doors` off `main`.

---

### Task 1: E1 — evict store plumbing from the kernel

**Files:**
- Create: `packages/hub/src/with-store/index.ts`
- Move (git mv): `packages/hub/src/kernel/store/route-store.ts` → `packages/hub/src/with-store/route-store.ts`; `packages/hub/src/kernel/store/store-middleware.ts` → `packages/hub/src/with-store/store-middleware.ts`; `packages/hub/src/kernel/store/bundle-store.ts` → `packages/hub/src/with-pod/pod-store.ts`
- Modify: `packages/hub/src/kernel/store/index.ts` (shrink), `packages/hub/src/index.ts` (re-point re-exports), `packages/hub/package.json` (remove `./store` subpath), `packages/hub/tsup.config.ts` (remove the `store/index` entry, add nothing — with-store is root-barrel-only), any `*.test.ts` importing the moved files (fix relative paths only)
- Test: existing suite (behavior-preserving); `packages/hub/__tests__/pod-surface-golden.test.ts` baseline update in Step 5

**Interfaces:**
- Consumes: current `kernel/store/index.ts` exports (routeStore, wrapStore, withRetry, withLogging, withMetrics, withCircuitBreaker, withCache, withHealthCheck, wrapBundleStore, createBundleStore, SyncScheduler, INDEXED_STORE_POLICY, BUNDLE_STORE_POLICY + their types).
- Produces: `src/with-store/index.ts` exporting routeStore + wrapStore family + all their types; `src/with-pod/pod-store.ts` exporting `wrapPodStore`, `createPodStore` (renamed) + deprecated aliases `wrapBundleStore`, `createBundleStore` + types `WrappedPodNoydbStore` (alias `WrappedBundleNoydbStore`), `WrapPodStoreOptions` (alias `WrapBundleStoreOptions`). Later tasks rely on these exact names.

- [ ] **Step 1: Pin the baseline green.** Run `pnpm turbo test --concurrency=1 --filter '!@noy-db/showcases'` from repo root. Expected: all pass. Record the count.
- [ ] **Step 2: Move the files** with `git mv` as listed above. In `pod-store.ts`, rename `wrapBundleStore`→`wrapPodStore`, `createBundleStore`→`createPodStore`, `WrappedBundleNoydbStore`→`WrappedPodNoydbStore`, `WrapBundleStoreOptions`→`WrapPodStoreOptions` and append at the end of the file:

```ts
/** @deprecated Use wrapPodStore. */
export const wrapBundleStore = wrapPodStore
/** @deprecated Use createPodStore. */
export const createBundleStore = createPodStore
/** @deprecated Use WrappedPodNoydbStore. */
export type WrappedBundleNoydbStore = WrappedPodNoydbStore
/** @deprecated Use WrapPodStoreOptions. */
export type WrapBundleStoreOptions = WrapPodStoreOptions
```

- [ ] **Step 3: Create `src/with-store/index.ts`** — a barrel with the routing + middleware export blocks copied verbatim from the old `kernel/store/index.ts` (named re-exports, not `export *`). Shrink `kernel/store/index.ts` to only memory-store, sync-policy, and the contract-adjacent error re-export. Add `export * from './with-store/index.js'` is FORBIDDEN — instead update the existing named re-exports in `src/index.ts` to point at the new paths (root barrel exports must not change their names). Also re-export `wrapPodStore`/`createPodStore` + old aliases from `src/with-pod/index.ts` and keep the root barrel's old names working.
- [ ] **Step 4: Remove the `./store` subpath** from `packages/hub/package.json` `exports` and its tsup entry. Grep the whole repo for consumers first: `grep -rn "hub/store'" packages test-harnesses playground` — fix any hit to import from `@noy-db/hub` root. Expected: few or zero hits.
- [ ] **Step 5: Update `pod-surface.golden.json`** — run `pnpm vitest run __tests__/pod-surface-golden.test.ts` in packages/hub; it fails listing the new exports (`wrapPodStore`, `createPodStore`, aliases, types); add them to the baseline JSON (keep old names too).
- [ ] **Step 6: Full validation.** `pnpm turbo build && pnpm turbo test --concurrency=1 --filter '!@noy-db/showcases' && pnpm check:architecture && pnpm turbo typecheck && pnpm turbo lint`. Expected: all green, same test count as Step 1 (+ golden additions).
- [ ] **Step 7: Commit** `refactor(hub): evict store plumbing from kernel (with-store service, pod-store)`

### Task 2: N1 — bundle→pod symbol sweep

**Files:**
- Modify: every `packages/hub/src/**` file exporting/using the symbols below (locate with the greps given), `packages/hub/src/index.ts`, `packages/hub/src/with-pod/**`, `packages/hub/src/kernel/errors.ts`, `packages/hub/src/kernel/store/sync-policy.ts`, golden baselines `__tests__/pod-surface.golden.json`, `__tests__/adapter-surface.golden.json` (only if a renamed type appears there), `__tests__/cargo-surface.golden.json` (same condition)

**Interfaces:**
- Produces (canonical names later tasks and the `/as` door use): `writePod`, `readPod`, `readPodHeader`, `WritePodOptions`, `NoydbPodHeader`, `NoydbPodStore`, `PodVersionConflictError`, `POD_STORE_POLICY`. Old names remain as deprecated aliases.

- [ ] **Step 1: Rename with aliases.** For each pair, rename the definition and add a deprecated alias next to it (value aliases as `export const old = new`; type aliases as `export type Old = New`; interface `NoydbBundleStore` → rename to `NoydbPodStore` in `kernel/types.ts` and add `/** @deprecated */ export type NoydbBundleStore = NoydbPodStore`):
  - `writeNoydbBundle`→`writePod`, `readNoydbBundle`→`readPod`, `readNoydbBundleHeader`→`readPodHeader`, `WriteNoydbBundleOptions`→`WritePodOptions`, `NoydbBundleHeader`→`NoydbPodHeader` (in `with-pod/`)
  - `NoydbBundleStore`→`NoydbPodStore` (in `kernel/types.ts`)
  - `BundleVersionConflictError`→`PodVersionConflictError` (in `kernel/errors.ts`): rename the class, then `/** @deprecated Use PodVersionConflictError. */ export const BundleVersionConflictError = PodVersionConflictError` + `export type BundleVersionConflictError = PodVersionConflictError` (preserves `instanceof`)
  - `BUNDLE_STORE_POLICY`→`POD_STORE_POLICY` (in `kernel/store/sync-policy.ts`)
  Find every use: `grep -rn "writeNoydbBundle\|readNoydbBundle\|NoydbBundleStore\|NoydbBundleHeader\|WriteNoydbBundleOptions\|BundleVersionConflictError\|BUNDLE_STORE_POLICY" packages/hub/src packages/hub/__tests__` and switch internal uses to the new names (aliases are for external consumers only). Root barrel + `/bundle` + `/pod` subpath barrels export BOTH names.
- [ ] **Step 2: Update golden baselines** by running `pnpm vitest run __tests__` in packages/hub and adding the new names beside the old in each failing `*.golden.json`.
- [ ] **Step 3: Full validation** (Global Constraints command set). Also confirm the exempt names survived untouched: `git diff --stat | grep -i manifest` → no `bundle-manifest.json` change.
- [ ] **Step 4: Commit** `refactor(hub): bundle→pod canonical naming (deprecated aliases kept)`

### Task 3: N2a — the `/to` door

**Files:**
- Create: `packages/hub/src/kernel/to/index.ts`, `packages/hub/__tests__/to-surface-golden.test.ts`, `packages/hub/__tests__/to-surface.golden.json`
- Move (git mv): `kernel/store/memory-store.ts` → `kernel/to/memory-store.ts`; `kernel/store/sync-policy.ts` → `kernel/to/sync-policy.ts`; then delete the emptied `kernel/store/` (its index shrank in Task 1)
- Modify: `kernel/adapter/index.ts` (becomes deprecated alias), `packages/hub/package.json` (+`./to` subpath), `packages/hub/tsup.config.ts` (+`to/index` entry, adjust store/adapter entries), `src/index.ts` import paths, all in-repo imports of the moved files

**Interfaces:**
- Consumes: the adapter barrel's 12 exports (4 error values: `ConflictError, NetworkError, StoreCapabilityError, BundleVersionConflictError`; 8 types: `NoydbStore, NoydbBundleStore, EncryptedEnvelope, VaultSnapshot, TxOp, StoreCapabilities, StoreTime, ListPageResult`) and Task 2's renames.
- Produces: `@noy-db/hub/to` = the adapter exports PLUS the pod-renamed canonical names (`NoydbPodStore`, `PodVersionConflictError`). `/adapter` alias unchanged in content. `kernel/to/` is the physical home later tasks reference.

- [ ] **Step 1: Create `kernel/to/index.ts`** with the same named re-exports as `kernel/adapter/index.ts`, plus `NoydbPodStore` and `PodVersionConflictError`. Replace `kernel/adapter/index.ts` body with:

```ts
/**
 * @deprecated `@noy-db/hub/adapter` is the legacy name of the `to-*` family door.
 * Import from `@noy-db/hub/to` instead. Kept for published pins; removal only
 * with a coordinated version bump.
 */
export * from '../to/index.js'
```

- [ ] **Step 2: git mv** memory-store + sync-policy into `kernel/to/`, delete `kernel/store/`, fix every import path (`grep -rn "kernel/store\|store/memory-store\|store/sync-policy" packages/hub/src packages/hub/__tests__`).
- [ ] **Step 3: Wire the subpath**: add `./to` to package.json exports (same shape as `./adapter`) and tsup entry `'to/index': 'src/kernel/to/index.ts'`.
- [ ] **Step 4: Golden test**: copy `__tests__/adapter-surface-golden.test.ts` to `to-surface-golden.test.ts`, change the import to `../src/kernel/to/index.js`, baseline path to `to-surface.golden.json`, and the describe title to `/to`. Generate the baseline: run it once, paste the reported actual surface into the JSON, re-run → PASS. The adapter golden must still pass byte-identical.
- [ ] **Step 5: Full validation + commit** `feat(hub): /to door — store contract takes the family name (/adapter deprecated alias)`

### Task 4: N2a — the `/with` and `/ui` doors

**Files:**
- Create: `packages/hub/src/kernel/with/index.ts`, `packages/hub/src/kernel/ui/index.ts`, `__tests__/with-surface-golden.test.ts` + `.golden.json`, `__tests__/ui-surface-golden.test.ts` + `.golden.json`
- Move (git mv): `kernel/subsystem-bus.ts` → `kernel/with/service-bus.ts`; `kernel/write-hooks.ts` → `kernel/with/write-hooks.ts`; `kernel/capabilities.ts` → `kernel/with/capabilities.ts`; `src/describe.ts` → `kernel/ui/index.ts`
- Modify: package.json (+`./with`, +`./ui`; `./describe` re-pointed), tsup entries, `src/index.ts`, all importers of the moved files

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `ServiceBus` class (renamed from `SubsystemBus`, with `/** @deprecated Use ServiceBus. */ export const SubsystemBus = ServiceBus` + matching type alias) at `kernel/with/service-bus.ts`; `@noy-db/hub/ui` = the old `/describe` export set; `src/describe.ts` no longer exists (new file `src/describe.ts` NOT retained — the `./describe` subpath's tsup entry points at `kernel/ui/index.ts`).

- [ ] **Step 1: git mv the three seam files** into `kernel/with/`, rename class `SubsystemBus`→`ServiceBus` inside (add the deprecated aliases beside it), create the `kernel/with/index.ts` barrel with named re-exports of everything the three files export today (enumerate with `grep -n '^export' kernel/with/*.ts`). Fix all importers: `grep -rn "subsystem-bus\|write-hooks\|capabilities" packages/hub/src packages/hub/__tests__ --include='*.ts' -l`.
- [ ] **Step 2: git mv `src/describe.ts` → `kernel/ui/index.ts`**; fix `src/index.ts` re-export; package.json: add `./ui` pointing at `dist/ui/index.*`, re-point `./describe` at the same dist files (alias at the exports-map level — no stub file needed) and mark the mapping with a JSON comment? JSON has no comments — instead document the alias in `kernel/ui/index.ts` header JSDoc. tsup: rename the describe entry to `'ui/index': 'src/kernel/ui/index.ts'`, keep an additional `'describe/index'` entry pointing at the same source so `dist/describe/index.js` continues to exist for the old subpath.
- [ ] **Step 3: Goldens** for `/with` and `/ui` — same recipe as Task 3 Step 4 (copy adapter golden test, adjust import/baseline/title, generate baseline, PASS). The existing `describe-contract.test.ts` must still pass unmodified.
- [ ] **Step 4: Full validation + commit** `feat(hub): /with and /ui doors (ServiceBus rename, describe relocated)`

### Task 5: N2a — the `/by` door + coordination provider eviction (E2)

**Files:**
- Create: `packages/hub/src/kernel/by/index.ts`, `__tests__/by-surface-golden.test.ts` + `.golden.json`
- Move (git mv): `kernel/coordination/types.ts` → `kernel/by/types.ts`; `kernel/coordination/index.ts` content merges into `kernel/by/index.ts`; `kernel/coordination/store-provider.ts` → `packages/hub/src/with-shape/schema-update/store-coordination-provider.ts`; delete `kernel/coordination/`
- Modify: `kernel/noydb.ts` (the default-provider construction site, ~line 254), package.json (+`./by`), tsup, `src/kernel/index.ts` + `src/with-cargo/index.ts` (their coordination re-export paths), all importers

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `@noy-db/hub/by` = `isQuorum`, `runDrainBarrier` (values) + `CoordinationProvider`, `WriterPresence`, `FenceState`, `DrainBarrierOptions` (types). `StoreCoordinationProvider` lives in with-shape and is imported by `noydb.ts` — see Step 2 for the allowed form.

- [ ] **Step 1: Build `kernel/by/`** from the coordination folder (barrel = current `coordination/index.ts` surface minus `StoreCoordinationProvider`). Update `/kernel` and `/cargo` barrels' import paths — their EXPORTED SURFACE must not change (goldens prove it).
- [ ] **Step 2: Move `store-provider.ts` to with-shape.** In `noydb.ts`, the ctor currently constructs it unconditionally as the default `coordinationStrategy`. It already imports from `with-shape/schema-update` transitively via this file — moving the file makes that import direct, which the layering law forbids as a static spine→service import. Replace with a lazy dynamic factory: keep a `coordinationProvider` field initialized to `null` and construct on first use via the schema-update strategy path if one is registered; if the current wiring resists a lazy rewrite in <50 LOC, the fallback is: leave a 10-line `kernel/by/default-provider.ts` that does `await import('../../with-shape/schema-update/store-coordination-provider.js')` (dynamic import is allowed by the law). Report which variant you used.
- [ ] **Step 3: Golden** for `/by` (Task 3 Step 4 recipe). `/kernel` + `/cargo` goldens must pass byte-identical.
- [ ] **Step 4: Add the `door-layering` check** to `scripts/check-architecture.mjs`: a new check that (a) scans STATIC imports (`import … from '…'` — ignore `import(` dynamic calls) in kernel spine files (`src/kernel/*.ts`, `src/kernel/{query,enclave,cache,util,meta,policy}/**`) and fails on any path resolving into `src/with-*/` or `src/kernel/{to,on,at,in,by,ui}/`; (b) fails on any import from one door folder into another. Allow spine→`kernel/with/` and anything→`kernel/types.js|errors.js`. Follow the style of the existing checks in that file (each check is a named function pushing to failures). Add door folders that don't exist yet (`on`, `at`, `in`) to the list now — the check must not crash on missing dirs.
- [ ] **Step 5: Full validation + commit** `feat(hub): /by door, coordination provider to with-shape, door-layering guard`

### Task 6: N2b — the `/on`, `/at`, `/in` doors + `/as` layer door

**Files:**
- Create: `kernel/on/index.ts`, `kernel/at/index.ts`, `kernel/in/index.ts`, `packages/hub/src/as/index.ts`, four golden test pairs (`on|at|in|as-surface-golden.test.ts` + `.golden.json`)
- Modify: package.json (+`./on ./at ./in ./as`), tsup (4 entries)

**Interfaces:**
- Consumes: Task 2 names (`writePod`, `WritePodOptions`, `readPodHeader`, `NoydbPodHeader`), `diffVault` + `VaultDiff` from `with-cargo`.
- Produces: four subpaths. These are RE-EXPORT barrels — no file moves. Exact contents:

```ts
// kernel/on/index.ts — the on-* unlock family door
export { mintPaperRecoveryEntry } from '<locate: grep -rn "export function mintPaperRecoveryEntry" src/>'
export type { UnlockedKeyring, Role, Permissions, SlotRewrapContext, EnrollAuthenticatorOptions, PaperRecoveryEntry } from '<locate each: grep -rn "export (interface|type) <Name>" src/kernel/>'

// kernel/at/index.ts — the at-* sealing family door
export type { SealingKeyProvider } from '<locate>'  // plus the option/result types its methods reference — enumerate from the SealingKeyProvider declaration's signature types and re-export each

// kernel/in/index.ts — the in-* framework family door (types only)
export type { Noydb } from '../noydb.js'
export type { Vault } from '../vault.js'
export type { Collection } from '../collection.js'
export type { Query } from '../query/builder.js'
export type { LiveQuery } from '../query/live.js'
export type { ChangeEvent } from '../types.js'

// src/as/index.ts — the as-* exporter family door (LAYER door: may import services)
export { diffVault } from '../with-cargo/vault-diff.js'
export type { VaultDiff } from '../with-cargo/vault-diff.js'
export { writePod, readPod, readPodHeader } from '../with-pod/index.js'
export type { WritePodOptions, NoydbPodHeader } from '../with-pod/index.js'
export type { Vault } from '../kernel/vault.js'
```

  (The `<locate>` markers are grep instructions, not omissions: run the command, confirm the export exists, use the real relative path. If a listed type name does not exist verbatim, STOP and report — do not guess a substitute.)
- [ ] **Step 1: Create the four barrels** as specified, resolving each `<locate>`.
- [ ] **Step 2: Wire subpaths + tsup entries** (`'on/index': 'src/kernel/on/index.ts'`, etc.; `'as/index': 'src/as/index.ts'`).
- [ ] **Step 3: Goldens ×4** (Task 3 Step 4 recipe; note `/on`,`/at`,`/in` are mostly type-only — the golden mechanism's source-parse side covers them).
- [ ] **Step 4: door-layering check** must pass: `/as` importing with-cargo/with-pod is legal (layer door — ensure the check treats `src/as/` as layer-door, not kernel).
- [ ] **Step 5: Full validation + commit** `feat(hub): /on /at /in /as family doors with golden surfaces`

### Task 7: E3 — public-envelope → with-party/directory

**Files:**
- Move (git mv): `kernel/meta/public-envelope/` → `packages/hub/src/with-party/directory/public-envelope/`
- Modify: `kernel/noydb.ts` (facade methods `setPublicEnvelope` ~1949, `getPublicEnvelope` ~1987, the lazy `publicEnvelopeSchema` field), all importers (`grep -rn "public-envelope" packages/hub/src packages/hub/__tests__ -l`)

**Interfaces:**
- Consumes: door-layering check from Task 5 (it must pass after this move).
- Produces: no public-surface change (root barrel exports unchanged — goldens prove it).

- [ ] **Step 1: git mv** the folder; fix static importers OUTSIDE the spine to the new path.
- [ ] **Step 2: Convert the noydb.ts facade to dynamic import** — both methods are async; replace the static import with `const { … } = await import('../with-party/directory/public-envelope/index.js')` inside the method bodies (module caching makes repeat calls cheap). The lazy schema field moves behind the same import.
- [ ] **Step 3: Full validation** (door-layering must be green) **+ commit** `refactor(hub): public-envelope to with-party/directory (spine keeps dynamic facade)`

### Task 8: M — kernel API + root barrel manifests

**Files:**
- Create: `packages/hub/__tests__/kernel-api-surface-golden.test.ts`, `__tests__/kernel-api.golden.json`, `__tests__/root-barrel-surface-golden.test.ts`, `__tests__/root-barrel-surface.golden.json`

**Interfaces:**
- Consumes: final post-move state of Tasks 1–7.
- Produces: the frozen manifests every later PR must consciously edit.

- [ ] **Step 1: kernel-api golden test:**

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Noydb } from '../src/kernel/noydb.js'
import { Vault } from '../src/kernel/vault.js'
import { Collection } from '../src/kernel/collection.js'

const golden = JSON.parse(readFileSync(join(__dirname, 'kernel-api.golden.json'), 'utf8'))

const publicApi = (proto: object) =>
  Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor' && !n.startsWith('_'))
    .sort()

describe('kernel API manifest (the microkernel interface — additions and removals are deliberate baseline edits)', () => {
  it.each([
    ['Noydb', Noydb.prototype],
    ['Vault', Vault.prototype],
    ['Collection', Collection.prototype],
  ] as const)('%s public surface is frozen', (name, proto) => {
    expect(publicApi(proto)).toEqual(golden[name])
  })
})
```

  If those classes are not exported from those exact paths, locate with `grep -rn "export class Noydb\b\|export class Vault\b\|export class Collection\b" packages/hub/src/kernel/` and adjust imports — do not import from the root barrel (that would couple this test to Task 8's other golden).
- [ ] **Step 2: Generate the baseline**: run with `kernel-api.golden.json` containing `{"Noydb":[],"Vault":[],"Collection":[]}`, paste the three actual sorted arrays from the failure diff, re-run → PASS.
- [ ] **Step 3: root-barrel golden**: copy the mechanism of `cargo-surface-golden.test.ts` (runtime `Object.keys` for values + its source-parse approach for `export type` blocks) targeting `../src/index.js` / `src/index.ts`, baseline `root-barrel-surface.golden.json`. Generate baseline the same way. Expect roughly 430+ values / 380+ types — large is fine; frozen is the point.
- [ ] **Step 4: Full validation + commit** `feat(hub): kernel-API and root-barrel golden manifests`

### Task 9: M2 — enclave barrel + import discipline

**Files:**
- Create: `packages/hub/src/kernel/enclave/index.ts`, `__tests__/enclave-surface-golden.test.ts` + `enclave-surface.golden.json`
- Modify: all ~47 non-test files imported via `grep -rEn "from '[^']*enclave/(crypto|record-keys)" packages/hub/src --include='*.ts'` (and the test files too — same sweep), `scripts/check-architecture.mjs` (+`enclave-barrel-only`)

**Interfaces:**
- Consumes: post-Task-7 tree.
- Produces: `kernel/enclave/index.ts` — THE fork-swap contract. Sister projects replace the enclave folder honoring this barrel.

- [ ] **Step 1: Build the barrel**: enumerate every symbol currently imported from enclave internals by outsiders (`grep -rhoE "import[^;]*from '[^']*enclave/[^']*'" packages/hub/src | sort -u`), re-export exactly that set (named re-exports) from `kernel/enclave/index.ts`, grouped: crypto ops / record codec / sealing / key lifecycle / deterministic / tombstone. Do NOT export symbols nobody imports — the barrel is the observed contract, not the folder's full contents.
- [ ] **Step 2: Migrate all import sites** (src + tests) to `…/enclave/index.js`. Inside `kernel/enclave/**`, internal relative imports stay as they are.
- [ ] **Step 3: `enclave-barrel-only` check** in check-architecture.mjs: fail any import matching `enclave/` deeper than `enclave/index.js` from files outside `src/kernel/enclave/`.
- [ ] **Step 4: Golden** for the barrel (Task 3 Step 4 recipe, import `../src/kernel/enclave/index.js`).
- [ ] **Step 5: Full validation + commit** `feat(hub): enclave barrel — the fork-swap contract, golden-frozen + barrel-only guard`

### Task 10: N3a — subsystem→service terminology

**Files:**
- Rename: `SUBSYSTEMS.md` → `SERVICES.md` (git mv)
- Modify: every file matching `grep -rln "SUBSYSTEMS.md" . --include='*.md' --include='*.ts' --include='*.mjs' --include='*.yaml' --include='*.json' --exclude-dir=node_modules --exclude-dir=dist`, plus every "subsystem" word occurrence in `packages/hub/src/**` comments/strings and repo docs (`grep -rln subsystem packages/hub/src docs *.md scripts --include='*.ts' --include='*.md' --include='*.mjs'`)

- [ ] **Step 1: git mv SUBSYSTEMS.md SERVICES.md**; update every cross-reference found by the grep (including `CLAUDE.md`, `README.md`, `features.yaml` if it appears).
- [ ] **Step 2: Word sweep** in comments/docs: "subsystem(s)" → "service(s)" / "service layer"; "the 24 subsystems" style phrasing → "the service catalog". Do NOT rename runtime identifiers beyond the already-aliased `ServiceBus` (Task 4) — e.g. an option key or error message mentioning "subsystem" in a PUBLISHED string gets updated text only if no test asserts it (check: run the suite; if a test pins the string, update test + string together and note it).
- [ ] **Step 3: Full validation + commit** `docs(hub): subsystem→service terminology; SUBSYSTEMS.md→SERVICES.md`

### Task 11: N3b — comment de-blurping

**Files:**
- Modify: comments only, across `packages/hub/src/**` — worst offenders first: `kernel/collection.ts` (71 matches), `kernel/vault.ts` (55), `kernel/types.ts` (23), `with-lookup/search/collection-facade.ts` (21), `kernel/query/builder.ts` (20), then the remaining files from `grep -rEln '#[0-9]{3}|Phase [0-9]|PR #|formerly|previously|renamed from|moved (from|to)|spec §' packages/hub/src --include='*.ts'`

**Policy (binding):** a comment states the CURRENT contract or constraint, never the journey. Delete issue-number breadcrumbs, phase references, move/rename stories, spec-section pointers. When a historical comment also contains a live constraint ("passed by reference — never copy"), KEEP the constraint sentence and delete only the narration. Zero code changes — comments and blank lines only.

- [ ] **Step 0: Record the base**: `BASE=$(git rev-parse HEAD)` — all batches diff against this.
- [ ] **Step 1: Sweep in 3 batches** (kernel god-objects / rest of kernel / with-* services), running `pnpm --filter @noy-db/hub test` after each batch.
- [ ] **Step 2: Prove it's comment-only**: `git diff "$BASE" --ignore-all-space -U0 -- packages/hub/src | grep -E '^[+-]' | grep -vE "^[+-]{3}|^[+-]\s*(//|/?\*|\*|$)"` → output must be empty (every changed line is a comment or blank).
- [ ] **Step 3: Full validation + commit** `docs(hub): comments state contracts, not history`

### Task 12: docs + registry sync

**Files:**
- Modify: `docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md` (add the door table + layering law as an addendum section, mark `/adapter`,`/describe` deprecated), `features.yaml` (any entry whose `paths` broke — `pnpm validate:features` finds them), `packages/hub/README.md` + root `README.md` (subpath lists), `CLAUDE.md` (the `@noy-db/hub/adapter` seam references → `/to`, note alias)

- [ ] **Step 1: Update each doc**; run `pnpm validate:features` and `pnpm render:storage-matrix -- --check` until green.
- [ ] **Step 2: Full validation + commit** `docs: door model in lexicon, registry + README sync`
