# Multivault Bundle Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the multi-compartment (NDBM) multivault bundle out of `@noy-db/hub` and into `@klum-db/lobby`, leaving noy-db a pure single-vault library.

**Architecture:** Cross-repo change across the published-package seam. The NDBM bundle is pure composition (it frames N single-vault bundles, touches no crypto), so it relocates by consuming the single-vault bundle primitives from the published `@noy-db`. **2-PR no-gap sequence (klum add+publish → noy-db delete)** so the published `@klum-db/lobby` is never broken mid-flight.

> **⚠️ UPDATE 2026-06-20 — PHASE 1 / PR-A ELIMINATED.** Verification during execution showed the published `@noy-db/hub@0.2.0-pre.24` **already exports** `hasNoydbBundleMagic` (`index.ts:365`) + `PublicEnvelope`. So no "expose" PR is needed and **Phase 1 + Gate A are dropped.** Start at **Phase 2 (klum)** — it's unblocked against the current published `@noy-db`. The `bundle-magic-export.test.ts` written for the old Phase 1 is **salvaged**: it moves into the Phase 3 noy-db delete PR as a guard that `hasNoydbBundleMagic` stays public (klum now depends on it). Renumbering after this update: **Phase 2 → the klum PR; Gate B → Gate A; Phase 3 → the noy-db PR; Gate C → Gate B.**

**Tech Stack:** TypeScript (strict, ESM `.js` specifiers), vitest, pnpm. Repos: `vLannaAi/noy-db` (`/Users/vicio/_github/noy-db`) and `vLannaAi/klum-db` (`/Users/vicio/_github/klum-db`).

**Spec:** `docs/superpowers/specs/2026-06-19-multivault-bundle-relocation-design.md`.

> **⚠️ Publish/merge are USER GATES.** Tasks produce code + commits on branches. The three "USER GATE" steps (merge a PR, cut a release) are performed by the user — never run a publish or merge a PR autonomously. Pause at each gate.

---

## File structure

**noy-db (PR-A — expose):**
- Modify: `packages/hub/src/index.ts` — add one export line for `hasNoydbBundleMagic`.
- Test: `packages/hub/__tests__/bundle-magic-export.test.ts` (new) — asserts the public export.

**klum-db (receive):**
- Create: `src/bundle/uint32.ts` — local big-endian uint32 helpers (klum owns the NDBM outer framing).
- Create: `src/bundle/multi-bundle.ts` — the relocated NDBM module (verbatim body, rebound imports).
- Create: `__tests__/uint32.test.ts`, `__tests__/multi-bundle.test.ts` (migrated from hub).
- Modify: `src/interchange/extract-cross-vault.ts` — import NDBM symbols locally.
- Modify: `src/index.ts` — export the NDBM API from the public barrel.

**noy-db (PR-B — delete):**
- Delete: `packages/hub/src/bundle/multi-bundle.ts`, `packages/hub/__tests__/multi-bundle.test.ts`.
- Modify: `packages/hub/src/index.ts`, `packages/hub/src/bundle/index.ts` — remove NDBM re-exports.
- Modify: `features.yaml` — remove the `multi-compartment-bundle` entry.
- Keep: the `bundle-magic-export.test.ts` from PR-A (still valid).

---

## Phase 1 — noy-db PR-A: expose `hasNoydbBundleMagic` (additive)

`cd /Users/vicio/_github/noy-db`. Branch: `git checkout main && git pull && git checkout -b feat/expose-bundle-magic`.

### Task 1: Publicly export `hasNoydbBundleMagic`

