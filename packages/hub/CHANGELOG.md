# Changelog — hub

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
