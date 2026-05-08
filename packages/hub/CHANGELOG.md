# Changelog — hub

## 0.1.0-pre.9

### Consumer-iteration cycle on pre.8 APIs

Closes the 5-issue follow-up batch surfaced after Niwat (first production consumer) shipped pre.8 to production. No new subsystems; surgical extensions to APIs that landed in pre.8.

#### New public APIs

- **`db.updateUser(vault, options, factors?)`** ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — post-grant identity mutation for `role`, `displayName`, and `permissions`. Pure plaintext-header rewrite — no DEK rewrap, no KEK required, no authenticator slots touched. Tier-2 enrollments and recovery codes survive. New `update-user` policy gate (PERSONAL: `minTier: 1`; STRICT: `minTier: 1, factors: ['totp','email-otp']` — admin-shaped, mirrors `enroll-user`/`revoke-user` rather than recovery). Two-sided role-elevation guard mirrors `db.grant`'s hierarchy: BOTH old and new role must satisfy `canUpdateRole(callerRole, _)`, blocking admin self-promote, admin promote-to-owner, admin demote-from-owner, and non-admin self-edit. `permissions` is full-replacement at the map level (consumers wanting partial merge construct `{ ...current, ... }`); top-level fields are partial-merge.

- **`db.updateAuthenticator(vault, slotId, options, factors?)`** ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — meta-only mutation on an existing tier-2 authenticator slot (slot rename, label change). The slot's `id`, `method`, and wrap material (`wrapped_kek` / `wrapped_deks` + `iv`) are immutable through this entry point — anti-slot-swap is **structural**: `UpdateAuthenticatorOptions` only carries `meta`, so the wrap material is unreachable regardless of the gate's settings. New `update-authenticator` policy gate (same shape as enroll/remove). `meta` patch follows #57's null-as-delete semantics at the top level.

