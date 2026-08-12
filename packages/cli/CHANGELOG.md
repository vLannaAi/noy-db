# @noy-db/cli

## 0.6.0-pre.16

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.16
  - @noy-db/to-meter@0.6.0-pre.16

## 0.6.0-pre.15

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.15
  - @noy-db/to-meter@1.0.0-pre.15

## 0.6.0-pre.14

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.14
  - @noy-db/to-meter@1.0.0-pre.14

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
  - @noy-db/to-meter@1.0.0-pre.13

## 0.6.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.12
  - @noy-db/to-meter@1.0.0-pre.12

## 0.6.0-pre.11

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.11
  - @noy-db/to-meter@1.0.0-pre.11

## 0.6.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.10
  - @noy-db/to-meter@0.6.0-pre.10

## 0.6.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.9
  - @noy-db/to-meter@1.0.0-pre.9

## 0.6.0-pre.8

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.8
  - @noy-db/to-meter@0.6.0-pre.8

## 0.6.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.7
  - @noy-db/to-meter@1.0.0-pre.7

## 0.6.0-pre.6

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.6
  - @noy-db/to-meter@0.6.0-pre.6

## 0.6.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.5
  - @noy-db/to-meter@1.0.0-pre.5

## 0.6.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.4
  - @noy-db/to-meter@0.6.0-pre.4

## 0.6.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.3
  - @noy-db/to-meter@1.0.0-pre.3

## 0.6.0-pre.2

### Patch Changes

- Documentation-only: distilled in-source JSDoc.

  - Removed shipped design history from doc comments across ~28 source files in `hub` and `cli`, keeping the open questions and the current contract. No behaviour, signature, or type changed — the diff contains **zero non-comment lines**, and the compiled output is identical to `0.6.0-pre.1`.
  - Released because the in-source documentation is a published surface: `noy-db-docs` derives its API index and `llms-full.txt` corpus from these comments, so the distillation needs a version to sync against.

- Updated dependencies
  - @noy-db/hub@0.6.0-pre.2
  - @noy-db/to-meter@0.6.0-pre.2

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
  - @noy-db/to-meter@1.0.0-pre.0

## 0.5.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.5.0
  - @noy-db/to-meter@1.0.0

## 0.4.0

### Patch Changes

