# Changelog — in-vue

## 0.7.0-pre.11

### Patch Changes

- READMEs now document the API that exists (#1252). Every fenced example in
  shipped prose compiles against the built `dist`, enforced by
  `check:prose-examples`.

  The two that were more than renames:

  - **on-recovery**: the README taught the KEK-wrapping architecture removed in
    the tier-2 wrap-DEKs unification (`0.1.0-pre.8`, #42) — `unwrapKEKFromRecovery`,
    `wrapKEKForRecovery`, `kek:` option, `_recovery_<N>` keyring entries, and a
    40-line manual unlock loop, none of which exist. Rewritten to the real flow:
    `generateRecoveryCodeSet({ deks })` → `db.team.enrollRecovery` →
    `db.recoverSecret` (which burns and auto-rotates), with a History note on why
    there is no KEK path.
  - **in-vue**: `enrollBiometric`/`unlockWithBiometric` never existed in any
    version. The section now teaches `@noy-db/on-webauthn`'s real API, which is
    framework-neutral and called from Vue directly.

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.11

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

### Minor Changes

- `@noy-db/in-vue` ships `useLiveQuery()`, and `in-pinia` now delegates to it (#1131).

  `kernel/query/live.ts` described a Vue wrapper for `LiveQuery` as though it were
  provided, plus React/Solid/Svelte adapters that have never existed. #1132
  corrected the prose. This ships the thing.

  **There was exactly one implementation in the family and it was unreachable.**
  `@noy-db/in-pinia`'s `store.liveQuery()` already did this correctly — subscribe
  once, mirror into a `ShallowRef`, re-read `error` on every notification, dispose
  via `onScopeDispose` — but it is a **store method, not an export**, so an export
  enumeration cannot find it, and a Vue consumer not using Pinia had no route at
  all. A pilot consumer hand-rolled the glue instead.

  So `useLiveQuery` lands in `@noy-db/in-vue` (the base binding, no Pinia
  required) and `in-pinia` calls it, keeping the readiness check and the query
  build and nothing else. One implementation rather than two that drift — and
  only one of two copies ever gets an error-semantics fix. `NoydbLiveQuery<R>` is
  now an alias of `UseLiveQueryReturn<R>`, so the type has one definition too.

  ```ts
  const { items, error } = useLiveQuery(
    vault.collection("bills").query().join("entityId", { as: "entity" }).live()
  );
  ```

  **A hub doc-comment correction came out of building it, and it was backwards in
  both halves.** `LiveQuery.value` was documented as _"updated in place… the
  reference returned is the same array"_, advising callers to copy for change
  detection. `refresh()` assigns `this._value = this.recompute()`, so the array is
  **replaced**: the reference changes on every re-run, reference identity IS a
  valid change signal (which is what makes a `shallowRef` correct and a copy
  unnecessary), and a consumer who caches `value` holds a snapshot that never
  updates. Verified by running it, not by reading it — two reads across a
  notification are not `===`, and the first array still holds the old contents.

  ⚠️ **Consumer-visible:** `@noy-db/in-pinia` now declares `@noy-db/in-vue` as a
  (non-optional) peer, matching how the family already wires satellite-to-satellite
  deps — `in-nextjs` → `in-react`, `in-nuxt` → `in-pinia`/`in-vue`,
  `in-devtools-tui` → `in-devtools`. A Nuxt consumer already has it, since
  `in-nuxt` peers on both. A **plain Pinia** consumer must add one line to their
  install; the two ship on the same lockstep version line. It is deliberately not
  optional — `store.liveQuery()` does not work without it, and an optional peer
  would turn that into a runtime resolution failure instead of an install-time one.

  The test suite asserts through a `watch` inside an `effectScope` rather than by
  reading `items.value`. Reading the ref passes even if Vue reactivity is entirely
  broken, since the value is correct either way; only a watcher proves a component
  would re-render.

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
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
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

### Minor Changes

- `@noy-db/in-vue` ships `useLiveQuery()`, and `in-pinia` now delegates to it (#1131).

  `kernel/query/live.ts` described a Vue wrapper for `LiveQuery` as though it were
  provided, plus React/Solid/Svelte adapters that have never existed. #1132
  corrected the prose. This ships the thing.

  **There was exactly one implementation in the family and it was unreachable.**
  `@noy-db/in-pinia`'s `store.liveQuery()` already did this correctly — subscribe
  once, mirror into a `ShallowRef`, re-read `error` on every notification, dispose
  via `onScopeDispose` — but it is a **store method, not an export**, so an export
  enumeration cannot find it, and a Vue consumer not using Pinia had no route at
  all. A pilot consumer hand-rolled the glue instead.

  So `useLiveQuery` lands in `@noy-db/in-vue` (the base binding, no Pinia
  required) and `in-pinia` calls it, keeping the readiness check and the query
  build and nothing else. One implementation rather than two that drift — and
  only one of two copies ever gets an error-semantics fix. `NoydbLiveQuery<R>` is
  now an alias of `UseLiveQueryReturn<R>`, so the type has one definition too.

  ```ts
  const { items, error } = useLiveQuery(
    vault.collection("bills").query().join("entityId", { as: "entity" }).live()
  );
  ```

  **A hub doc-comment correction came out of building it, and it was backwards in
  both halves.** `LiveQuery.value` was documented as _"updated in place… the
  reference returned is the same array"_, advising callers to copy for change
  detection. `refresh()` assigns `this._value = this.recompute()`, so the array is
  **replaced**: the reference changes on every re-run, reference identity IS a
  valid change signal (which is what makes a `shallowRef` correct and a copy
  unnecessary), and a consumer who caches `value` holds a snapshot that never
  updates. Verified by running it, not by reading it — two reads across a
  notification are not `===`, and the first array still holds the old contents.

  ⚠️ **Consumer-visible:** `@noy-db/in-pinia` now declares `@noy-db/in-vue` as a
  (non-optional) peer, matching how the family already wires satellite-to-satellite
  deps — `in-nextjs` → `in-react`, `in-nuxt` → `in-pinia`/`in-vue`,
  `in-devtools-tui` → `in-devtools`. A Nuxt consumer already has it, since
  `in-nuxt` peers on both. A **plain Pinia** consumer must add one line to their
  install; the two ship on the same lockstep version line. It is deliberately not
  optional — `store.liveQuery()` does not work without it, and an optional peer
  would turn that into a runtime resolution failure instead of an install-time one.

  The test suite asserts through a `watch` inside an `effectScope` rather than by
  reading `items.value`. Reading the ref passes even if Vue reactivity is entirely
  broken, since the value is correct either way; only a watcher proves a component
  would re-render.

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

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.9

## 0.1.0-pre.8

### Patch Changes

- Updated dependencies — @noy-db/hub@0.1.0-pre.8

## 0.1.0-pre.7

### Patch Changes

- Updated dependencies
  - @noy-db/hub@0.1.0

## 0.1.0-pre.1 — Initial pre-release
