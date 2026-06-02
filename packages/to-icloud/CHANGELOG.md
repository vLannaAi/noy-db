# @noy-db/to-icloud

## 0.2.0-pre.5

Version-only lockstep bump; no source changes since pre.4.

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

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.9


## 0.1.0-pre.8

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.8

## 0.1.0-pre.7

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0

## 1.0.0

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

  The `UserProfileProvider` interface is documented in `docs/subsystems/user-envelope.md` and `docs/superpowers/specs/2026-05-05-user-envelope-design.md`. Implementation lands post-1.0 alongside managed-passphrase mode (#14).

  ## Documentation

  - `docs/subsystems/user-envelope.md` — full subsystem reference
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

  None. All additions are additive; default behavior of pre-existing vaults is unchanged. Pre-existing vaults have a documented one-time DEK-rotate workflow when adopting `vault.user.*` for multi-principal reads (see "Edge cases & limits" in `docs/subsystems/user-envelope.md`).

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
