# #945 store-locator (L5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Publish the **Locator seam** (L5) — a serializable, credentialless store **descriptor**, a factory **registry** (`kind` → factory), a per-device **binding** slot, and a **credential** slot — via `@noy-db/hub/to`, plus a `to-file` reference implementation with a descriptor→store round-trip test. Closes the hub-side of #945 (milestone 46). The `to-webdav`(lan) + `to-aws-s3`(cloud) reference impls live in the sibling **noy-db-to** repo (a companion issue this plan files), since those stores are not in this repo.

**Architecture:** A pod's storage manifest must name *where* data lives without hardcoding a factory or embedding a secret. This adds a `StoreDescriptor` (`{ kind, class, address, options? }`, credentialless by construction) + a `StoreLocator` (`register(kind, factory)` / `resolve(descriptor, { binding?, credentials? })`) that reconstructs a `NoydbStore` from data. Credentials ride a SEPARATE `StoreCredentialSource` param (never the descriptor); per-device details ride a SEPARATE `binding` param. All pure/zero-runtime-dep, in the `@noy-db/hub/to` seam.

**Tech Stack:** TS ESM, vitest, pnpm. Package: `@noy-db/hub` (+ `@noy-db/to-file` reference). Uses the shared `test-harnesses/adapter-conformance`.

