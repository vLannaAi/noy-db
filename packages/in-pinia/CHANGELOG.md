# Changelog — in-pinia

## 0.7.0-pre.0

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.7.0-pre.0
  - @noy-db/in-vue@1.0.0-pre.0

## 0.6.0

### Patch Changes

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

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
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
  - @noy-db/in-vue@1.0.0

## 0.6.0-pre.24

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.24
  - @noy-db/in-vue@1.0.0-pre.24

## 0.6.0-pre.23

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.23
  - @noy-db/in-vue@1.0.0-pre.23

## 0.6.0-pre.22

### Patch Changes

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

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @noy-db/hub@0.6.0-pre.22
  - @noy-db/in-vue@1.0.0-pre.22

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

## 0.2.0-pre.8

### Feature: reactive i18n binding ([#284](https://github.com/vLannaAi/noy-db/pull/284), resolves [#286](https://github.com/vLannaAi/noy-db/issues/286))

Make locale reactive in a Pinia/Vue app over the hub i18n surface. **Non-breaking** — `defineNoydbStore` defaults to `i18n: 'raw'`.

- **`useNoydbI18n`** — reactive active-locale store. `setLocale`/`bindTo` are **state-only** by default (vault sync opt-in via `setLocale(l, { syncVault })`); `bindTo(externalRef)` follows e.g. vue-i18n's `locale` one-way without touching the vault.
- **`defineNoydbStore({ i18n })`** — `'raw'` (default, items keep `{locale}` maps) | `'follow'` (resolve to the global locale, re-read on flip) | `{ locale }` (pin).
- **`useI18nField(mapOrGetter, opts?)`** — reactive `pickLang` (`string | null`, never throws).
- **`useDictLabel`** is now exported and defaults its locale/fallback to `useNoydbI18n`.

> `liveQuery` is not locale-aware yet — resolve its rows at the edge with `useI18nField`/`useDictLabel`.

## 0.2.0-pre.6

### Fix: i18nFields / dictKeyFields not forwarded to collection ([#274](https://github.com/vLannaAi/noy-db/issues/274))

- `NoydbStoreOptions` now accepts `i18nFields` and `dictKeyFields`, forwarded to the underlying `Collection` exactly like the existing `schemaUpdate`/`attestation` pass-through. Apps with i18n or dictionary collections no longer need a separate `vault.collection(name, { i18nFields })` pre-registration call before the store initialises.

## 0.2.0-pre.5

Version-only lockstep bump; no source changes since pre.4.

## 0.2.0-pre.4

### Schema-update forwarding ([#258](https://github.com/vLannaAi/noy-db/pull/258))

- `defineNoydbStore` now forwards `persistJsonSchema` and `schemaUpdate` to the underlying `Collection` (alongside `schema`/`attestation`), so a store-defined collection can opt into the schema-cutover protocol declaratively — no pre-registration `vault.collection(...)` call. Typed off the collection's own options. Closes [#255](https://github.com/vLannaAi/noy-db/issues/255).

## 0.2.0-pre.3

### Attestation field-schema forwarding ([#250](https://github.com/vLannaAi/noy-db/pull/250))

- `defineNoydbStore` now forwards an optional `attestation` field schema to the underlying `Collection` (alongside `schema`), so `vault.issueAttestation(name, id)` works for Pinia-backed collections. Typed off the collection's own option — no new dependency. Stores without it behave exactly as before.

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
