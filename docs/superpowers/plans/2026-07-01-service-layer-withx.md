# Service-layer withX() Implementation Plan (S4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every archetype-② on-demand service a tree-shakeable `withX()` capability gate, and make "every service is opt-in" a mechanically-enforced invariant.

**Architecture:** Each ② service is gated exactly like the existing `with-fork/snapshots` ① strategy — a `NO_X` no-op stub that throws when its methods are called without opting in, a `withX()` active factory whose engine is dynamically imported, a `xStrategy` field on `createNoydb` options, and the service's public methods routed through the strategy. Archetype ③ (schema features) stays schema-declared and is exempted from the check. Spec: `docs/superpowers/specs/2026-07-01-service-layer-withx-design.md`.

**Tech Stack:** TypeScript, tsup (subpath entries), vitest, pnpm/turbo. Live reference exemplar: `packages/hub/src/with-fork/snapshots/{strategy.ts,active.ts,noydb-facade.ts,index.ts}`.

## Global Constraints

- **Behavior for ① and ③ services is unchanged.** Only ② services change (become opt-in).
- **② hard opt-in (pre-1.0 breaking):** calling a ② method without its `withX()` throws a per-service `…NotEnabledError extends NoydbError` whose message names the exact factory to add (mirror `ForgetStrategyNotConfiguredError`, `DirectoryDisabledError`, and the `NO_SNAPSHOTS` message at `with-fork/snapshots/strategy.ts:49`).
- **Tree-shaking:** the `NO_X` stub is tiny and stays in the floor bundle; the real engine lives in `active.ts` and is reached only via `withX()` (dynamic import), so it's tree-shaken when not opted in.
- **Public surface:** each service keeps its `@noy-db/hub/<x>` subpath; `withX()` is exported from it. No symbol removed from the root barrel without a deprecation.
- **Suite stays green** (current baseline — run `pnpm --filter @noy-db/hub test` to confirm the number before starting); each ② task adds a gate test.
- **check-architecture** `strategy-opt-in` must pass and, by the end, require a `withX()` for every ①/② service and exempt the ③ list.
- No Claude attribution in commits; grep each diff for pilot-client names (none).

---

## The gate recipe (every ② task follows this — the `snapshots` exemplar in code)

READ `with-fork/snapshots/strategy.ts` + `noydb-facade.ts` first; each ② service reproduces this five-part shape:

1. **`with-<dim>/<svc>/strategy.ts`** — export the `XStrategy` interface (the methods the engine implements) and a `NO_X: XStrategy` stub whose every method throws `new XNotEnabledError()`:
   ```ts
   export const NO_X: XStrategy = {
     someMethod() { throw new XNotEnabledError() },   // one per gated method
   }
   ```
2. **`with-<dim>/<svc>/active.ts`** — `export function withX(opts: WithXOptions): XStrategy { … }` returning the real engine (the existing impl, wrapped). Heavy deps imported here (so `withX()` is the only path that pulls them).
3. **`kernel/errors.ts`** — `export class XNotEnabledError extends NoydbError` (`code: 'X_NOT_ENABLED'`), message: `` `<methods> require `xStrategy: withX()` in createNoydb.` `` (copy the `NO_SNAPSHOTS` wording).
4. **`kernel/types.ts`** — add `readonly xStrategy?: XStrategy` to the `createNoydb` options type (next to `snapshotStrategy`).
5. **`kernel/noydb.ts`** (or `kernel/vault.ts` for vault-level services) — wire `strategy: options.xStrategy ?? NO_X` into the facade, and route the service's public delegator methods through `this.<strategy>` so they hit `NO_X`'s throw when not opted in.

Each `withX()` is exported from the service's `index.ts` and the `@noy-db/hub/<x>` subpath.