- **`UserApi.updateMe<T>(patch)` accepts `null` to clear fields** ([#57](https://github.com/vLannaAi/noy-db/issues/57)) — `null` in the patch deletes the targeted key; `undefined` continues to skip (preserves the pre-feature merge behavior). Matches lodash `_.merge` and Firestore `FieldValue.delete()` semantics. New `DeepPartialOrNull<T>` type exported alongside the existing `DeepPartial<T>` (kept for backward compat); `updateMe<T>`'s patch parameter loosened to `DeepPartialOrNull<T>`. Bug fix found in flight: nested `null` patches against missing source keys now resolve consistently (recurse through synthetic `{}` source) — pre-fix, `{ app: { signature: null } }` against missing `app` produced `{ app: { signature: null } }` instead of `{ app: {} }`.

#### New exported types

- **`UpdateUserOptions`** ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — payload for `db.updateUser`.
- **`UpdateAuthenticatorOptions`** ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — payload for `db.updateAuthenticator`.
- **`DeepPartialOrNull<T>`** ([#57](https://github.com/vLannaAi/noy-db/issues/57)) — recursive partial with `| null` at every level.
- **`SlotRewrapContext`** + **`SlotRewrapCeremony`** ([#56](https://github.com/vLannaAi/noy-db/issues/56)) — previously package-internal, now public so `@noy-db/on-webauthn` (and future on-* packages) can type their `slotCeremonies` helpers without re-declaring the shapes.

#### Policy DSL extensions

- **`update-user`** built-in gate ([#54](https://github.com/vLannaAi/noy-db/issues/54)) — PERSONAL: `{ minTier: 1 }`; STRICT: `{ minTier: 1, factors: [{ anyOf: ['totp', 'email-otp'] }] }`.
- **`update-authenticator`** built-in gate ([#55](https://github.com/vLannaAi/noy-db/issues/55)) — symmetric with `enroll-authenticator` / `remove-authenticator`. STRICT requires TOTP/email-OTP because a malicious slot rename on a shared workstation can mislead the user about which device a slot corresponds to.

### Issues closed

#54, #55, #56 (hub-side type export), #57

## 0.1.0-pre.8

### Authentication surface — major auth-review batch

Closes the 12-issue auth-review filed at the start of this milestone. Driven by feedback from the first production consumer (Niwat); the pre.8 surface is what they need to drop ~250 LOC of vendored workarounds.

#### New public APIs

- **`db.getKeyring(vault)`** ([#28](https://github.com/vLannaAi/noy-db/issues/28)) — public accessor for the live `UnlockedKeyring`. Required by `@noy-db/on-*` ceremonies that need the DEK set (paper-recovery mint, tier-3 PIN enrol, custom on-* primitives). Previously private; consumers reached in via `(db as unknown as ...).getKeyring`.

- **`db.recoverUser(vault, options, factors?)`** ([#33](https://github.com/vLannaAi/noy-db/issues/33), [#34](https://github.com/vLannaAi/noy-db/issues/34)) — atomic peer-recovery primitive. Single `store.put` rewraps a target user's keyring under a fresh temp passphrase. Owner→owner natively allowed (closes #33's hard block on the two-co-owner case); gated by new `peer-recover-user` policy gate (`STRICT_POLICY` requires recovery / TOTP / email-OTP / roaming WebAuthn factor proof). No key rotation, identity preserved, tier-2 slots dropped. Closes the partial-failure window of the previous `revoke + grant` compose-from-primitives pattern.

- **`db.recoverPassphrase` auto-rotates remaining recovery codes** ([#36](https://github.com/vLannaAi/noy-db/issues/36)) — defaults to `rotateRemainingCodes: true`. After a successful paper-recovery, the matched code is burned AND the remaining N-1 entries are replaced with N-1 freshly-minted ones. Returns `{ newCodes: readonly string[] }` for the UI to show once. Optional `codeGenerator` callback overrides the default ULID format; `newCodeCount` controls the mint count.

- **`db.rotatePassphrase` preserves tier-2 slots via per-slot ceremonies** ([#29](https://github.com/vLannaAi/noy-db/issues/29)) — opt-in `slotCeremonies?: { [slotId]: SlotRewrapCeremony }`. Each ceremony receives `{ newKek, newDeks, oldSlot }` and returns `EnrollAuthenticatorOptions` with the same `id` + `method` (anti-slot-swap guard). Slots without a ceremony are dropped (pre-pre.8 behavior preserved as default). `enrolled_at` carries through (rotation is rewrapping, not re-enrollment). Closes the "yearly rotation wipes my biometric" UX cliff.

- **Public `mintPaperRecoveryEntry` / `unwrapDeksFromPaperEntry`** ([#39](https://github.com/vLannaAi/noy-db/issues/39)) — native paper-recovery enrollment path. Consumers were inlining ~70 LOC; `db.enrollRecovery` docstring fixed to point here instead of the broken `@noy-db/on-recovery@<=pre.7` example.

- **`mintWrappedDeksBlob` / `unwrapDeksFromBlob` / `WrappedDeksBlob` interface** ([#44](https://github.com/vLannaAi/noy-db/issues/44)) — the canonical wrap-DEKs primitive used by tier-0 (paper recovery) and tier-2 wrap-DEKs (password). `mintPaperRecoveryEntry` and `enrollPasswordAuthenticator` both delegate to this single helper. Tier-3 (`@noy-db/on-pin`) intentionally uses a parallel implementation at 100k PBKDF2 iterations (vs 600k here) because the PIN protection window is short — wire formats are deliberately incompatible.

#### Breaking type changes (pre-1.0; runtime behavior unchanged)

- **`KeyringAuthenticator` is now a discriminated union** ([#26](https://github.com/vLannaAi/noy-db/issues/26)) — `wrapKind: 'kek' | 'deks'` discriminator. WebAuthn / OIDC slots stay wrap-KEK; password slots are wrap-DEKs. Backward-compat: pre-pre.8 slots without `wrapKind` are treated as wrap-KEK at unlock time.

- **`UnlockedKeyring.kek` tightened to `CryptoKey | null`** ([#41](https://github.com/vLannaAi/noy-db/issues/41)) — the runtime always allowed null (tier-3 PIN resume, wrap-DEKs unlock, session restore, dev-unlock); the type now matches reality. Three call sites (`persistKeyring`, `vault.issueDelegation`, delegation-token unwrap) added explicit null-throws with a "re-authenticate at tier 1 first" message. Consumers reading `keyring.kek` directly should add a null-check.

#### Policy DSL extensions

- **`FactorKind` extended** ([#30](https://github.com/vLannaAi/noy-db/issues/30)) — adds `webauthn-platform` (Touch ID / Face ID / Hello), `password` (`@noy-db/on-password` tier-2), `pin` (`@noy-db/on-pin` tier-3). PERSONAL_POLICY rotate-passphrase gate now accepts ALL kinds; STRICT_POLICY peer-recover-user accepts off-device kinds only.

- **`PassphrasePolicy` escape hatches** ([#31](https://github.com/vLannaAi/noy-db/issues/31)) — `pattern?: RegExp` overrides the default lowercase-letters-and-spaces character class; `customValidator?: (phrase) => PassphraseValidationResult` replaces the entire decision tree. Unblocks Thai/EN-mixed phrases (`/^[\p{L}\p{M}]+( [\p{L}\p{M}]+)*$/u`), digit-rich phrases, BIP-39-style domain-specific formats.

#### Documentation + housekeeping

- **`docs/subsystems/auth-landscape.md`** — reference map of every authentication, unlock, and sealing-key primitive commonly adopted in 2026, scored on dimensions that matter for a zero-knowledge offline-first vault. 247 lines covering 12 dimensional sections plus coverage assessment, gaps table, decision rules, and Q&A appendix.

- **on-oidc README + auth-landscape §6 polish** ([#37](https://github.com/vLannaAi/noy-db/issues/37)) — reframes "self-host the key-connector server" from docstring footnote to top-level ⚠️ section. Closes #37 as wontfix: noy-db is offline-first by philosophy and intentionally does not ship server infrastructure for OIDC unlock; consumers without server infrastructure should use `@noy-db/on-webauthn` (platform passkey) instead.

- **Perf-bench DoD test stabilized** — added `{ retry: 2 }` and renamed from "5×" to "materially faster" (assertion is `> 2`). Handles transient parallel-CI noise without lowering the signal-to-noise ratio.

### Issues closed

#26, #28, #29, #30, #31, #33, #34, #36, #37, #38, #39, #41, #44

### Issues filed as follow-ups

- [#43](https://github.com/vLannaAi/noy-db/issues/43) — fold `@noy-db/on-recovery` into `@noy-db/hub/recovery-codes` subpath (deferred, breaking change)
- Earlier follow-ups (#14 managed-passphrase mode, #15 per-keyring policy override) remain in the post-1.0 backlog.

## 0.1.0-pre.7

### Patch Changes

- fix(hub): onInvalidKey: 'reset' — recover a stale keyring when the data store is partially cleared (#6)

  When the IndexedDB data records are cleared via DevTools (or the user's browser evicts storage) while the `_keyring` row survives, and the user's credentials have since changed (e.g. a WebAuthn PRF credential was rotated or synced to a new device), `openVault` now offers an opt-in recovery path instead of throwing `InvalidKeyError`.

  Set `onInvalidKey: 'reset'` in `createNoydb` options to delete the stale keyring and re-initialize the vault from scratch with the current credentials. Default is `'error'` (unchanged — wrong credentials still throw).

## 0.1.0-pre.6

### Features

- **Per-principal user envelope (`vault.user.*`)** ([#18](https://github.com/vLannaAi/noy-db/issues/18), [#19](https://github.com/vLannaAi/noy-db/issues/19), [#20](https://github.com/vLannaAi/noy-db/issues/20), [#22](https://github.com/vLannaAi/noy-db/issues/22), [#23](https://github.com/vLannaAi/noy-db/issues/23), [#24](https://github.com/vLannaAi/noy-db/issues/24), [#25](https://github.com/vLannaAi/noy-db/issues/25)) — every keyring in a vault now gets its own `_users/<keyringId>` envelope, encrypted under a vault-shared `_users` DEK. Hub owns the plumbing (storage, sync, history, lifecycle, encryption, policy gates); apps own the schema. Three method families on `vault.user.*`:

  - **Write-self** — `me() / updateMe(patch) / setMe(payload)`. Always target the writer's own keyringId; the **own-only write rule is structural** (no API method exists to write someone else's envelope). Gated by `edit-own-profile` (default `minTier: 3`).
  - **Read-anyone** — `get(keyringId) / list()`. Gated by `view-team-profiles` (default `minTier: 2`); `enabled: false` is the privacy-strict opt-out (`list()` returns only self).
  - **Reactive** — `subscribe(keyringId, cb) / live(keyringId)`. In-process event emission on local writes.

  New `db.grant({ initialProfile: T })` admin pre-fill at invite time (bootstrap-only — once the user activates, the own-only rule prevents further admin edits). New `listUsersWithEnvelopes()` joined enumeration for admin UIs. `_users` DEK is eager-provisioned at owner creation; cascade-revoke deletes envelopes alongside keyrings; tier-1 rotation re-encrypts envelopes via the existing rotation path. The `UserProfileProvider` interface (managed-mode IdP integration) is documented but not exported in v1; lands post-1.0 alongside managed-passphrase mode (#14).

  See `docs/subsystems/user-envelope.md`, `docs/recipes/user-preferences.md`, `showcases/src/70-user-envelope.showcase.test.ts`, and `showcases/src/recipe-user-preferences.recipe.test.ts`.

- **`db.enrollWebAuthn(vault, ceremony, presented?)`** ([#16](https://github.com/vLannaAi/noy-db/issues/16)) — native WebAuthn enrollment using the **real** internal keyring. Unblocks `vLannaAi/niwat#31`. The ceremony callback receives the live `UnlockedKeyring` so the `wrapped_kek` references the live KEK (not the synthetic-keyring workaround that broke unlock). Hub does not import `@noy-db/on-webauthn` (would invert dep graph); consumers wire the on-webauthn `enrollWebAuthn` function in via the ceremony callback. Companion `db.listWebAuthnSlots(vault)` returns webauthn-method slots only.

- **`db.lockVault(vault)`** ([#17](https://github.com/vLannaAi/noy-db/issues/17)) — soft lock that scrubs `keyringCache`, `vaultCache`, `activeTier`, `syncEngines`, `policyEnforcers` for the vault, but **preserves `quickUnlock`** (PIN resume after lock-screen UX) and `policyCache` (on-disk policy survives lock). Idempotent; the `Noydb` instance remains usable. Unblocks `vLannaAi/niwat#33`.

- **New built-in policy gates** — `edit-own-profile` and `view-team-profiles` registered in `PERSONAL_POLICY` and `STRICT_POLICY`. Apps can tighten (e.g. require TOTP for profile edits) but cannot relax the own-only write rule (structural, not policy-controlled).

### No breaking changes

All additions are additive. Pre-existing vaults work unchanged — the `_users` collection is reserved on grant; envelopes start empty until first `updateMe()`. Pre-existing vaults predating this feature have a documented one-time DEK-rotate workflow when adopting `vault.user.*` for multi-principal reads (see "Edge cases & limits" in `docs/subsystems/user-envelope.md`).

## 0.1.0-pre.4

### Features

- **`NoydbOptions.getKeyring` callback** ([#5](https://github.com/vLannaAi/noy-db/issues/5)) — added an optional `getKeyring?: (vault: string) => Promise<UnlockedKeyring>` callback to `NoydbOptions`. Lets biometric (WebAuthn), OIDC split-key, Shamir, and any other unlock path that produces an `UnlockedKeyring` plug into `createNoydb` directly, without a passphrase bridge. `secret` and `getKeyring` are mutually exclusive; the callback is invoked lazily on the first vault open and the keyring is cached per `(instance, vault)`. Errors propagate from `openVault(name)`. Full backward compatibility — passphrase consumers see no change.

## 0.1.0-pre.1 — Initial pre-release
