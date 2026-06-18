# FR-9 — Multi-Vault FK-Driven Excel Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export an Excel workbook that spans **multiple vaults** — a primary vault's sheets plus supporting-vault sheets containing **exactly the FK-referenced rows** (no full-table dump), and FK'd fields **denormalized as columns** into the primary sheet. The read-side dual of FR-2's FK closure.

**Architecture (dependency direction is the crux):** `@noy-db/as-xlsx` is an **edge adapter** that may only depend on `@noy-db/hub` — it must NOT import `@klum-db/lobby` (the `no-outbound-klum-import` guard + spec). So FR-9 splits in two:
- **Edge (pure render):** `@noy-db/as-xlsx` gains `toBytesMultiVault(entries, options?)` — takes *pre-opened* vaults + a *pre-computed* per-vault id-closure + a denormalize config, and renders the workbook. It performs the denormalize as an **in-memory join over rows it has already loaded** (no cross-vault walk inside the adapter).
- **Orchestration (the FK walk):** `@klum-db/lobby` gains `Lobby.exportMultiVaultXlsx(...)` — calls FR-2's `walkCrossVaultClosure`, opens the vaults, builds the entries (closure + denorm), and delegates to `toBytesMultiVault`. Lobby gains a **peer-dependency on `@noy-db/as-xlsx`** (the allowed `klum→noy` direction).

**Tech stack:** TypeScript, vitest, pnpm. `@noy-db/as-xlsx` (edge), `@klum-db/lobby` (orchestration).

**Design decisions (resolved at the FR-9 gate):**
- **API home → Lobby orchestrator** over a pure edge function (both built).
- **Output → BOTH** filtered supporting sheets AND denormalized columns in the primary sheet.
- **Smart mode → flat multi-vault now**; cross-vault VLOOKUP (rewriting `sheetNameByCollection` → by-vault-and-collection) is a documented follow-up.
- **Single-vault export is unchanged** (regression-guarded).

---

## Key existing surfaces (from recon)
- `@noy-db/as-xlsx` (`packages/as-xlsx/src/index.ts`): `toBytes(vault, AsXlsxOptions)`, `AsXlsxOptions{sheets, summaries?, dialect?, smart?}`, `AsXlsxSheetOptions{name, collection, columns?, filter?, ...}`. Reads via `vault.collection(c).list()`. Low-level `writeXlsx(sheets: XlsxSheet[], options?)` (`src/xlsx.ts:125`) accepts any sheets; dedups names; `truncateSheetName` 31-char cap (`src/xlsx.ts:398`). Peer-deps: `@noy-db/hub`, `@noy-db/as-zip` only.
- FR-2 (`packages/lobby/src/interchange/extract-cross-vault.ts`): `CrossVaultRef{from:{collection,field}, to:{vault,collection,field?}}`, `CrossVaultSeed{vault, seeds}`, `walkCrossVaultClosure(openVault, {seed, crossVaultRefs?, maxDepth?})` → `CrossVaultClosurePlan{perVaultSeeds, perVaultClosure: Map<vault, Map<collection, Set<id>>>, dangling}`.
- `Noydb.openVault(name)`; vault caches instances. `vault.collection(c).get(id)` / `.list()` (decrypted reads). Per-vault export grant: `assertCanExport('plaintext','xlsx')` (each vault must hold it).
- Test harness: `packages/as-xlsx/__tests__/as-xlsx.test.ts` (`memory()` + `createNoydb` + `grant({exportCapability:{plaintext:['xlsx']}})` + `toBytes`).

---

## File structure

- **Modify** `packages/as-xlsx/src/index.ts` — `toBytesMultiVault` + `MultiVaultXlsxEntry`/`MultiVaultDenormColumn` types (edge-pure). (Tasks 1-2)
- **Modify** `packages/lobby/src/index.ts` + **`packages/lobby/package.json`** — `Lobby.exportMultiVaultXlsx` + as-xlsx peer-dep. (Task 3)
- **Modify** `features.yaml`. (Task 4)
- **Tests:** `packages/as-xlsx/__tests__/multivault-xlsx.test.ts` (Tasks 1-2), `packages/lobby/__tests__/export-multivault-xlsx.test.ts` (Task 3).

