# Issue #11 — @noy-db/pinia — augmentation plugin for existing stores

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-06
- **Milestone:** v0.3.0
- **Labels:** type: feature, release: v0.3, area: pinia

---

# `createNoydbPiniaPlugin` — augmentation path

Part of #6 (v0.3 release).

## Scope

Inside `packages/pinia/`, export `createNoydbPiniaPlugin(options)` — a Pinia plugin that lets existing `defineStore()` stores opt into NOYDB persistence by adding a single `noydb:` option, without changing component code. Implements the augmentation path described in ROADMAP.md "5. `@noy-db/pinia` — augmentation path".

## Why

Greenfield projects use `defineNoydbStore` (#4). Existing apps with hundreds of `defineStore()` calls need a non-invasive opt-in. Without this, existing Vue/Pinia teams cannot adopt v0.3 without rewrites.

## Technical design

- `packages/pinia/src/plugin.ts` — exports `createNoydbPiniaPlugin(options: { adapter, user, secret })`. Returns a `PiniaPlugin`.
- Reads each store's `noydb` option (declared via Pinia's `defineStore` options object): `{ compartment: string; collection: string; persist: keyof State | (keyof State)[] }`.
- On store install: opens the compartment lazily, hydrates the `persist` keys from the collection, and subscribes via `store.$subscribe` to write back changes encrypted via the configured `Noydb` instance.
- `secret` is a function (`() => string | Promise<string>`) so the passphrase can come from a prompt, biometric unlock, or session token — never stored in config.
- Works alongside `pinia-plugin-persistedstate` (no conflict on key names) and Vue Devtools (subscriptions visible).
- Augments Pinia's `DefineStoreOptionsBase` via TS module augmentation so `noydb:` autocompletes inside `defineStore()` calls.

## Acceptance criteria

- [ ] **Implementation:** `createNoydbPiniaPlugin` exported from `@noy-db/pinia`.
- [ ] **Unit tests:** `__tests__/plugin.test.ts` with at least 12 `it()` blocks: plugin installs without options error, store with `noydb` option hydrates from memory adapter, store without `noydb` option is untouched, `persist: 'list'` syncs only that key, `persist: ['a','b']` syncs multiple keys, `$subscribe` writes encrypted envelope, `secret` function called only once per session, errors during hydration set `store.$noydbError`, two stores share one adapter cleanly, plays nicely with `pinia-plugin-persistedstate`, devtools metadata still attached, module augmentation surfaces `noydb` in `defineStore` options type.
- [ ] **Integration tests:** end-to-end fixture mounting two existing `defineStore` stores plus the plugin, asserting reactive round-trip through `@noy-db/memory`.
- [ ] **Type tests:** `expect-type` test that `defineStore('x', { state: () => ({}), noydb: { compartment, collection, persist: 'foo' } })` type-checks and that `persist` keys are constrained to state keys.
- [ ] **Docs:** README "Augmentation path" section showing the example from ROADMAP.md.
- [ ] **Changeset:** included in the same `0.3.0` release as #4.
- [ ] **CI:** part of the `pinia` test job.
- [ ] **Bundle:** plugin <5 KB gzipped on its own.

## Dependencies

- Blocked by: #4 (shares the underlying Noydb context wiring), #6 (query DSL types)
- Blocks: nothing

## Estimate

M

## Labels

`release: v0.3`, `area: pinia`, `type: feature`