**Files:**
- Modify: `packages/hub/src/index.ts` (add near the bundle exports, e.g. after line 536)
- Test: `packages/hub/__tests__/bundle-magic-export.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/hub/__tests__/bundle-magic-export.test.ts
import { describe, it, expect } from 'vitest'
import { hasNoydbBundleMagic } from '../src/index.js'
import { writeNoydbBundle } from '../src/bundle/bundle.js'
import { createNoydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'

function memStore(): NoydbStore {
  const s = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let comp = s.get(c); if (!comp) { comp = new Map(); s.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return s.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env) { gc(c, col).set(id, env) },
    async delete(c, col, id) { s.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const m = s.get(c)?.get(col); return m ? [...m.keys()] : [] },
    async loadAll(c) {
      const comp = s.get(c); const out: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; out[n] = r }
      return out
    },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

describe('hasNoydbBundleMagic public export', () => {
  it('is exported from @noy-db/hub and detects a real single-vault bundle', async () => {
    expect(typeof hasNoydbBundleMagic).toBe('function')
    const db = await createNoydb({ store: memStore(), user: 'a', secret: 'correct-horse-battery-staple' })
    const bundle = await writeNoydbBundle(db.vault(), {})
    expect(hasNoydbBundleMagic(bundle)).toBe(true)
    expect(hasNoydbBundleMagic(new Uint8Array([0, 1, 2, 3]))).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @noy-db/hub test bundle-magic-export`
Expected: FAIL — `hasNoydbBundleMagic` is `undefined` (not exported from `../src/index.js`).

- [ ] **Step 3: Add the export**

In `packages/hub/src/index.ts`, immediately after the line `export { readNoydbBundlePublicEnvelope } from './bundle/bundle.js'` (line 536), add:

```typescript
export { hasNoydbBundleMagic } from './bundle/format.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @noy-db/hub test bundle-magic-export`
Expected: PASS.

- [ ] **Step 5: Gate checks**

Run: `pnpm --filter @noy-db/hub typecheck && pnpm --filter @noy-db/hub lint && node scripts/check-architecture.mjs && node scripts/validate-features.mjs`
Expected: all PASS (additive change; no behavior change).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/index.ts packages/hub/__tests__/bundle-magic-export.test.ts
git commit -m "feat(hub): expose hasNoydbBundleMagic for the kernel/bundle seam"
```

- [ ] **Step 7: Push + open PR-A**

```bash
git push -u origin feat/expose-bundle-magic
gh pr create --base main --title "feat(hub): expose hasNoydbBundleMagic (multivault bundle relocation, PR-A)" --body "Additive: exposes the NDB1-magic predicate so @klum-db/lobby's relocated NDBM bundle can detect single-vault bundles across the published seam. Part 1/3 of the multivault bundle relocation (spec 2026-06-19)."
```

---

## 🚦 USER GATE A

**You (the user):** merge PR-A, then cut a `@noy-db` release (next prerelease, e.g. `pre.25`) so `hasNoydbBundleMagic` is published. Tell me when it's on npm and which version — I'll point klum-db's dep at it in Phase 2. (I will not publish.)

---

## Phase 2 — klum-db PR: receive the multivault bundle

`cd /Users/vicio/_github/klum-db`. **Precondition:** PR-A's `@noy-db` is published. Run `pnpm update @noy-db/hub` (the `^0.2.0-pre.24` range pulls the new prerelease) and confirm `node -e "console.log(require('@noy-db/hub').hasNoydbBundleMagic)"` prints a function. Branch: `git checkout main && git pull && git checkout -b feat/multivault-bundle`.

### Task 2: Local uint32 BE helpers (klum owns the NDBM framing)

**Files:**
- Create: `src/bundle/uint32.ts`
- Test: `__tests__/uint32.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/uint32.test.ts
import { describe, it, expect } from 'vitest'
import { readUint32BE, writeUint32BE } from '../src/bundle/uint32.js'

