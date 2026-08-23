# @noy-db/on-magic-link

## 0.7.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.0

## 0.6.0

### Minor Changes

- `redeemGrantToken(link, { store, newPhrase, ... })` connects the frozen `#g=` share-link grammar (`@noy-db/hub/share-link`) to the existing `acceptInvite` ladder — the missing Tier-3 wire (#949). It reads `link.grantToken`, throwing the new `GrantTokenMissingError` when absent, and otherwise runs the unchanged TTL → audit-doc-missing fail-closed → revoked → already-accepted (replay) checks, rotates the single-use temp phrase to `newPhrase`, and opens the vault. The grammar's "single-use" claim is now true end to end: a second redemption of the same link throws `InviteAlreadyAcceptedError`. Works identically for invite and peer-recovery redemption — `kind` lives in the decoded payload, not the call site. Pure wiring; no new crypto, no change to the safety ladder itself.

### Patch Changes

- Single-source the envelope format version

  14 sites across 13 source files hardcoded `_noydb: 1` instead of using
  `NOYDB_FORMAT_VERSION`, while 85 sites used the constant correctly. All now
  use the constant.

  No behaviour change — the constant is `1`, so every envelope is byte-identical.
  This is groundwork for #1041: nothing currently validates `_noydb` on read, so
  these literals were invisible. Once the format version is bumped and a strict
  reader is added, any surviving literal would emit format-1 envelopes that the
  reader rejects — a runtime failure in delegation, sync presence, keyring and
  metering paths, surfacing only when those envelopes are read back.

  Because `EncryptedEnvelope._noydb` is typed `typeof NOYDB_FORMAT_VERSION`
  rather than `number`, the absence of remaining literals is now compiler-
  verifiable: flipping the constant typechecks clean.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0

## 0.6.0-pre.24

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.24

## 0.6.0-pre.23

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.23

## 0.6.0-pre.22

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.22

## 0.6.0-pre.21

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.21

## 0.6.0-pre.20

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.20

## 0.6.0-pre.19

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.19

## 0.6.0-pre.18

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.18

## 0.6.0-pre.17

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.17

## 0.6.0-pre.16

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.16

## 0.6.0-pre.15

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.15

## 0.6.0-pre.14

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.14

## 0.6.0-pre.13

### Patch Changes

- Single-source the envelope format version

  14 sites across 13 source files hardcoded `_noydb: 1` instead of using
  `NOYDB_FORMAT_VERSION`, while 85 sites used the constant correctly. All now
  use the constant.

  No behaviour change — the constant is `1`, so every envelope is byte-identical.
  This is groundwork for #1041: nothing currently validates `_noydb` on read, so
  these literals were invisible. Once the format version is bumped and a strict
  reader is added, any surviving literal would emit format-1 envelopes that the
  reader rejects — a runtime failure in delegation, sync presence, keyring and
  metering paths, surfacing only when those envelopes are read back.

  Because `EncryptedEnvelope._noydb` is typed `typeof NOYDB_FORMAT_VERSION`
  rather than `number`, the absence of remaining literals is now compiler-
  verifiable: flipping the constant typechecks clean.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.13

## 0.6.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.12

## 0.6.0-pre.11

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.11

## 0.6.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.10

## 0.6.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.9

## 0.6.0-pre.8

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.8

## 0.6.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.7

## 0.6.0-pre.6

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.6

## 0.6.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.5

## 0.6.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.4

## 0.6.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.3

## 0.6.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.2

## 0.6.0-pre.0

### Minor Changes

- `redeemGrantToken(link, { store, newPhrase, ... })` connects the frozen `#g=` share-link grammar (`@noy-db/hub/share-link`) to the existing `acceptInvite` ladder — the missing Tier-3 wire (#949). It reads `link.grantToken`, throwing the new `GrantTokenMissingError` when absent, and otherwise runs the unchanged TTL → audit-doc-missing fail-closed → revoked → already-accepted (replay) checks, rotates the single-use temp phrase to `newPhrase`, and opens the vault. The grammar's "single-use" claim is now true end to end: a second redemption of the same link throws `InviteAlreadyAcceptedError`. Works identically for invite and peer-recovery redemption — `kind` lives in the decoded payload, not the call site. Pure wiring; no new crypto, no change to the safety ladder itself.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.0

## 0.5.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0

## 0.4.0-pre.12

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.12

## 0.4.0-pre.11

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.11

## 0.4.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.10

## 0.4.0-pre.9

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.9

## 0.4.0-pre.8

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.8

## 0.4.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.7

## 0.4.0-pre.6

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.6

## 0.4.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.5

## 0.4.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.4

## 0.4.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.3

## 0.4.0-pre.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.2

## 0.4.0-pre.1

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.1

## 0.4.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.0

## 0.3.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0

## 0.3.0-pre.13

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.13

## 0.3.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.12

## 0.3.0-pre.11

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.11

## 0.3.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.10

## 0.3.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.9

## 0.3.0-pre.8

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.8

## 0.3.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.7

## 0.3.0-pre.6

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.6

## 0.3.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.5

## 0.3.0-pre.4

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.4

## 0.3.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.3

## 0.3.0-pre.2

### Minor Changes

- 0.3 version line continues — lockstep with `@noy-db/hub` 0.3.0-pre.2 (describe() group/order metadata, \_history in the .noydb pod; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.2

## 0.3.0-pre.1

### Minor Changes

- 0.3 version line — lockstep with `@noy-db/hub` 0.3.0-pre.1 (kernel/enclave reorg, family doors, `withX()` service gating; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.1

## 0.2.0-pre.31

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.31

## 0.2.0-pre.5

Docs-only: pruned internal issue-tracker references from source comments (Track A comment-provenance prune). No code or public API change.

## 0.2.0-pre.4

Version-only lockstep bump; no source changes since pre.3.

## 0.2.0-pre.3

Version-only lockstep bump; no source changes since pre.2.

## 0.2.0-pre.2

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.2

## 0.2.0-pre.1

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.1

## 0.1.0-pre.16

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.16

## 0.1.0-pre.15

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.15

## 0.1.0-pre.14

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.14

## 0.1.0-pre.12

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.12

## 0.1.0-pre.11

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0-pre.11

## 0.1.0-pre.9

### Features

- **`acceptInvite` forwards `passphrasePolicy` + `allowWeakPassphrase` to the inner rotation** ([#53](https://github.com/vLannaAi/noy-db/issues/53)) — `AcceptInviteOptions` gains two new optional fields:

  ```ts
  await acceptInvite(encoded, {
    store,
    newPhrase: HYPHENATED_PHRASE,
    passphrasePolicy: { customValidator: ... },  // ← new
    allowWeakPassphrase: false,                  // ← new
  })
  ```

  Pre-#53, the inner `keyringRotatePassphrase` ran the default phrase validator regardless of the consumer's vault policy — `customValidator` / `pattern` set on `noydbOptions.policy` did NOT flow through. Consumers using non-default phrase shapes (Thai/EN-mixed phrases, hyphen-separated alphanumeric, BIP-39 word lists) hit a spurious `WeakPassphraseError` on the rotation step even when their `newPhrase` was valid under their own policy.

  `noydbOptions.policy.passphrase` is intentionally NOT auto-derived — `noydbOptions` flows to the post-rotation `createNoydb`, not the rotation itself; keeping the field explicit avoids a subtle mismatch where the rotation and the opened session validate under different policies. Consumers should pass the same `PassphrasePolicy` to both `noydbOptions.policy.passphrase` and the new `passphrasePolicy` field.

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.9

## 0.1.0-pre.8

### Features

- **Invite + peer-recovery primitives** ([#32](https://github.com/vLannaAi/noy-db/issues/32)) — adds parallel primitives layered on top of hub's `db.grant` (invite — mints a NEW user) and `db.recoverUser` (peer-recovery — rewraps an EXISTING user). The existing delegation-grant primitives are unchanged; these are siblings with a different threat model.

  ```ts
  import {
    issueInvite,
    issuePeerRecovery,
    acceptInvite,
    revokeInvite,
  } from "@noy-db/on-magic-link";

  const { encoded } = await issueInvite(db, "acme", {
    userId,
    displayName,
    role,
    ttlMs,
  });
  // Embed in URL fragment: https://app.example.com/invite#<encoded>
  const { db: bobDb } = await acceptInvite(encoded, { store, newPhrase });
  ```

  Threat model: temp passphrase travels in the URL fragment (server-blind transport). Single-use enforced two ways: (1) rotation inside `acceptInvite` invalidates the temp phrase by construction; (2) audit doc at `_meta/invite-audit-<tokenId>` is marked `acceptedAt` on success — a second `acceptInvite` throws `InviteAlreadyAcceptedError`. Missing-audit-doc throws `InviteAuditMissingError` (revoked-link-shadow-keyring defense).

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.8

## 0.1.0-pre.7

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0

## 0.1.0-pre.6

### Patch Changes

- # v0.1.0-pre.6 — Per-principal user envelope + niwat client-API unblockers

  ## Per-principal user envelope (`vault.user.*`)

  Every keyring in a vault now gets its own `_users/<keyringId>` envelope, encrypted under a vault-shared `_users` DEK. Hub owns the plumbing (storage, sync, history, lifecycle, encryption, policy gates); apps own the schema. The reference shape lives in the showcase and recipe as copy-paste material — `import { type UserShape } from '@noy-db/hub'` is intentionally NOT a thing.

  ### New API on every Vault

  ```ts
  // Write-self — own keyringId only (own-only write rule, structural)
  vault.user.me<T>(): Promise<UserEnvelope<T> | null>
  vault.user.updateMe<T>(patch: DeepPartial<T>, presented?): Promise<UserEnvelope<T>>
  vault.user.setMe<T>(payload: T, presented?): Promise<UserEnvelope<T>>

  // Read-anyone — gated by view-team-profiles (default minTier: 2)
  vault.user.get<T>(keyringId, presented?): Promise<UserEnvelope<T> | null>
  vault.user.list<T>(presented?): Promise<UserEnvelope<T>[]>

  // Reactive — fires on local writes
  vault.user.subscribe<T>(keyringId, cb): Unsubscribe
  vault.user.live<T>(keyringId): LiveUserEnvelope<T>
  ```

  ### New built-in policy gates

  | Gate                 | PERSONAL_POLICY  | STRICT_POLICY                                    |
  | -------------------- | ---------------- | ------------------------------------------------ |
  | `edit-own-profile`   | `{ minTier: 3 }` | `{ minTier: 2, factors: [{ anyOf: ['totp'] }] }` |
  | `view-team-profiles` | `{ minTier: 2 }` | `{ minTier: 2 }`                                 |

  `view-team-profiles.enabled: false` is the privacy-strict opt-out — `vault.user.list()` silently returns `[me]` only; `vault.user.get(other)` throws `PolicyDeniedError`. The own-only write rule is structural — no policy can relax it.

  ### New on `db.grant()`

  `initialProfile?: T` — admin pre-fill for the new principal's first envelope, seeded under the caller's `_users` DEK. Once the user activates, the own-only rule prevents further admin edits. Bootstrap-only.

  ### New on `team/keyring.ts`

  `listUsersWithEnvelopes<T>(adapter, vault, dek)` — joined enumeration of keyrings + their envelopes. Convenience for admin UIs.

  ### Lifecycle binding

  - `createOwnerKeyring()` eager-provisions the `_users` DEK at vault creation; every subsequent `grant()` propagates it via the existing system-collection branch.
  - `revoke()` cascade-deletes the principal's envelope alongside the keyring.
  - DEK rotation re-encrypts every `_users/*` envelope under the fresh DEK (free, since `_users` is in the affected collections set).

  ## Client-API unblockers for niwat

  ### `db.enrollWebAuthn(vault, ceremony, presented?)`

  Native WebAuthn enrollment using the **real** internal keyring. Unblocks `vLannaAi/niwat#31`. The ceremony callback receives the live `UnlockedKeyring` so the `wrapped_kek` references the live KEK (not a synthetic app-layer payload that fails at unlock time). Hub does not import `@noy-db/on-webauthn` (would invert dep graph); consumers wire the on-webauthn `enrollWebAuthn` function in via the ceremony callback.

  ### `db.listWebAuthnSlots(vault)`

  Filter the slot list to webauthn-method slots only. Returns `id`, `enrolledAt`, `credentialId` — useful for "you have N WebAuthn credentials" UI surfaces and `allowCredentials` lookups.

  ### `db.lockVault(vault)`

  Soft-lock that scrubs `keyringCache`, `vaultCache`, `activeTier`, `syncEngines`, `policyEnforcers` for the vault — but preserves `quickUnlock` (PIN resume after lock-screen UX) and `policyCache` (on-disk policy survives lock). Idempotent; the `Noydb` instance remains usable. Unblocks `vLannaAi/niwat#33`.

  ## Forward-compat (documented, not exported in v1)

  The `UserProfileProvider` interface is documented in `docs/services/user-envelope.md` and `docs/superpowers/specs/2026-05-05-user-envelope-design.md`. Implementation lands post-1.0 alongside managed-passphrase mode (#14).

  ## Documentation

  - `docs/services/user-envelope.md` — full subsystem reference
  - `docs/recipes/user-preferences.md` — reference shape pattern
  - `showcases/src/70-user-envelope.showcase.test.ts` — Hub API end-to-end (vitest)
  - `showcases/src/recipe-user-preferences.recipe.test.ts` — runnable recipe (vitest)
  - `features.yaml` — registered (validates clean: 26 features, 6 recipes)

  ## Tests

  - 41 new user-envelope tests (storage, API, lifecycle, gates, team integration)
  - 6 new enroll-webauthn tests
  - 7 new lock-vault tests
  - Hub suite: 1297/1297 green. Full repo: 2338/2338 green.

  ## Breaking changes

  None. All additions are additive; default behavior of pre-existing vaults is unchanged. Pre-existing vaults have a documented one-time DEK-rotate workflow when adopting `vault.user.*` for multi-principal reads (see "Edge cases & limits" in `docs/services/user-envelope.md`).

  ## Issues closed

  - #16 — feat(hub): db.enrollWebAuthn() — native WebAuthn enrollment using real keyring
  - #17 — feat(hub): db.lockVault() — soft lock that clears DEKs without destroying the instance
  - #18 — feat(hub): \_meta/user/<keyringId> envelope storage primitive
  - #19 — feat(hub): vault.user.\* API surface + own-only write rule
  - #20 — feat(hub): keyring lifecycle binding for user envelope (grant/revoke + initialProfile)
  - #21 — feat(hub): magic-link grant — initialProfile bootstrap (closed as scope-corrected; covered by #20 via GrantOptions.initialProfile on the regular grant path; team/magic-link-grant.ts is tier delegation, not user creation)
  - #22 — feat(hub): policy gates edit-own-profile + view-team-profiles
  - #23 — feat(hub): team integration — listKeyringsWithUsers() + presence displayName
  - #24 — showcase: 70-user-envelope + recipe-user-preferences (vitest)
  - #25 — docs(user-envelope): subsystem doc + SUBSYSTEMS.md anchor + features.yaml registry

- Updated dependencies
  - @noy-db/hub@0.1.0
