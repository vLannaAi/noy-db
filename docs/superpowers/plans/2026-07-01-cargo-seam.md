# Cargo Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@noy-db/hub/cargo` — the correctly-named orchestration seam klum binds — consolidating every symbol klum legitimately needs into one subpath, frozen by a golden surface test, with `/kernel` kept as a deprecated alias.

**Architecture:** `/cargo` is a new barrel (`src/cargo/index.ts`) that re-exports the entire existing `/kernel` surface plus the orchestration delta (custody/deed, `diffVault`, `STATE_VAULT_NAME`, write-hook types, `SealingKeyProvider`, `AccessibleVault`) that klum currently pulls from the **bare `@noy-db/hub` root barrel**. This is purely **additive** to noy-db — `/kernel` and the root barrel are untouched, so nothing existing breaks. The klum-side migration (moving klum's imports onto `/cargo` + adding a klum-side import guard) is **publish-gated** and lives in Phase B, not executed here.

**Tech Stack:** TypeScript, tsup (subpath entries), vitest, pnpm. Reference: `docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md` (the canonical lexicon this implements).

## Global Constraints

- **Additive only.** `/kernel` (`src/kernel/index.ts`) and the root barrel (`src/index.ts`) stay byte-identical in surface. `/cargo` is new; it does not remove or re-type anything.
- **`/cargo` is canonical; `/kernel` is a deprecated alias** — do NOT delete `/kernel` (klum pins it today; klum tests against the *published* package).
- **Golden surface test** freezes `/cargo`'s export list (mirror the existing `kernel-surface.golden.json` pattern) so future changes to the seam are deliberate.
- **No Claude attribution** in commits/PRs.
- **Grep the diff for the pilot-client names before committing** — none may appear.
- **Phase B is publish-gated:** klum cannot migrate until a noy-db version carrying `/cargo` is published, which requires **explicit user confirmation**. Do not migrate klum or trigger a publish in this plan.

---

## File Structure

- `packages/hub/src/cargo/index.ts` — NEW. The cargo barrel: `export * from '../kernel/index.js'` + the orchestration delta re-exports.
- `packages/hub/package.json` — MODIFY. Add the `./cargo` export condition.
- `packages/hub/tsup.config.ts` (or wherever entries are declared) — MODIFY. Add `src/cargo/index.ts` as a build entry.
- `packages/hub/__tests__/cargo-surface.golden.json` — NEW. Frozen export list.
- `packages/hub/__tests__/cargo-surface-golden.test.ts` — NEW. Asserts the live `/cargo` surface equals the golden.
- `packages/hub/src/cargo/README.md` (or the docs subsystem page) — NEW/short. One-paragraph doc: "the klum orchestration seam; supersedes `/kernel`."

---

### Task 1: The `/cargo` barrel + subpath wiring

**Files:**
- Create: `packages/hub/src/cargo/index.ts`
- Modify: `packages/hub/package.json` (exports map), the tsup entry list
- Test: `packages/hub/__tests__/cargo-surface.test.ts`

**Interfaces:**
- Produces: the subpath `@noy-db/hub/cargo` exporting the full `/kernel` surface plus the delta below.

- [ ] **Step 1: Write the failing test** — `packages/hub/__tests__/cargo-surface.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import * as cargo from '../src/cargo/index.js'

describe('@noy-db/hub/cargo surface', () => {
  it('re-exports the /kernel runtime floor', () => {
    for (const s of ['generateULID', 'sha256Hex', 'isQuorum', 'runDrainBarrier',
                     'fuseRetrieval', 'readPath', 'reduceRecords', 'groupAndReduce']) {
      expect(cargo[s as keyof typeof cargo], s).toBeTypeOf('function')
    }
  })
  it('adds the orchestration delta (custody/deed/diff/addressing)', () => {
    for (const s of ['CustodyApi', 'liberateVault', 'createDeedOwner',
                     'loadDeedMarker', 'isDeedVault', 'diffVault', 'STATE_VAULT_NAME']) {
      expect(cargo[s as keyof typeof cargo], s).toBeDefined()
    }
  })
})
```

- [ ] **Step 2: Run it, verify it fails** — `pnpm vitest run packages/hub/__tests__/cargo-surface.test.ts` → FAIL (module `../src/cargo/index.js` not found).

- [ ] **Step 3: Create the barrel** — `packages/hub/src/cargo/index.ts`:

```ts
// @noy-db/hub/cargo — the orchestration seam klum binds. Canonical successor
// to /kernel (which remains as a deprecated alias). See
// docs/superpowers/specs/2026-07-01-noydb-architecture-lexicon.md.

// The runtime floor — the whole current /kernel surface.
export * from '../kernel/index.js'

// Custody & ownership.
export { CustodyApi } from '../with-party/custody/index.js'
export type { GrantCustodianOptions } from '../with-party/custody/index.js'
export { liberateVault } from '../with-party/custody/liberate.js'
export type { LiberateOptions, LiberateResult } from '../with-party/custody/liberate.js'
export { createDeedOwner, loadDeedMarker, isDeedVault } from '../with-party/team/deed.js'
export type { DeedMarker } from '../with-party/team/deed.js'
export type { SealingKeyProvider } from '../with-party/team/managed-passphrase.js'

// Interchange & addressing.
export { diffVault } from '../vault-diff.js'
export { STATE_VAULT_NAME } from '../constants.js'

// Change observation.
export type { WriteHook } from '../write-hooks.js'
export type { WriteQueue } from '../write-queue.js'
export type { WriteConflict } from '../types.js'
// AccessibleVault + Unsubscribe: re-export from their source module. Grep
// `grep -n "AccessibleVault\|export type { Unsubscribe" packages/hub/src/index.ts`
// to get the exact module (both are type-only) and mirror the export line here.
```

Resolve the final two type re-exports (AccessibleVault, Unsubscribe) from the grep, add them, and confirm no duplicate-export TS error against `export *` from `/kernel`.

- [ ] **Step 4: Wire the subpath** — in `packages/hub/package.json` `exports`, add (mirroring the existing `./kernel` block):

```json
"./cargo": { "types": "./dist/cargo/index.d.ts", "default": "./dist/cargo/index.js" }
```

Add `src/cargo/index.ts` to the tsup entry array (mirror the `src/kernel/index.ts` entry).

- [ ] **Step 5: Run tests + typecheck + build**

```
pnpm --filter @noy-db/hub typecheck
pnpm vitest run packages/hub/__tests__/cargo-surface.test.ts   # PASS
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @noy-db/hub build
```
Expected: typecheck clean, test PASS, `dist/cargo/index.{js,d.ts}` emitted.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(hub): add /cargo orchestration seam (supersedes /kernel) (lexicon)"`

---

### Task 2: Golden surface test freezing `/cargo`

**Files:**
- Create: `packages/hub/__tests__/cargo-surface.golden.json`, `packages/hub/__tests__/cargo-surface-golden.test.ts`
- Reference: `packages/hub/__tests__/kernel-surface.golden.json`, `packages/hub/__tests__/kernel-surface-golden.test.ts` (mirror them exactly)

**Interfaces:**
- Consumes: `@noy-db/hub/cargo` from Task 1.

- [ ] **Step 1: Read the kernel-surface golden test** to copy its mechanism: `packages/hub/__tests__/kernel-surface-golden.test.ts`.

- [ ] **Step 2: Write `cargo-surface-golden.test.ts`** — same shape as the kernel one, importing `* as cargo` and asserting `Object.keys(cargo).sort()` equals the golden JSON (value exports) plus a type-export list if the kernel golden tracks types via a `.d.ts` parse. Copy whichever method the kernel golden uses.

- [ ] **Step 3: Generate the golden** — run the test once to capture the actual surface, write it to `cargo-surface.golden.json` (mirror how the kernel golden was seeded — likely an `UPDATE_GOLDEN=1` env or a first-run write; check the kernel test).

- [ ] **Step 4: Run it** — `pnpm vitest run packages/hub/__tests__/cargo-surface-golden.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "test(hub): golden surface freeze for /cargo (additive-only)"`

---

### Task 3: Document `/cargo` canonical, `/kernel` deprecated

**Files:**
- Create: `packages/hub/src/cargo/README.md` (short), OR a `docs/` note
- Modify: the subpath list in `README.md` / `CONTRIBUTING.md` where `/kernel` is described (grep `hub/kernel` to find it)

- [ ] **Step 1:** Add a one-paragraph doc stating: `/cargo` is the orchestration seam (custody, deed, diff, distributed query, addressing, change-observation) that klum binds; `/kernel` remains as a deprecated alias for existing pins and will not be removed without a coordinated version bump; new orchestration consumers bind `/cargo`.
- [ ] **Step 2:** Update any doc that says "klum binds `/kernel`" to "klum binds `/cargo` (was `/kernel`)".
- [ ] **Step 3: Commit** — `git commit -am "docs(hub): /cargo is the klum orchestration seam; /kernel deprecated-alias"`

---

## Phase B — klum migration (PUBLISH-GATED — do NOT execute in this plan)

Documented for sequencing; each becomes its own task once a noy-db version carrying `/cargo` is **published (explicit user confirmation required)**:

1. **Prereq:** land the `pod` rename (`bundle → pod`, item #2 of the lexicon) on noy-db *before* touching klum, so klum migrates its imports once (to `/cargo` **and** `/pod`) rather than twice.
2. Publish noy-db `pre.N` with `/cargo` (+ `/pod`).
3. klum: bump the `@noy-db/hub` peer floor to that version; migrate the 15 bare-barrel imports (and the `/kernel` imports) onto `/cargo`; migrate `/bundle` → `/pod`.
4. klum: add a `check-architecture` guard mirroring noy-db-to's `adapter-only` — scan klum `src/`, allow `@noy-db/hub` imports **only** from `/cargo`, `/pod`, and the product API; fail on the bare barrel.
5. klum: fix the stale peer-floor citations in `klum-db/CLAUDE.md` (`pre.24`/`pre.26` → the published floor).

---

## Self-Review

- **Spec coverage:** Implements lexicon item #1 (the cargo seam). Items #2 (pod), #3 (enclave/Phase 4), #4 (retire fleet) are explicitly out of scope / sequenced in Phase B. ✓
- **Placeholders:** One deliberate grep-to-resolve (AccessibleVault/Unsubscribe module) inside a mechanical re-export barrel, verified by the golden test — not a logic gap. ✓
- **Type consistency:** `/cargo` re-exports existing symbols from their real modules (resolved: custody `with-party/custody`, deed `with-party/team/deed`, `vault-diff.js`, `constants.js`, `write-hooks.js`, `write-queue.js`, `types.js`, `managed-passphrase.js`); `export *` from `/kernel` supplies the floor. No new types are invented. ✓
