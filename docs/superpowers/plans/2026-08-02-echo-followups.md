# echo-secret follow-ups (#951 + #952 items 1-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #951 (keyring raw-read consolidation + residual sweeps, body-access ratchet strictly down) and #952 items 1-2 (`echoSecretPolicy` threading, `createNoydb` echo mask hint). #952 item 3's policy-gate consideration and the docs ship-list stay open in #952.

**Architecture:** Pure consolidation + additive option threading on top of the completed echo arc (branch base: `feat/940-echo-secret` @ b10d1dab). No format changes, no new crypto, no behavior change in Task 1; additive-only API in Task 2.

**Tech Stack:** TypeScript ESM, vitest (real crypto), pnpm.

## Global Constraints

- Branch `feat/951-952-echo-followups` (based on `feat/940-echo-secret`). Commit per task. **NEVER add Claude/AI attribution.**
- `kernel/noydb.ts` ceiling ≤ 2161 (checker metric `split('\n').length`; currently 2106). `collection.ts`/`vault.ts`: do not touch.
- `scripts/check-architecture.mjs` PRE_EXISTING_BODY_ACCESS is exact-equality per file: after Task 1's consolidation, SET each touched file's count to its new actual (must strictly DECREASE for keyring.ts; echo-ceremony.ts should reach 0 → remove its entry). Never bump up.
- Surface goldens: Task 1 may export new helpers from keyring.ts (team subpath — check no golden trips). Task 2 widens `NoydbOptions` and rotate/recover inputs — if `kernel-api-surface-golden` or `root-barrel-surface-golden` trips on type text, update that golden in the same commit; `cargo-surface` must NOT change.
- Public types stay backward-compatible: additive optional fields only; `SecretValidationResult` shape must NOT change (use an internal detailed variant instead).
- Gates per task: the named test files + `pnpm --filter @noy-db/hub typecheck` + `pnpm check:architecture`. Final: full `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub test` + `pnpm lint`.

---

### Task 1: #951 — readKeyringFile consolidation + residual sweeps

**Files:**
- Modify: `packages/hub/src/with-party/team/keyring.ts` (all `JSON.parse(… ._data) as KeyringFile` sites; the expiry check inside `loadKeyring`; the stale comment near the `assertStrongEchoSecret` dispatch ~:423)
- Modify: `packages/hub/src/with-party/team/echo-ceremony.ts` (its fetch+parse and expiry block)
- Modify: `packages/hub/src/with-party/team/rotate-recover.ts` and `peer-recover.ts` ONLY IF their parse sites route naturally through the new helper without signature churn (they hold their own grandfather entries; reducing them is bonus, not required — do NOT restructure their flows for it)
- Modify: `packages/hub/src/kernel/validation.ts` (internal detailed validator)
- Modify: `scripts/check-architecture.mjs` (ratchet counts DOWN to new actuals; remove echo-ceremony.ts entry if it reaches 0)
- Test: existing suites only (behavior-preserving) + one new assertion file if helpful

**Interfaces:**
- Produces in keyring.ts:

```ts
/** Parse a raw keyring envelope. Single sanctioned reader of `_data` for keyring files. */
export function parseKeyringEnvelope(envelope: EncryptedEnvelope): KeyringFile
/** Fetch + parse a user's keyring file; undefined when the row is missing. */
export async function readKeyringFile(
  store: NoydbStore,
  vault: string,
  userId: string,
): Promise<{ readonly envelope: EncryptedEnvelope; readonly file: KeyringFile } | undefined>
/** Shared expiry gate — exact semantics of loadKeyring's existing check. */
export function assertKeyringNotExpired(file: KeyringFile): void
```

- Produces in validation.ts (NOT exported from the package): internal `validateEchoSecretDetailed(parts, opts?)` returning the existing result PLUS which check failed (`'empty' | 'prompt' | 'combined'`), so `assertStrongEchoSecret` picks its suggestion without re-running `validateSecret`. Public `validateEchoSecret` delegates to it and strips the extra field (public `SecretValidationResult` unchanged).