- `toMeter()` now returns a store, and absorbs `@noy-db/to-probe` (#845).

  **Breaking: `toMeter` returns `MeteredNoydbStore`, not `{ store, meter }`.**

  ```diff
  - const { store, meter } = toMeter(inner)
  - createNoydb({ store })
  - meter.snapshot()
  + const metered = toMeter(inner)
  + createNoydb({ store: metered })
  + metered.meter.snapshot()
  ```

  Being a real `NoydbStore` (shaped after hub's `RoutedNoydbStore`, which is likewise a store plus a
  control surface) means a meter can sit anywhere a store can — including nested inside `routeStore`,
  so each backend in a compound topology is metered independently:

  ```ts
  const pg = toMeter(toPostgres({ … }))
  const s3 = toMeter(toAwsS3({ … }))
  const db = await createNoydb({ store: routeStore({ default: pg, blobs: s3 }) })
  pg.meter.snapshot()   // per-backend timings, no extra plumbing
  ```

  **`inner` is now optional.** `toMeter()` alone is a self-contained metered in-memory store.

  **The optional surface is metered too.** `listPage`, `getStoreTime` and `tx` previously passed
  through the wrap unmeasured — invisible to a tool whose job is finding where time goes. They are
  wrapped only when the inner store implements them, so a metered store never gains a method its
  inner store lacks.

  **`@noy-db/to-probe` is retired**; `runStoreProbe` and `probeTopology` now ship from
  `@noy-db/to-meter`. It exported no store, so it never fitted the `to<Backend>()` contract, and both
  packages answer the same question — one live, one as a one-shot report.

  ```diff
  - import { runStoreProbe } from '@noy-db/to-probe'
  + import { runStoreProbe } from '@noy-db/to-meter'
  ```

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
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
  - @noy-db/to-meter@1.0.0

## 0.4.0-pre.12

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.12
  - @noy-db/to-meter@1.0.0-pre.12

## 0.4.0-pre.11

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.11
  - @noy-db/to-meter@0.4.0-pre.11

## 0.4.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.10
  - @noy-db/to-meter@1.0.0-pre.10

## 0.4.0-pre.9

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.9
  - @noy-db/to-meter@1.0.0-pre.9

## 0.4.0-pre.8

### Patch Changes

- `toMeter()` now returns a store, and absorbs `@noy-db/to-probe` (#845).

  **Breaking: `toMeter` returns `MeteredNoydbStore`, not `{ store, meter }`.**

  ```diff
  - const { store, meter } = toMeter(inner)
  - createNoydb({ store })
  - meter.snapshot()
  + const metered = toMeter(inner)
  + createNoydb({ store: metered })
  + metered.meter.snapshot()
  ```

  Being a real `NoydbStore` (shaped after hub's `RoutedNoydbStore`, which is likewise a store plus a
  control surface) means a meter can sit anywhere a store can — including nested inside `routeStore`,
  so each backend in a compound topology is metered independently:

  ```ts
  const pg = toMeter(toPostgres({ … }))
  const s3 = toMeter(toAwsS3({ … }))
  const db = await createNoydb({ store: routeStore({ default: pg, blobs: s3 }) })
  pg.meter.snapshot()   // per-backend timings, no extra plumbing
  ```

  **`inner` is now optional.** `toMeter()` alone is a self-contained metered in-memory store.

  **The optional surface is metered too.** `listPage`, `getStoreTime` and `tx` previously passed
  through the wrap unmeasured — invisible to a tool whose job is finding where time goes. They are
  wrapped only when the inner store implements them, so a metered store never gains a method its
  inner store lacks.

  **`@noy-db/to-probe` is retired**; `runStoreProbe` and `probeTopology` now ship from
  `@noy-db/to-meter`. It exported no store, so it never fitted the `to<Backend>()` contract, and both
  packages answer the same question — one live, one as a one-shot report.

  ```diff
  - import { runStoreProbe } from '@noy-db/to-probe'
  + import { runStoreProbe } from '@noy-db/to-meter'
  ```

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.8
  - @noy-db/to-meter@0.4.0-pre.8

## 0.4.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.7
  - @noy-db/to-meter@1.0.0-pre.7
  - @noy-db/to-probe@1.0.0-pre.7

## 0.4.0-pre.6

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.6
  - @noy-db/to-meter@1.0.0-pre.6
  - @noy-db/to-probe@1.0.0-pre.6

## 0.4.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.5
  - @noy-db/to-meter@1.0.0-pre.5
  - @noy-db/to-probe@1.0.0-pre.5

## 0.4.0-pre.4

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.4.0-pre.4
  - @noy-db/to-meter@1.0.0-pre.4
  - @noy-db/to-probe@1.0.0-pre.4

## 0.4.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.3
  - @noy-db/to-meter@1.0.0-pre.3
  - @noy-db/to-probe@1.0.0-pre.3

## 0.4.0-pre.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.2
  - @noy-db/to-meter@1.0.0-pre.2
  - @noy-db/to-probe@1.0.0-pre.2

## 0.4.0-pre.1

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.1
  - @noy-db/to-meter@1.0.0-pre.1
  - @noy-db/to-probe@1.0.0-pre.1

## 0.4.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.4.0-pre.0
  - @noy-db/to-meter@1.0.0-pre.0
  - @noy-db/to-probe@1.0.0-pre.0

## 0.3.0

### Patch Changes

- CLI / scaffolder packaging polish (#704, #705).

  #704 — `create-noy-db` is published unscoped, but its README, package description, `--help`, and
  code comments documented the scoped `npm create @noy-db` / `@noy-db/create` spelling, which 404s.
  Every documented invocation now points at the working `npm create noy-db`, and the bin-naming
  rationale (create.ts / tsup.config.ts) is rewritten to describe the actual unscoped package rather
  than a never-shipped scoped one. No `@noy-db/create` alias is published — the canonical invocation
  is `npm create noy-db`.

  #705 — developer-tooling polish:

  - `@noy-db/in-devtools` and `@noy-db/in-devtools-tui` now ship a README (they published blank npm
    pages) and include it in `files`.
  - `noydb --version` derives from `package.json` at build time (was hardcoded `0.1.0`); the stale
    version string is dropped from the `@noy-db/cli` README.
  - Finished two truncated help/comment sentences: `--sync (multi-backend, )` → `(multi-backend)` in
    the scaffolder `--help`, and a dangling `monitor.ts` doc sentence.
  - `noydb config scaffold` now writes the loadable config to stdout and the `.env` template to
    stderr, so `noydb config scaffold > noydb.config.mjs` produces a clean, loadable config file.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
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
  - @noy-db/to-meter@1.0.0
  - @noy-db/to-probe@1.0.0

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
  - @noy-db/to-meter@1.0.0-pre.13
  - @noy-db/to-probe@1.0.0-pre.13

## 0.3.0-pre.12

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.12
  - @noy-db/to-meter@1.0.0-pre.12
  - @noy-db/to-probe@1.0.0-pre.12

## 0.3.0-pre.11

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.11
  - @noy-db/to-meter@1.0.0-pre.11
  - @noy-db/to-probe@1.0.0-pre.11

## 0.3.0-pre.10

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.10
  - @noy-db/to-meter@1.0.0-pre.10
  - @noy-db/to-probe@1.0.0-pre.10

## 0.3.0-pre.9

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.9
  - @noy-db/to-meter@1.0.0-pre.9
  - @noy-db/to-probe@1.0.0-pre.9

## 0.3.0-pre.8

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.8
  - @noy-db/to-meter@1.0.0-pre.8
  - @noy-db/to-probe@1.0.0-pre.8

## 0.3.0-pre.7

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.7
  - @noy-db/to-meter@1.0.0-pre.7
  - @noy-db/to-probe@1.0.0-pre.7

## 0.3.0-pre.6

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.3.0-pre.6
  - @noy-db/to-meter@1.0.0-pre.6
  - @noy-db/to-probe@1.0.0-pre.6

## 0.3.0-pre.5

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.5
  - @noy-db/to-meter@0.3.0-pre.5
  - @noy-db/to-probe@0.3.0-pre.5

## 0.3.0-pre.4

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.4
  - @noy-db/to-meter@0.3.0-pre.4
  - @noy-db/to-probe@0.3.0-pre.4

## 0.3.0-pre.3

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.3
  - @noy-db/to-meter@0.3.0-pre.3
  - @noy-db/to-probe@0.3.0-pre.3

## 0.3.0-pre.2

### Minor Changes

- 0.3 version line continues — lockstep with `@noy-db/hub` 0.3.0-pre.2 (describe() group/order metadata, \_history in the .noydb pod; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.3.0-pre.2
  - @noy-db/to-meter@0.3.0-pre.2
  - @noy-db/to-probe@0.3.0-pre.2

## 0.3.0-pre.1

### Minor Changes

- 0.3 version line — lockstep with `@noy-db/hub` 0.3.0-pre.1 (kernel/enclave reorg, family doors, `withX()` service gating; see the hub changelog). No package-specific changes beyond the hub realignment.

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/to-meter@0.3.0-pre.1
  - @noy-db/to-probe@0.3.0-pre.1
  - @noy-db/hub@0.3.0-pre.1

## 0.2.0-pre.31

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.2.0-pre.31
  - @noy-db/to-meter@0.2.0-pre.31
  - @noy-db/to-probe@0.2.0-pre.31

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

### Minor Changes

- `noydb describe` — read a `.noydb` bundle and emit a YAML/JSON audit of its structure ([#176](https://github.com/vLannaAi/noy-db/issues/176)).

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
  - @noy-db/to-meter@0.1.0
  - @noy-db/to-probe@0.1.0

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
  - @noy-db/to-probe@1.0.0
  - @noy-db/to-meter@1.0.0
