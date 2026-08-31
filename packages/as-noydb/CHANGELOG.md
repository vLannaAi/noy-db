# @noy-db/as-noydb

## 0.7.0-pre.16

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.16

## 0.7.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.12

## 0.7.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.9

## 0.7.0-pre.8

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.8

## 0.7.0-pre.6

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.6

## 0.7.0-pre.5

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.5

## 0.7.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.4

## 0.7.0-pre.3

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.3

## 0.7.0-pre.2

### Patch Changes

- **The conformance kit covers both entry-point shapes and both gates (#1209).**

  `0.7.0-pre.0`'s `/as` inversion silently blinded `@noy-db/test-format-conformance`:
  it denied by proxying the vault, which the inverted method-on-vault shape
  (`vault.export(asCsv())`) bypasses — `this` inside `Vault.export` is the real,
  unproxied object. The four inverted formats' fixtures had been deleted rather
  than migrated, so coverage dropped from nine formats to five with nothing
  turning red.

  The kit now **patches the instance** instead: own-property assignment shadows
  the prototype method at call time, intercepting the argument shape, the
  inverted shape, and hub's internal delegation. Denials are matched on the
  kit's own error class rather than "it threw", every entry point gets an
  ungated-success guard, and the **import gate (`assertCanImport`) is covered
  for the first time** — a format shipping a `decode` with no declared import
  entries gets a loud `SKIPPED` line.

  All four fixtures are restored, and a new architecture rule
  (`as-conformance-fixture`) makes a silent fixture deletion impossible.

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.2

## 0.7.0-pre.1

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.7.0-pre.1

## 0.7.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.0

## 0.6.0

### Patch Changes

- Finish the `bundle` → `pod` rename (#1046)

  The rename landed on the functions but not on the types, which left the
  canonical API impossible to adopt: `readPod` declared its options as
  `ReadNoydbBundleOptions` and returned `NoydbBundleReadResult`, so calling
  the non-deprecated function required naming the deprecated concept. That
  is why no first-party package ever migrated.

  **hub** — `ReadPodOptions` and `PodReadResult` are now the canonical
  declarations; `ReadNoydbBundleOptions` and `NoydbBundleReadResult` remain
  as `@deprecated` aliases. Additive: nothing is removed, and both names are
  exported from the root barrel and `/pod`.

  **to-file** — adds `savePod()` / `loadPod()`; `saveBundle()` / `loadBundle()`
  stay as `@deprecated` aliases (identity, not re-implementations, so they
  cannot drift). `savePod()` now writes through the atomic temp-then-rename
  helper added in #1045 — a pod exceeds `PIPE_BUF` essentially always, so the
  previous bare `writeFile` genuinely raced with concurrent readers despite a
  docstring claiming otherwise.

  **as-noydb, cli** — migrated onto `writePod` / `readPod` / `readPodHeader`.

  Stale docstring references to `@noy-db/core` (a package that no longer
  exists) corrected to `@noy-db/hub`. Note `getBundleHandle()` and
  `BundleIntegrityError` are _not_ renamed — those are current API.

- Ship a 0.6.0-pre codemod map; fix prose that taught removed API (#1061, #1062, #1063)

  **New: `@noy-db/hub/codemods/0.6.0-pre.json`** — a machine-readable rename map for
  the 0.6 breaking set (#1052 alias removal, #1058 pod vocabulary, #1054 revocation),
  shipped as a real subpath export like its 0.4.0-pre predecessor. 25 rows, each
  carrying whether a blanket whole-word replace is safe. A new test verifies every
  target exists on the live surface and every source is genuinely gone, so the map
  cannot drift from the code.

  That test immediately corrected two rows I had written from #1052's prose table:
  `SubsystemBus` and `NOYDB_BUNDLE_FORMAT_VERSION_SIGNED` were **internal**, never
  barrel-exported, so no consumer could have held them. #1052's table over-counted
  them as published removals — and separately missed `hasNoydbBundleMagic`, which
  is #1061.

  **Prose fixes** — none of it compiles, so nothing caught it:

  - `README.md` and `SERVICES.md` taught `import { withAggregate } from
'@noy-db/hub/aggregate'`, a subpath deleted in the 0.6 line. Both also used the
    retired `aggregateStrategy` option key. Now `withReduce` from `/reduce` with
    `reduceStrategy` (#1063)
  - `@noy-db/as-noydb`'s npm `description` and README said it wraps
    `writeNoydbBundle()` — the description renders on the package page (#1063)
  - `kernel/noydb.ts` contrasted against `revoke({ rotateKeys: true })`, an option
    removed in #1054. It is JSDoc, so it shipped in the published `.d.ts` (#1062)
  - `docs/foundations/` architecture docs asserted `/kernel` and `/adapter` still
    exist. The governance decision record is annotated rather than rewritten — its
    argument stands, only the seam names moved

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

- Ship a 0.6.0-pre codemod map; fix prose that taught removed API (#1061, #1062, #1063)

  **New: `@noy-db/hub/codemods/0.6.0-pre.json`** — a machine-readable rename map for
  the 0.6 breaking set (#1052 alias removal, #1058 pod vocabulary, #1054 revocation),
  shipped as a real subpath export like its 0.4.0-pre predecessor. 25 rows, each
  carrying whether a blanket whole-word replace is safe. A new test verifies every
  target exists on the live surface and every source is genuinely gone, so the map
  cannot drift from the code.

  That test immediately corrected two rows I had written from #1052's prose table:
  `SubsystemBus` and `NOYDB_BUNDLE_FORMAT_VERSION_SIGNED` were **internal**, never
  barrel-exported, so no consumer could have held them. #1052's table over-counted
  them as published removals — and separately missed `hasNoydbBundleMagic`, which
  is #1061.

  **Prose fixes** — none of it compiles, so nothing caught it:

  - `README.md` and `SERVICES.md` taught `import { withAggregate } from
'@noy-db/hub/aggregate'`, a subpath deleted in the 0.6 line. Both also used the
    retired `aggregateStrategy` option key. Now `withReduce` from `/reduce` with
    `reduceStrategy` (#1063)
  - `@noy-db/as-noydb`'s npm `description` and README said it wraps
    `writeNoydbBundle()` — the description renders on the package page (#1063)
  - `kernel/noydb.ts` contrasted against `revoke({ rotateKeys: true })`, an option
    removed in #1054. It is JSDoc, so it shipped in the published `.d.ts` (#1062)
  - `docs/foundations/` architecture docs asserted `/kernel` and `/adapter` still
    exist. The governance decision record is annotated rather than rewritten — its
    argument stands, only the seam names moved

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.15

## 0.6.0-pre.14

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.14

## 0.6.0-pre.13

### Patch Changes

- Finish the `bundle` → `pod` rename (#1046)

  The rename landed on the functions but not on the types, which left the
  canonical API impossible to adopt: `readPod` declared its options as
  `ReadNoydbBundleOptions` and returned `NoydbBundleReadResult`, so calling
  the non-deprecated function required naming the deprecated concept. That
  is why no first-party package ever migrated.

  **hub** — `ReadPodOptions` and `PodReadResult` are now the canonical
  declarations; `ReadNoydbBundleOptions` and `NoydbBundleReadResult` remain
  as `@deprecated` aliases. Additive: nothing is removed, and both names are
  exported from the root barrel and `/pod`.

  **to-file** — adds `savePod()` / `loadPod()`; `saveBundle()` / `loadBundle()`
  stay as `@deprecated` aliases (identity, not re-implementations, so they
  cannot drift). `savePod()` now writes through the atomic temp-then-rename
  helper added in #1045 — a pod exceeds `PIPE_BUF` essentially always, so the
  previous bare `writeFile` genuinely raced with concurrent readers despite a
  docstring claiming otherwise.

  **as-noydb, cli** — migrated onto `writePod` / `readPod` / `readPodHeader`.

  Stale docstring references to `@noy-db/core` (a package that no longer
  exists) corrected to `@noy-db/hub`. Note `getBundleHandle()` and
  `BundleIntegrityError` are _not_ renamed — those are current API.

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