**VALIDATED by the Task-1 exemplar — apply to every ② service:**
- **Facade is ALWAYS built; the STRATEGY is swapped** (`NO_X` ↔ `withX()`) — do NOT gate by "construct the facade only when opted in." Per-vault facades hold state (e.g. attestation's field-schema registry) that must survive even when the capability isn't opted in.
- **Schema/registration methods stay UNGATED** (e.g. attestation's `register()` from `collection({attestation})`); only the **capability methods** (the ones you invoke) delegate through the strategy and hit `NO_X`'s throw.
- **Strategy methods are stateless and take the per-call context** the facade assembles (mirrors `SnapshotStrategy` taking `vault` per call); `withX()` itself takes only real opts (often none).
- Expect a **+1 kernel-surface ratchet bump** on `vault.ts` and/or `noydb.ts` per service (the one irreducible wiring line); bump with justification, keep it to one line.

---

### Task 1: Gate exemplar — `withAttestation` (establishes the pattern)

**Files:**
- Modify: `packages/hub/src/with-audit/attestation/{strategy.ts (create),active.ts (create),index.ts}`, `kernel/errors.ts`, `kernel/types.ts`, `kernel/vault.ts` (the `VaultAttestation` facade built at `vault.ts` ~610 is only constructed when opted in; else `NO_ATTESTATION`)
- Test: `packages/hub/__tests__/attestation-optin.test.ts`

**Interfaces:**
- Produces: `withAttestation()`, `AttestationStrategy`, `NO_ATTESTATION`, `AttestationNotEnabledError`, options field `attestationStrategy`.

**Methods to gate:** `issueAttestation`, `getDocumentSigningPublicKey`, `revokeAttestation`, `unrevokeAttestation`, `getRevokedDocIds`, `publishRevocationList`.

- [ ] **Step 1: Failing test** — `attestation-optin.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withAttestation } from '../src/with-audit/attestation/index.js'
import { AttestationNotEnabledError } from '../src/errors.js'
// helper: reuse the memory() store + Invoice setup from attestation-vault.test.ts
it('throws AttestationNotEnabledError when not opted in', async () => {
  const db = await createNoydb({ store: memory(), user: 'firm', secret: 'pw-123456' })
  const v = await db.openVault('books')
  await v.collection('invoices', { attestation }).put('x', { id:'x', invoiceNo:'A', total:1, issueDate:'2026-05-29' })
  await expect(v.issueAttestation('invoices','x')).rejects.toThrow(AttestationNotEnabledError)
})
it('works when opted in via withAttestation()', async () => {
  const db = await createNoydb({ store: memory(), user: 'firm', secret: 'pw-123456', attestationStrategy: withAttestation() })
  const v = await db.openVault('books')
  await v.collection('invoices', { attestation }).put('x', { id:'x', invoiceNo:'A', total:1, issueDate:'2026-05-29' })
  const r = await v.issueAttestation('invoices','x')
  expect(r.docId).toHaveLength(26)
})
```
- [ ] **Step 2: Run → FAIL** (`withAttestation`/`AttestationNotEnabledError` undefined). `pnpm vitest run packages/hub/__tests__/attestation-optin.test.ts`
- [ ] **Step 3: Implement the 5-part gate** per the recipe (create `strategy.ts` with `NO_ATTESTATION` throwing `AttestationNotEnabledError` for each of the 6 methods; `active.ts` `withAttestation()` returning the real `VaultAttestation` engine; error class; `attestationStrategy` option; wire `vault.ts` to build `VaultAttestation` only when `attestationStrategy` is present, else `NO_ATTESTATION`).
- [ ] **Step 4: Run → PASS** (both tests). Then `pnpm --filter @noy-db/hub test` — the existing `attestation-*.test.ts` suites now must pass `attestationStrategy: withAttestation()` in their `createNoydb`; **update those setups** (they're the canonical consumers). Confirm green.
- [ ] **Step 5: Commit** — `feat(hub): gate attestation behind withAttestation() (S4)`

---

### Tasks 2–10: Roll the gate out to each remaining ② service

Each task = one service, following the Task-1 recipe exactly (5-part gate + an `…-optin.test.ts` asserting the `…NotEnabledError` without opt-in and success with it, + updating that service's existing test setups to pass the new strategy). Per-service specifics:

| # | Service | dir | field / factory / error | methods to gate | wiring level |
|---|---|---|---|---|---|
| 2 | tiers | `with-audit/tiers` | `tiersStrategy` / `withTiers` / `TiersNotEnabledError` | `putAtTier` `getAtTier` `listAtTier` `elevate` `demote` | collection (`with-audit/tiers` facade) |
| 3 | sealed-record | `with-audit/sealed-record` | `sealedRecordStrategy` / `withSealedRecord` / `SealedRecordNotEnabledError` | `sealRecordToHost` `openSealedRecord` `revokeSealedRecord` (+ `{hard}` rotate) | vault |
| 4 | portability | `with-audit/portability` | `portabilityStrategy` / `withPortability` / `PortabilityNotEnabledError` | `exportAccessibleData` `withdrawAccessibleData` `requestWithdrawal` `approveWithdrawal` `rejectWithdrawal` `listWithdrawalRequests` | vault (via `UserApi`) |
| 5 | custody | `with-party/custody` | `custodyStrategy` / `withCustody` / `CustodyNotEnabledError` | `grantCustodian` `revokeCustodian` `liberateVault` | noydb/vault |
| 6 | directory | `with-party/directory` | `directoryStrategy` / `withDirectory` / reuse **`DirectoryDisabledError`** (exists) | directory config + user-visibility read/write | noydb |
| 7 | search | `with-lookup/search` (+ `embeddings`) | `searchStrategy` / `withSearch` / `SearchNotEnabledError` | `retrieve` `similarTo` `search` `warmIndex` `flushIndex` | collection. **Resolve embeddings↔search pairing here** (spec open item): embeddings is the ①-write-hook feeding search; decide one `withSearch()` that also enables embedding compute, or a `withEmbeddings()` pair. Recommend a single `withSearch({ embeddings })`. |
| 8 | sequence | `with-commit/sequence` | `sequenceStrategy` / `withSequence` / `SequenceNotEnabledError` | `vault.sequence()` | vault |
| 9 | cargo | `with-cargo` | `cargoStrategy` / `withCargo` / `CargoNotEnabledError` | `extractPartition` `adoptPartition` `decryptExtractedPartition` `diffVault` | noydb/vault |
| 10 | pod | `with-pod` | `podStrategy` / `withPod` / `PodNotEnabledError` | `writePod` `readPod` (`vault.dump`/`.load` if pod-routed) | vault |

Each: one commit `feat(hub): gate <svc> behind with<Svc>() (S4)`. If a service's methods turn out to be genuinely always-on infrastructure (not a discrete capability) — STOP and report rather than force a gate.

---

### Task 11: Enforce "every service is opt-in" in check-architecture

**Files:** Modify `scripts/check-architecture.mjs` (the `strategy-opt-in` check), `packages/hub/__tests__/` (a coverage assertion if one exists)

- [ ] **Step 1:** Extend `strategy-opt-in` so that every `with-*/<svc>/` folder must export a `withX()` (archetypes ①+②) UNLESS it's in an explicit `SCHEMA_DECLARED_EXEMPT` list (archetype ③: `computed`, `money`, `links`, `introspection`, `persisted-schemas`, `schema-update`; plus non-service helpers). List each exempt folder with a one-line reason.
- [ ] **Step 2: Run** `node scripts/check-architecture.mjs` → PASS (all ①/② have `withX`, ③ exempt).
- [ ] **Step 3: Commit** — `build(hub): strategy-opt-in requires withX() for every service (③ exempt)`

---

### Task 12: Document archetype ③ as schema-declared

**Files:** Create/modify `docs/subsystems/` pages for `computed`/`money`/`links`/`introspection`/`schema-update`; a short `docs/architecture` note pointing at the two seams.

- [ ] **Step 1:** For each ③ feature, add/confirm a doc line: "schema-declared on `collection({ … })`; no `withX()` — the collection is its opt-in unit; impl lazy-imports from the schema declaration." Verify the lazy-import is real (grep the ③ engines for `await import(`); if a ③ impl is eagerly imported into the floor, note it as a follow-up (out of scope here).
- [ ] **Step 2: Commit** — `docs(hub): archetype-③ schema features are schema-declared (no withX)`

---

### Task 13: ① consistency pass (light)

**Files:** the ① service folders lacking the exact three-file shape (e.g. `forget`, `guards` had `strategy.ts` but no `active.ts`).

- [ ] **Step 1:** For each ① service missing the canonical split, move the `withX()` factory into `active.ts` and keep the `NO_X` stub + type in `strategy.ts` — behavior-preserving (suite green). Do NOT change any ① public API. Skip services already conforming.
- [ ] **Step 2: Run** full suite + check-architecture → green.
- [ ] **Step 3: Commit** — `refactor(hub): normalize ① services to strategy/active/index shape (S4)`

---

## Self-Review

- **Spec coverage:** Seam A (①+② `withX`) → Tasks 1–10; the ② hard-opt-in + `NotEnabledError` → recipe + every ② task; Seam B (③ schema-declared, exempt) → Tasks 11–12; canonical 3-file shape → recipe + Task 13; `strategy-opt-in` enforcement → Task 11; success criteria (tree-shaking, floor drop, gate tests) → per-task tests + Task 11. ✓
- **Placeholders:** the two spec "open items" (embeddings↔search pairing; named-fields-vs-array) are resolved in-plan — pairing decided in Task 7 (single `withSearch({embeddings})`), and the plan keeps named `…Strategy` fields (no array migration). ✓
- **Type consistency:** every ② service uses the uniform quintuple `XStrategy` / `NO_X` / `withX` / `XNotEnabledError` / `xStrategy` field; names in the Task-2–10 table match this scheme. `directory` reuses the existing `DirectoryDisabledError` (noted). ✓