---

## Task 1 — as-xlsx: `toBytesMultiVault` flat multi-vault render + closure filter (TDD)

**Files:** `packages/as-xlsx/src/index.ts`. Test `packages/as-xlsx/__tests__/multivault-xlsx.test.ts`.

**Context:** Pure edge function: given pre-opened vaults (each with sheet specs + an optional id-closure), render one workbook. Vault-prefixed sheet names; per-vault export grant check; supporting sheets filtered to the closure ids. Reuses `writeXlsx`.

- [ ] **Step 1: Failing test** — create `multivault-xlsx.test.ts`. Mirror `as-xlsx.test.ts` harness; seed TWO vaults (`primary` with `bills` referencing `entityId`, `directory` with `entities`), grant xlsx on both. Call:
```ts
const bytes = await toBytesMultiVault([
  { vault: primaryVault, sheets: [{ name: 'bills', collection: 'bills', columns: ['id','entityId','amount'] }] },
  { vault: dirVault, sheets: [{ name: 'entities', collection: 'entities', columns: ['id','name'] }],
    closure: new Map([['entities', new Set(['e1'])]]) },   // only e1 referenced
])
```
   Assert (parse the xlsx via the package's own reader or `fromBytes`/zip inspection used in existing tests): two data sheets exist with vault-prefixed names (e.g. `primary_bills`, `directory_entities`); the `directory_entities` sheet has ONLY row `e1` (closure filter), not the full entities table; a `_manifest` lists both vaults.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** in `index.ts`:
```ts
export interface MultiVaultXlsxEntry {
  readonly vault: Vault
  readonly sheets: readonly AsXlsxSheetOptions[]
  /** Optional per-collection id-allowlist (from walkCrossVaultClosure). When set, only these ids are exported. */
  readonly closure?: ReadonlyMap<string, ReadonlySet<string>>
  /** Optional display label for sheet-name prefixing; defaults to vault.name. */
  readonly label?: string
}

export interface MultiVaultXlsxOptions {
  readonly dialect?: 'excel' | 'sheets'
  /** Sheet-name prefix separator. Default '_'. Names are truncated to 31 chars. */
  readonly sheetSeparator?: string
}

export async function toBytesMultiVault(
  entries: readonly MultiVaultXlsxEntry[],
  options: MultiVaultXlsxOptions = {},
): Promise<Uint8Array> {
  const sep = options.sheetSeparator ?? '_'
  const allSheets: XlsxSheet[] = []
  const manifestRows: (string | number)[][] = []
  for (const entry of entries) {
    // each vault must independently hold the xlsx export grant (fail-fast, before any rows materialise)
    entry.vault.assertCanExport?.('plaintext', 'xlsx')   // confirm the real accessor name/signature
    const prefix = entry.label ?? entry.vault.name
    for (const s of entry.sheets) {
      const rows = await entry.vault.collection<Record<string, unknown>>(s.collection).list()
      const allow = entry.closure?.get(s.collection)
      const filtered = allow ? rows.filter(r => allow.has(String((r as { id?: unknown }).id))) : rows
      const withUserFilter = s.filter ? filtered.filter(s.filter) : filtered
      const cols = s.columns ?? inferColumns(withUserFilter)
      const sheetName = prefixSheetName(prefix, s.name, sep)   // `${prefix}${sep}${s.name}`, truncated ≤31
      allSheets.push(buildFlatSheet(sheetName, cols, withUserFilter))   // reuse the existing flat-sheet builder
      manifestRows.push([prefix, s.collection, withUserFilter.length])
    }
  }
  allSheets.unshift({ name: '_manifest', header: ['Vault', 'Collection', 'Records'], rows: manifestRows })
  return writeXlsx(allSheets, { dialect: options.dialect })
}
```
   - Read `index.ts` to reuse the EXACT flat-sheet construction `toBytes` uses (column inference, row→cells, number formats) — factor a `buildFlatSheet(name, columns, records)` helper out of the existing flat path if one isn't already isolated, WITHOUT changing single-vault `toBytes` behavior. Confirm `assertCanExport`'s real name/signature (grep how `toBytes` enforces the grant) + `writeXlsx`/`XlsxSheet`/`inferColumns` imports.
   - `prefixSheetName`: `truncateSheetName(`${prefix}${sep}${name}`)`; rely on `writeXlsx`'s dedup for residual collisions.

- [ ] **Step 4: Run → pass.** `pnpm --filter @noy-db/as-xlsx test` (incl. the EXISTING single-vault tests — UNCHANGED), typecheck, lint, `pnpm check:architecture` (as-xlsx must still NOT import @klum-db — verify no new outbound import).

- [ ] **Step 5: Commit** (new test → `git add`): `git add packages/as-xlsx/__tests__/multivault-xlsx.test.ts && git commit -am "feat(as-xlsx): toBytesMultiVault — multi-vault render + closure filter (FR-9 Task 1)"`

---

## Task 2 — as-xlsx: denormalized columns (in-memory FK join) (TDD)

**Files:** `packages/as-xlsx/src/index.ts`. Test: extend `multivault-xlsx.test.ts`.

**Context:** Pull FK'd fields from a supporting vault INTO the primary sheet as columns (`bills.entityId → directory.entities.id → entities.name` puts `entities.name` as a `bills` column). Pure in-memory join over rows already loaded (the supporting closure rows ARE the referenced ones). No lobby/cross-vault walk in the adapter.

- [ ] **Step 1: Failing test** — extend the test: the primary `bills` sheet declares a denormalize column:
```ts
const bytes = await toBytesMultiVault([
  { vault: primaryVault, sheets: [{
      name: 'bills', collection: 'bills', columns: ['id','entityId','amount'],
      denormalize: [{ column: 'entityName', localField: 'entityId',
        from: { label: 'directory', collection: 'entities', keyField: 'id', pick: 'name' } }],
    }] },
  { vault: dirVault, sheets: [{ name: 'entities', collection: 'entities', columns: ['id','name'] }],
    closure: new Map([['entities', new Set(['e1'])]]) },
])
// assert the bills sheet now has an `entityName` column whose value for the bill referencing e1 == the e1 entity's name.
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement.** Add `denormalize?: readonly MultiVaultDenormColumn[]` to `AsXlsxSheetOptions` (additive/optional — single-vault `toBytes` ignores it):
```ts
export interface MultiVaultDenormColumn {
  readonly column: string            // new column name in the primary sheet
  readonly localField: string        // FK field on the primary record
  readonly from: { readonly label: string; readonly collection: string; readonly keyField: string; readonly pick: string }
}
```
   In `toBytesMultiVault`: build a lookup index `Map<`${label}/${collection}`, Map<keyValue, row>>` from ALL loaded entries' rows (first pass), then when emitting a sheet with `denormalize`, for each row resolve `index.get(`${from.label}/${from.collection}`)?.get(row[localField])?.[from.pick]` and append it as the `column`. Append denorm columns AFTER the declared columns. Unresolved FK → empty cell (document).
   - Two-pass: pass 1 loads + indexes all entries' rows (apply closure filter to what's indexed AND exported — the denorm can only resolve referenced rows, which is correct: only FK-referenced supporting rows exist); pass 2 emits sheets with denorm columns. Refactor Task 1's single loop into load-then-emit.

- [ ] **Step 4: Run → pass.** Full as-xlsx test (single-vault unchanged), typecheck, lint, architecture.

- [ ] **Step 5: Commit** — `git commit -am "feat(as-xlsx): denormalized FK columns in multi-vault export (FR-9 Task 2)"`

---

## Task 3 — lobby: `Lobby.exportMultiVaultXlsx` orchestrator (TDD)

**Files:** `packages/lobby/src/index.ts`, `packages/lobby/package.json` (add `@noy-db/as-xlsx` peer-dep). Test `packages/lobby/__tests__/export-multivault-xlsx.test.ts`.

**Context:** The one-call wrapper: walk the FK closure (FR-2) → open vaults → build entries (closure + denorm) → `toBytesMultiVault`. Lobby→as-xlsx is the allowed `klum→noy` direction.

- [ ] **Step 1: package.json** — add `"@noy-db/as-xlsx": "workspace:*"` to `@klum-db/lobby` `peerDependencies` (mirror how `@noy-db/hub` is declared). `pnpm install` so the workspace link resolves.

- [ ] **Step 2: Failing test** — `export-multivault-xlsx.test.ts`: a `Noydb` with two vaults + an FK (`bills.entityId → directory.entities.id`); some bills reference only a SUBSET of entities. Call:
```ts
const bytes = await lobby.exportMultiVaultXlsx({
  primary: { vault: 'primary', seeds: { bills: () => true } },
  crossVaultRefs: [{ from: { collection: 'bills', field: 'entityId' }, to: { vault: 'directory', collection: 'entities' } }],
  sheets: { primary: [{ name: 'bills', collection: 'bills', denormalize: [{ column:'entityName', localField:'entityId', from:{ label:'directory', collection:'entities', keyField:'id', pick:'name' } }] }],
            directory: [{ name: 'entities', collection: 'entities' }] },
})
```
   Assert: workbook spans both vaults; the `directory_entities` sheet contains EXACTLY the FK-referenced entity ids (not the full table); the bills sheet has the denormalized `entityName`; single bill→entity mapping correct.

- [ ] **Step 3: Implement** `Lobby.exportMultiVaultXlsx(opts)`:
```ts
import { toBytesMultiVault, type MultiVaultXlsxEntry } from '@noy-db/as-xlsx'
import { walkCrossVaultClosure } from './interchange/extract-cross-vault.js'
// opts: { primary: { vault: string; seeds: Record<string,(r)=>boolean> }, crossVaultRefs: CrossVaultRef[],
//         sheets: Record<vaultName, AsXlsxSheetOptions[]>, dialect? }
async exportMultiVaultXlsx(opts): Promise<Uint8Array> {
  const openVault = (name: string) => this.noydb.openVault(name)
  const plan = await walkCrossVaultClosure(openVault, {
    seed: { vault: opts.primary.vault, seeds: opts.primary.seeds },
    crossVaultRefs: opts.crossVaultRefs,
  })
  const entries: MultiVaultXlsxEntry[] = []
  for (const [vaultName, sheets] of Object.entries(opts.sheets)) {
    const vault = await openVault(vaultName)
    const closure = plan.perVaultClosure.get(vaultName)   // Map<collection, Set<id>> | undefined
    // primary vault: no closure filter (it's seeded by the predicate, exported whole-by-seed);
    // supporting vaults: filter to the FK closure.
    entries.push({ vault, sheets, label: vaultName,
      ...(vaultName !== opts.primary.vault && closure ? { closure } : {}) })
  }
  return toBytesMultiVault(entries, opts.dialect ? { dialect: opts.dialect } : {})
}
```
   - Decide the primary-vault row scope: the primary is seeded by `opts.primary.seeds` predicates; export the primary rows matching the seed (either pass the seed as a `filter` on the primary sheet, or use the plan's `perVaultClosure` for the primary too). Simplest + matches FR-2 semantics: use `plan.perVaultClosure.get(primary)` for the primary as well (the seed predicate populates it). Verify against walkCrossVaultClosure's output (does it include the seed vault in perVaultClosure? confirm in the FR-2 code) and choose accordingly; document.

- [ ] **Step 4: Run → pass.** `pnpm --filter @noy-db/as-xlsx build` (lobby consumes dist) then `pnpm --filter @klum-db/lobby test` + `pnpm --filter @noy-db/as-xlsx test`, typecheck, lint, `pnpm check:architecture` (lobby→as-xlsx OK; as-xlsx still no klum import; the `no-outbound-klum-import` guard still green).

- [ ] **Step 5: Commit** (new test + package.json → `git add`): `git add packages/lobby/__tests__/export-multivault-xlsx.test.ts packages/lobby/package.json && git commit -am "feat(lobby): exportMultiVaultXlsx orchestrator over as-xlsx (FR-9 Task 3)"`

---

## Task 4 — exports + features.yaml + full verification

**Files:** `packages/as-xlsx/src/index.ts` (confirm exports), `features.yaml`.

- [ ] **Step 1: Exports** — confirm `toBytesMultiVault`, `MultiVaultXlsxEntry`, `MultiVaultXlsxOptions`, `MultiVaultDenormColumn` are exported from `@noy-db/as-xlsx`; `exportMultiVaultXlsx` is a `Lobby` method (auto-available); re-export the as-xlsx multi-vault types from `@klum-db/lobby` if helpful. `pnpm --filter @klum-db/lobby typecheck`.
- [ ] **Step 2: features.yaml** — add a `multivault-xlsx-export` entry mirroring a sibling as-xlsx / lobby feature (study `as-xls`/`as-xlsx` entries + the FR-2 `cross-vault-extraction` entry for shape): artefacts `packages/as-xlsx/src/index.ts` + the lobby orchestrator; spec `docs/superpowers/specs/2026-06-16-lobby-framework-design.md` (FR-9); package `@noy-db/as-xlsx` (+ note the `@klum-db/lobby` orchestrator); status `preview`. `node scripts/validate-features.mjs` passes.
- [ ] **Step 3: Full verification:**
```bash
pnpm --filter @noy-db/as-xlsx build && pnpm --filter @noy-db/hub build && pnpm --filter @klum-db/lobby build
pnpm --filter @noy-db/as-xlsx test && pnpm --filter @klum-db/lobby test
pnpm lint && pnpm typecheck
node scripts/validate-features.mjs
pnpm check:architecture
```
All green.
- [ ] **Step 4: Commit** — `git commit -am "feat: register multivault-xlsx-export feature + verify (FR-9)"`

---

## Self-Review

**Spec coverage (issue #449):**
- "a workbook spans ≥2 compartments" → Task 1 (multi-vault sheets) + Task 3 (orchestrator).
- "supporting-vault rows are exactly those FK-referenced (no full-table dump)" → Task 1 closure filter + Task 3 walkCrossVaultClosure feeding the closure.
- "single-vault export is unchanged" → Tasks 1-2 keep `toBytes` untouched (denormalize is opt-in, ignored by single-vault); regression-guarded by the existing as-xlsx suite.
- "joins/denormalizes ... entities.name" → Task 2 (denormalized columns).
- Builds on `@noy-db/as-xlsx`, FR-2's `CrossVaultRef`/`walkCrossVaultClosure`, broadcastJoin-style enrich (implemented as an in-memory join in the edge adapter).

**Dependency-direction invariant (the critical one):** `@noy-db/as-xlsx` gains NO `@klum-db/lobby` import (the walk is caller-supplied); `@klum-db/lobby` gains a peer-dep on `@noy-db/as-xlsx` (allowed `klum→noy`). The `no-outbound-klum-import` arch guard must stay green — verified in Tasks 1 & 3.

**Placeholder scan:** signatures concrete; the two implementer decisions are flagged (Task 1's `assertCanExport` accessor + the flat-sheet-builder factoring; Task 3's primary-vault scope = perVaultClosure-of-seed-vault — confirm in FR-2 code). 31-char sheet-name truncation + dedup reused from `writeXlsx`.

**Risk notes:** smart-mode cross-vault VLOOKUP is DEFERRED (flat multi-vault only) — documented. The lobby→as-xlsx peer-dep adds xlsx to lobby's peer set (acceptable per the chosen orchestrator option; peer not hard dep, so consumers opt in). Denormalize resolves only FK-referenced (closure) rows — an FK pointing outside the closure yields an empty cell (correct: that row wasn't referenced/exported).