## Global Constraints
- Branch `fix/945-store-locator` (off main, AFTER #947/#974 merges). Commit per task. **NEVER add Claude/AI attribution.** Grep the diff for any private-client name before each commit.
- **`@noy-db/hub/to` must add ZERO runtime dependencies** (AC bullet 1) — the descriptor/binding/credential types + the pure registry runtime only.
- Do NOT touch `collection.ts`/`vault.ts`/`noydb.ts` (at/near ceilings). Work lands in `packages/hub/src/port/to/` (unceilinged) + `packages/to-file/`.
- Hub portability: crypto.subtle only, no Node built-ins in hub/src.
- Golden: the `@noy-db/hub/to` surface is frozen by `to-surface.golden.json` — every new exported type/error MUST be added. Update root-barrel/kernel-api goldens only if re-exported there.
- Gates: `pnpm --filter @noy-db/hub build && test` + `pnpm --filter @noy-db/to-file test` + `pnpm --filter @noy-db/hub typecheck` + `pnpm check:architecture` + `pnpm knip` + `pnpm lint`. All green.

## Locked decisions (maintainer)
- **Descriptor shape:** `interface StoreDescriptor { readonly kind: string; readonly class: StoreClass; readonly address: unknown /* kind-specific serializable */; readonly options?: unknown }` where `type StoreClass = 'local' | 'browser' | 'lan' | 'cloud'`. Credentialless BY CONSTRUCTION — the type has no field typed as a function/`StoreCredentialSource`/`StoreCredentials`.
- **Credentials:** reuse the EXISTING `StoreCredentialSource` (`kernel/types.ts:2353`) — no new credential type. It is a resolve-time param, never on the descriptor.
- **Binding:** `type StoreBinding = unknown` (kind-specific device-local supplement — mount point, dir override, drive handle; resolved device-side, never persisted in the pod). Passed as a resolve-time option.
- **Registry:** `createStoreLocator(): StoreLocator` returning `{ register(kind, factory), resolve(descriptor, opts?) }` — a fresh instance (testable, tree-shakeable; the composition root registers the store packages it ships). `StoreFactory = (descriptor, opts: { binding?; credentials? }) => NoydbStore | Promise<NoydbStore>`. `resolve` throws `UnknownStoreKindError` (typed, names the unregistered kind + the registered kinds) when `descriptor.kind` isn't registered.
- **Placement:** all of it in `packages/hub/src/port/to/` (new `locator.ts`), re-exported from `port/to/index.ts` (the `@noy-db/hub/to` seam) — per AC bullet 1.
- **#945 closure:** the hub substrate + `to-file` reference IS the L5 milestone-46 deliverable; the `to-webdav`/`to-aws-s3` reference impls are the noy-db-to companion. Close #945 when this PR merges and the companion is filed (the companion tracks the cross-repo adoption).

## Verified source facts (from recon — .superpowers/sdd/scratch-945-recon.md)
- `@noy-db/hub/to` = `packages/hub/src/port/to/index.ts` (38 lines, types+errors only): re-exports `NoydbStore`/`EncryptedEnvelope`/`VaultSnapshot`/`StoreCredentials`/`StoreCredentialSource`/`ListPageResult`/… + 5 store errors from `kernel/types.ts`/`kernel/errors.ts`. GREENFIELD: no `StoreDescriptor`/`resolveStore`/`Locator` anywhere (grep zero hits).
- `StoreCredentialSource = () => Promise<StoreCredentials>` (kernel/types.ts:2353); `StoreCredentials` = union `aws|token|password` + optional `expiresAt` (kernel/types.ts:2337).
- In-repo `to-*`: `to-file` (`packages/to-file/src/index.ts`, `toFile(options: JsonFileOptions)` :81), `to-browser-idb`, `to-memory`, `to-meter`. `to-webdav`/`to-aws-s3` are in `../noy-db-to` (NOT here).
- Conformance harness: `test-harnesses/adapter-conformance` → `runStoreConformanceTests(name, factory, cleanup)`; used by `packages/to-file/__tests__/conformance.test.ts` etc.
- Golden: `packages/hub/__tests__/to-surface.golden.json` + `to-surface*-golden.test.ts` freeze the `/to` surface.
- Ceilings (untouched): collection.ts 4310/4311, vault.ts 3702/3703, noydb.ts 2133/2161.

---

### Task 1: the Locator substrate — descriptor + registry + errors on `@noy-db/hub/to`

**Files:** new `packages/hub/src/port/to/locator.ts`; `packages/hub/src/port/to/index.ts` (re-export); `packages/hub/src/kernel/errors.ts` (`UnknownStoreKindError`); `packages/hub/__tests__/to-surface.golden.json` (new exports); tests `packages/hub/__tests__/store-locator.test.ts`.

**Behavior:** define `StoreClass`, `StoreDescriptor`, `StoreBinding`, `StoreFactory`, `StoreLocator`, and `createStoreLocator()` per the locked decisions. `resolve(descriptor, opts?)` looks up `descriptor.kind`; unknown → throw `UnknownStoreKindError` (in errors.ts, extends `NoydbError`, carries `kind` + `registeredKinds: string[]`, actionable message). Add a **credential-exclusion type guarantee**: a `ts-expect-error` type test proving you cannot assign a `StoreCredentialSource`/function to any `StoreDescriptor` field, plus a comment on the type stating credentials never ride the descriptor. Export everything new from `port/to/index.ts` and add the names to `to-surface.golden.json` (its test likely sorts — confirm).

- [ ] **Step 1: failing tests** (`store-locator.test.ts`): (a) a `createStoreLocator()` with a stub factory registered for kind `'stub'` → `resolve({kind:'stub',class:'local',address:{}})` returns the stub store; (b) `resolve({kind:'nope',...})` → throws `UnknownStoreKindError` naming `nope` + the registered kinds; (c) a type test (`// @ts-expect-error`) that a descriptor literal with a `credentials: () => …` field does NOT type-check. Run RED.
- [ ] **Step 2: red.**
- [ ] **Step 3: implement** locator.ts + UnknownStoreKindError + re-exports; update to-surface golden.
- [ ] **Step 4: green** + typecheck + `check:architecture` (no ceiling touched) + confirm `pnpm knip` sees the new exports as used (they're public seam exports — knip should be configured to treat entrypoints as used; if knip flags them, they're reachable via the /to entrypoint).
- [ ] **Step 5: commit** — `feat(hub): store-locator seam — descriptor + registry + binding/credential slots on @noy-db/hub/to (#945)`

---

### Task 2: `to-file` reference — descriptor construction + round-trip conformance

**Files:** `packages/to-file/src/index.ts` (a descriptor + a `fileStoreFactory` registered form); a `packages/to-file/__tests__/locator.test.ts` (round-trip). Reuse `runStoreConformanceTests`.

**Behavior:** give `to-file` a descriptor form: `kind: 'file'`, `class: 'local'`, `address: { path: string }` (the JSON file path; mirror `JsonFileOptions`), and a `StoreFactory` `fileStoreFactory(descriptor, opts)` that constructs the same store `toFile()` builds from `address`/`binding`/`credentials` (to-file is credentialless local — credentials unused; binding may carry a dir override, optional). Export the factory + a helper to register it (`registerFileStore(locator)`), OR export the factory and let the test register it. Keep `toFile()` unchanged (additive).

- [ ] **Step 1: failing test** (`to-file/__tests__/locator.test.ts`): register the file factory into a fresh `createStoreLocator()`, `resolve({kind:'file', class:'local', address:{ path: <tmp> }})` → a working `NoydbStore`; run it through `runStoreConformanceTests` (or a subset) proving the descriptor-constructed store passes the 6-method contract; assert the descriptor is JSON-serializable (`JSON.parse(JSON.stringify(descriptor))` round-trips) and carries no function/credential field.
- [ ] **Step 2: red** (factory doesn't exist yet).
- [ ] **Step 3: implement** the descriptor + `fileStoreFactory` + register helper.
- [ ] **Step 4: green** — `pnpm --filter @noy-db/to-file test` + `pnpm --filter @noy-db/hub test`.
- [ ] **Step 5: commit** — `feat(to-file): store-locator descriptor + factory (local reference impl) (#945)`

---

### Task 3: changeset + noy-db-to companion issue + full gates

**Files:** `.changeset/store-locator.md`; (companion issue via gh in noy-db-to).

- [ ] **Step 1: changeset** `.changeset/store-locator.md` (`'@noy-db/hub': minor`, `'@noy-db/to-file': minor`): `@noy-db/hub/to` publishes the store-locator seam — a serializable, credentialless `StoreDescriptor`, a `createStoreLocator()` registry (`register`/`resolve`) with a typed `UnknownStoreKindError`, and separate binding + `StoreCredentialSource` resolve-time slots — so a store can be reconstructed from a pod's storage manifest without embedding a secret. `to-file` ships the `local`-class reference.
- [ ] **Step 2: companion issue** — `gh issue create --repo vLannaAi/noy-db-to` titled "Adopt store-locator descriptor/binding/credential split across to-* stores (depends on noy-db #945)". Body: depends on `@noy-db/hub/to` publishing the locator types; **first slice** = reference descriptor + `register` + round-trip test for `to-webdav` (class `lan`, the model citizen) and `to-aws-s3` (class `cloud`) — this satisfies #945's lan/cloud reference criteria; **then** one follow-up per store (16) for descriptor adoption — opaque-client stores keep the injected-client path as an additive escape hatch; deprecate `to-cloudflare-r2`'s plaintext key shape in favor of `StoreCredentialSource`; `to-nfs`/`to-drive` use the per-device binding slot (`to-drive`'s `HandleStore` is the precedent).
- [ ] **Step 3: full gates** — `pnpm --filter @noy-db/hub build && test`, `pnpm --filter @noy-db/to-file test`, `pnpm --filter @noy-db/hub typecheck`, `pnpm check:architecture`, `pnpm knip`, `pnpm lint`. All green; `to-surface` golden passes.
- [ ] **Step 4: commit** — `docs: store-locator changeset + noy-db-to companion (#945)`

## Out of scope
- Store STRATEGY (mirrors/tiers/cache) — that's `routeStore` composition, deliberately not on the descriptor.
- The `to-webdav`/`to-aws-s3` reference impls + the 16-store adoption — the noy-db-to companion.
- Wiring the locator into `with-pod`/the manifest engine — #945 is the substrate, consumed later.