describe('uint32 BE helpers', () => {
  it('round-trips values including the high bit', () => {
    for (const v of [0, 1, 255, 256, 0x01020304, 0xffffffff]) {
      const buf = new Uint8Array(4)
      writeUint32BE(buf, 0, v)
      expect(readUint32BE(buf, 0)).toBe(v)
    }
  })
  it('writes big-endian byte order at an offset', () => {
    const buf = new Uint8Array(6)
    writeUint32BE(buf, 2, 0x01020304)
    expect([...buf]).toEqual([0, 0, 0x01, 0x02, 0x03, 0x04])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test uint32`
Expected: FAIL — module `../src/bundle/uint32.js` not found.

- [ ] **Step 3: Implement the helpers**

```typescript
// src/bundle/uint32.ts
/**
 * Big-endian uint32 codec for the NDBM outer container's length fields.
 * The multi-bundle framing is klum's own format; these are local so noy-db
 * need not expose low-level byte utilities.
 * @module
 */

/** Read a big-endian uint32 from `bytes` at `offset`. */
export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>> 0
  )
}

/** Write `value` as a big-endian uint32 into `bytes` at `offset`. */
export function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test uint32`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bundle/uint32.ts __tests__/uint32.test.ts
git commit -m "feat(bundle): local uint32 BE helpers for the NDBM container"
```

### Task 3: Relocate `multi-bundle.ts` into klum

**Files:**
- Create: `src/bundle/multi-bundle.ts`
- Create: `__tests__/multi-bundle.test.ts` (migrated)

- [ ] **Step 1: Copy the source verbatim**

Copy the entire body of `/Users/vicio/_github/noy-db/packages/hub/src/bundle/multi-bundle.ts` into `src/bundle/multi-bundle.ts`. **Change only the import block at the top** (lines 13–23 in the original) to this — the rest of the file (constants, `CompartmentManifest`/`MultiBundleManifest`, `encodeMultiBundle`, `decodeMultiBundle`, `validateManifest`, `hasMultiMagic`, `MultiVaultCompartmentInput`, `writeMultiVaultBundle`, `readNoydbBundleManifest`, `readMultiVaultBundleCompartment`) is copied unchanged:

```typescript
import { sha256Hex, generateULID, type Vault } from '@noy-db/hub/kernel'
import {
  writeNoydbBundle,
  readNoydbBundleHeader,
  type WriteNoydbBundleOptions,
} from '@noy-db/hub/bundle'
import {
  readNoydbBundlePublicEnvelope,
  hasNoydbBundleMagic,
  type PublicEnvelope,
} from '@noy-db/hub'
import { readUint32BE, writeUint32BE } from './uint32.js'
```

(Rationale for each source: `sha256Hex`/`generateULID`/`Vault` are on `@noy-db/hub/kernel`; `writeNoydbBundle`/`readNoydbBundleHeader`/`WriteNoydbBundleOptions` on `@noy-db/hub/bundle`; `readNoydbBundlePublicEnvelope`/`hasNoydbBundleMagic`/`PublicEnvelope` on the `@noy-db/hub` root; `readUint32BE`/`writeUint32BE` now local.)

- [ ] **Step 2: Migrate the test**

Copy `/Users/vicio/_github/noy-db/packages/hub/__tests__/multi-bundle.test.ts` into `__tests__/multi-bundle.test.ts` and rewrite its imports:
- `from '../src/bundle/multi-bundle.js'` → `from '../src/bundle/multi-bundle.js'` (same relative path — klum's test dir is `__tests__/` at repo root, source at `src/`; keep the import pointing at the new module).
- `from '../src/bundle/bundle.js'` (e.g. `writeNoydbBundle`, `readNoydbBundle`, `readNoydbBundleHeader`) → `from '@noy-db/hub/bundle'`.
- `from '../src/noydb.js'` (`createNoydb`, type `Noydb`) → `from '@noy-db/hub'`.
- `from '../src/types.js'` → `from '@noy-db/hub'`.
- `from '../src/index.js'` (`ConflictError`) → `from '@noy-db/hub'`.

- [ ] **Step 3: Run the migrated test**

Run: `pnpm test multi-bundle`
Expected: PASS — every NDBM codec/round-trip/guard test green against the published `@noy-db`. If a symbol fails to import, fix the source path per Step 1's rationale and re-run.

- [ ] **Step 4: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bundle/multi-bundle.ts __tests__/multi-bundle.test.ts
git commit -m "feat(bundle): relocate the NDBM multivault bundle into @klum-db/lobby"
```

### Task 4: Rewire `extract-cross-vault.ts` to the local module

**Files:**
- Modify: `src/interchange/extract-cross-vault.ts` (the `from '@noy-db/hub/bundle'` import block)

- [ ] **Step 1: Split the import**

The current block imports both multivault symbols (now local) and single-vault symbols (still from noy-db):
```typescript
import {
  encodeMultiBundle,
  readNoydbBundleHeader,
  NOYDB_MULTI_BUNDLE_VERSION,
  generateULID,
  describeExtraction,
  type MultiBundleManifest,
  type CompartmentManifest,
  type ExtractionPreview,
} from '@noy-db/hub/bundle'
import { sha256Hex } from '@noy-db/hub/kernel'
```
Replace it with — multivault symbols from the local module, the rest unchanged:
```typescript
import {
  readNoydbBundleHeader,
  describeExtraction,
  type ExtractionPreview,
} from '@noy-db/hub/bundle'
import { sha256Hex, generateULID } from '@noy-db/hub/kernel'
import {
  encodeMultiBundle,
  NOYDB_MULTI_BUNDLE_VERSION,
  type MultiBundleManifest,
  type CompartmentManifest,
} from '../bundle/multi-bundle.js'
```
(Note: `generateULID` moves to the kernel import — it was being pulled via `@noy-db/hub/bundle` before; it lives on the kernel. Verify `describeExtraction`/`ExtractionPreview` remain on `@noy-db/hub/bundle`; they are single-vault and stay in hub.)

- [ ] **Step 2: typecheck + run the extraction tests**

Run: `pnpm typecheck && pnpm test extract-cross-vault`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/interchange/extract-cross-vault.ts
git commit -m "refactor(interchange): import NDBM bundle from the local module"
```

### Task 5: Export the NDBM API from the public barrel

**Files:**
- Modify: `src/index.ts` (add a re-export block)

- [ ] **Step 1: Add the re-export**

In `src/index.ts`, add (near the other bundle/interchange exports):

```typescript
// Multi-compartment (NDBM) multivault bundle — relocated from @noy-db/hub.
export {
  encodeMultiBundle,
  decodeMultiBundle,
  writeMultiVaultBundle,
  readNoydbBundleManifest,
  readMultiVaultBundleCompartment,
  NOYDB_MULTI_BUNDLE_MAGIC,
  NOYDB_MULTI_BUNDLE_PREFIX_BYTES,
  NOYDB_MULTI_BUNDLE_VERSION,
} from './bundle/multi-bundle.js'
export type {
  CompartmentManifest,
  MultiBundleManifest,
  MultiVaultCompartmentInput,
} from './bundle/multi-bundle.js'
```

- [ ] **Step 2: Full klum verification**

Run: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
Expected: all PASS — the full klum suite (the migrated NDBM tests + the prior 177) green against the published `@noy-db`.

- [ ] **Step 3: Commit + push + open the klum PR**

```bash
git add src/index.ts
git commit -m "feat(bundle): export the NDBM multivault bundle from the public barrel"
git push -u origin feat/multivault-bundle
gh pr create --base main --title "feat(bundle): own the NDBM multivault bundle (relocation from @noy-db/hub)" --body "Relocates the multi-compartment (NDBM) bundle into @klum-db/lobby (pure composition over the published single-vault bundle). Part 2/3 of the relocation (noy-db spec 2026-06-19). Consumes hasNoydbBundleMagic from the noy-db PR-A release."
```

---

## 🚦 USER GATE B

**You (the user):** merge the klum PR, bump klum to its next prerelease (e.g. `pre.27`), and cut the `@klum-db/lobby` release so the NDBM bundle is published from klum. Tell me when it's on npm. (I will not publish.)

---

## Phase 3 — noy-db PR-B: remove the multivault bundle (breaking)

`cd /Users/vicio/_github/noy-db`. **Precondition:** the klum release from Gate B is published. Branch: `git checkout main && git pull && git checkout -b chore/remove-multivault-bundle`.

### Task 6: Delete `multi-bundle.ts` and its re-exports

**Files:**
- Delete: `packages/hub/src/bundle/multi-bundle.ts`, `packages/hub/__tests__/multi-bundle.test.ts`
- Modify: `packages/hub/src/index.ts`, `packages/hub/src/bundle/index.ts`
- Modify: `features.yaml`

- [ ] **Step 1: Delete the files**

```bash
git rm packages/hub/src/bundle/multi-bundle.ts packages/hub/__tests__/multi-bundle.test.ts
```

- [ ] **Step 2: Remove the re-exports**

In `packages/hub/src/index.ts`, delete the NDBM re-export block (the comment at line 538 `// Multi-compartment bundle (NDBM) — ...` and the `export {...}`/`export type {...}` lines re-exporting `writeMultiVaultBundle`, `readNoydbBundleManifest`, `readMultiVaultBundleCompartment`, `encodeMultiBundle`, `decodeMultiBundle`, `MultiBundleManifest`, `MultiVaultCompartmentInput`, and the NDBM constants from `./bundle/multi-bundle.js`). **Keep** the `hasNoydbBundleMagic` export from PR-A.

In `packages/hub/src/bundle/index.ts`, delete the lines re-exporting from `./multi-bundle.js` (verified present around lines 46–59: `writeMultiVaultBundle`, `readNoydbBundleManifest`, `readMultiVaultBundleCompartment`, `encodeMultiBundle`, `decodeMultiBundle`, and the `MultiBundleManifest`/`MultiVaultCompartmentInput` types).

- [ ] **Step 3: Remove the features.yaml entry**

In `features.yaml`, delete the entire `- id: multi-compartment-bundle` entry (package `@noy-db/hub`, cluster `snapshot-and-portability`) — the `- id:` line through its `related:` line and the trailing blank line.

- [ ] **Step 4: Verify nothing dangles**

Run:
```bash
grep -rn "multi-bundle\|writeMultiVaultBundle\|encodeMultiBundle\|readNoydbBundleManifest\|readMultiVaultBundleCompartment\|MultiBundleManifest\|MultiVaultCompartmentInput\|NOYDB_MULTI_BUNDLE" packages/*/src packages/*/__tests__ showcases/src playground features.yaml | grep -v node_modules
```
Expected: **no matches** (except possibly historical CHANGELOG/spec docs, which are fine).

- [ ] **Step 5: Full gate suite**

Run: `pnpm turbo build && pnpm turbo typecheck && pnpm turbo lint && node scripts/validate-features.mjs && node scripts/check-architecture.mjs && pnpm --filter @noy-db/hub test`
Expected: all PASS. hub test count drops by exactly the migrated `multi-bundle.test.ts` count.

- [ ] **Step 6: Commit + push + open PR-B**

```bash
git add -A
git commit -m "chore(hub): remove the multivault bundle (now owned by @klum-db/lobby)"
git push -u origin chore/remove-multivault-bundle
gh pr create --base main --title "chore(hub): drop the multivault bundle — moved to @klum-db/lobby (PR-B)" --body "Removes the NDBM multi-compartment bundle from @noy-db/hub now that @klum-db/lobby owns and publishes it. Part 3/3 of the relocation (spec 2026-06-19). Breaking (pre-1.0): consumers import the multivault bundle from @klum-db/lobby."
```

---

## 🚦 USER GATE C

**You (the user):** merge PR-B and cut the `@noy-db` release (next prerelease). After this, noy-db's bundle surface is single-vault only and the relocation is complete.

---

## Self-review (run before handing off)

- **Spec coverage:** move/keep split (Tasks 3/6 move; PR-A Task 1 + Task 2 keep noy-db's surface minimal) ✓; expose-only-`hasNoydbBundleMagic` (Task 1) ✓; klum owns uint32 (Task 2) ✓; rewire consumer (Task 4) ✓; public barrel (Task 5) ✓; features.yaml removal (Task 6) ✓; 3-PR no-gap sequence (Gates A/B/C between phases) ✓.
- **Placeholders:** none — every code step has literal code; verification steps have exact commands.
- **Type consistency:** `readUint32BE(bytes, offset)` / `writeUint32BE(bytes, offset, value)` signatures (Task 2) match the call sites in the relocated `multi-bundle.ts` (`writeUint32BE(out, 6, manifestBytes.length)`, `readUint32BE(bytes, 6)`). Exported symbol names in Task 5 match the originals in `multi-bundle.ts`.
- **Seam safety:** the bundle exists in `@noy-db` until Gate B publishes it in `@klum-db/lobby`; only then does PR-B remove it (Phase 3) — no published gap.