- [ ] **Step 1: Inventory.** `grep -n "_data) as KeyringFile\|JSON.parse" packages/hub/src/with-party/team/keyring.ts packages/hub/src/with-party/team/echo-ceremony.ts` — list every site and what error handling surrounds it (loadKeyring throws NoAccessError on missing; listUsers skips; changeSecret/persistKeyring read a row they know exists; updateUser/rotateKeys read other users' rows). Record the list in your report.
- [ ] **Step 2: Implement the three helpers** with semantics that preserve each caller exactly: `readKeyringFile` returns `undefined` on missing row (callers keep their own throw/skip/continue decisions); `parseKeyringEnvelope` is the only `_data` touch. Route every keyring.ts site + echo-ceremony.ts's fetch through them. The expiry check in `loadKeyring` and the duplicated block in `beginEchoUnlock` both become `assertKeyringNotExpired(file)` — byte-identical comparison semantics (Date.parse + Number.isFinite + `>=` cutoff + same error construction).
- [ ] **Step 3: Residuals.** (a) Fix the stale comment at the createOwnerKeyring dispatch ("buildEchoBlock validates nothing" → it type-validates via the encodeEchoParts chokepoint; the strength gate still must fire here). (b) `assertStrongEchoSecret` uses `validateEchoSecretDetailed` — no double `validateSecret` run on failure; existing echo-validation tests (prompt-specific vs generic suggestion) must stay green unchanged.
- [ ] **Step 4: Ratchet down.** Re-run the checker; set keyring.ts's PRE_EXISTING_BODY_ACCESS count to the new actual (expect ~8 or lower), delete the echo-ceremony.ts entry if 0, adjust rotate-recover/peer-recover counts only if you routed them. Comment the entries with the #951 reference. `pnpm check:architecture` green.
- [ ] **Step 5: Verify behavior-preservation.** Run: `pnpm vitest run packages/hub/__tests__/keyring.test.ts packages/hub/__tests__/echo-ceremony.test.ts packages/hub/__tests__/echo-load-keyring.test.ts packages/hub/__tests__/echo-validation.test.ts packages/hub/__tests__/echo-rotate-recover.test.ts packages/hub/__tests__/persistence.test.ts packages/hub/__tests__/bundle-recipient-expiry.test.ts packages/hub/__tests__/rotate-recover.test.ts packages/hub/__tests__/peer-recover.test.ts` + typecheck. All green, zero test edits expected (if a test needed editing, explain why in the report — behavior changes are NOT acceptable in this task).
- [ ] **Step 6: Commit** — `git add -A && git commit -m "refactor(hub): consolidate keyring raw reads + shared expiry gate, ratchet down (#951)"`

---

### Task 2: #952 items 1-2 — echoSecretPolicy threading + createNoydb mask hint

**Files:**
- Modify: `packages/hub/src/kernel/types.ts` (`NoydbOptions`: add `echoSecretPolicy?: EchoSecretPolicy` near `validateSecret` and `echoMaskHint?: string` near `deviceSeal`; import type from `./validation.js`)
- Modify: `packages/hub/src/kernel/secret-mode.ts` (`ownerKeyringOptions` threads both)
- Modify: `packages/hub/src/with-party/team/keyring.ts` (`CreateOwnerKeyringOptions`: add `echoSecretPolicy?: EchoSecretPolicy`; the parts branch passes it to `assertStrongEchoSecret`; `echoMaskHint` already exists there)
- Modify: `packages/hub/src/with-party/team/rotate-recover.ts` (`RotateSecretInput.echoSecretPolicy?: EchoSecretPolicy`, `RecoverSecretInput.echoSecretPolicy?: EchoSecretPolicy`; parts-path validation passes it)
- Modify: `packages/hub/src/kernel/validation.ts` (the `{ minWords: undefined }` quirk: prompt floor must apply the echo default when the override's `minWords` is `undefined` — construct `minWords: opts?.prompt?.minWords ?? DEFAULT_ECHO_PROMPT_MIN_WORDS` style rather than spreading, for every field you default)
- Modify: goldens that trip (kernel-api / root-barrel) — same commit; cargo must not move
- Test: `packages/hub/__tests__/echo-validation.test.ts`, `echo-e2e.test.ts`, `echo-rotate-recover.test.ts` (extend)

**Interfaces:**
- Consumes: `EchoSecretPolicy` (exported from validation.ts, root-exported since arc Task 9), `assertStrongEchoSecret(parts, opts?: EchoSecretPolicy & { allowWeakSecret?: boolean })`.
- Produces: the three additive optional fields above. Semantics: `echoSecretPolicy` is the parts-path counterpart of `secretPolicy` (which stays string-path-only — document that on BOTH fields' JSDoc so the pairing is discoverable); `echoMaskHint` flows `createNoydb → ownerKeyringOptions → createOwnerKeyring → buildEchoBlock(…, maskHint)` and is rejected outside echo mode (add to the `deviceSeal`-style rule in secret-mode.ts: `echoMaskHint` without `secretMode: 'echo'` → ValidationError).

- [ ] **Step 1: Failing tests.**

```ts
// echo-e2e.test.ts additions (adapt fixture names to the file's existing PARTS/store helpers):
it('echoSecretPolicy tightens the prompt floor at createNoydb', async () => {
  // parts with a 3-word prompt pass defaults but fail { prompt: { minWords: 4 } }
  await expect(
    createNoydb({ store: inlineMemory(), user: 'o', secretMode: 'echo', secret: PARTS,
      validateSecret: true, echoSecretPolicy: { prompt: { minWords: 4 } } }).then(db => db.openVault('acme')),
  ).rejects.toThrow(WeakSecretError)
})
it('echoMaskHint lands in the keyring block and surfaces in the ceremony', async () => {
  const store = inlineMemory()
  const db = await createNoydb({ store, user: 'o', secretMode: 'echo', secret: PARTS, echoMaskHint: 'first-letters' })
  await db.openVault('acme')
  const file = JSON.parse((await store.get('acme', '_keyring', 'o'))!._data)
  expect(file.echo.mask_hint).toBe('first-letters')
  const ceremony = await beginEchoUnlock(store, 'acme', { userId: 'o', prompt: PARTS.prompt })
  expect(ceremony.maskHint).toBe('first-letters')
})
it('echoMaskHint outside echo mode is rejected', async () => {
  await expect(createNoydb({ store: inlineMemory(), user: 'o', secret: 'sei parole buone lunghe per policy', echoMaskHint: 'x' }))
    .rejects.toThrow(ValidationError)
})
// echo-rotate-recover.test.ts addition:
it('rotateSecret echoSecretPolicy applies to the new parts', async () => {
  // standard vault; rotate to parts with 3-word prompt; echoSecretPolicy { prompt: { minWords: 4 } } → WeakSecretError, keyring unchanged
})
// echo-validation.test.ts addition:
it('explicit { minWords: undefined } falls back to the ECHO prompt default, not the standard default', () => {
  // prompt with 3 words + { prompt: { minWords: undefined } } → ok:true (echo default 3 applies)
  // prompt with 2 words + same → ok:false
})
```

- [ ] **Step 2: Run to verify failures** (unknown option / typecheck errors / wrong fallback).
- [ ] **Step 3: Implement** per the Files list. Keep `secret-mode.ts` rules in the existing style; managed/standard modes must reject `echoSecretPolicy` too (same rule as `deviceSeal`/`echoMaskHint`: echo-only options).
- [ ] **Step 4: Goldens + gates.** Run the two golden tests; update JSONs only for the names that actually trip. Then the three extended test files + typecheck + `pnpm check:architecture`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(hub): echoSecretPolicy threading + createNoydb echoMaskHint (#952)"`

---

### Task 3: Final gates + wrap

- [ ] `pnpm --filter @noy-db/hub build && pnpm --filter @noy-db/hub test` (full suite) + `pnpm lint` + `pnpm typecheck` + `pnpm check:architecture` — all green.
- [ ] Changeset: append a second local changeset `.changeset/echo-followups.md` (`'@noy-db/hub': minor` — additive options; or patch if only #951 landed — it will be minor given Task 2): one paragraph covering readKeyringFile consolidation (internal) + echoSecretPolicy/echoMaskHint (API).
- [ ] Commit anything outstanding.
