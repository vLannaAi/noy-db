# Issue #8 — @noy-db/nuxt — Nuxt 4 module (auto-imports, SSR safety, devtools)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-06
- **Milestone:** v0.3.0
- **Labels:** type: feature, release: v0.3, area: nuxt

---

# `@noy-db/nuxt` — Nuxt 4 module

Part of #6 (v0.3 release).

## Scope

New package `packages/nuxt/` published as `@noy-db/nuxt`. Nuxt 4+ exclusive — no Nuxt 3 compatibility shim. Built with `defineNuxtModule` v4, Nitro 3, Vue 3.5+, ESM-only, Node 20+. Provides auto-imports, an SSR-safe runtime plugin, a devtools tab, optional Nitro server proxy, and optional scheduled backup tasks. Registers the `nuxi noydb` namespace (implementation in #3).

## Why

Existing Nuxt 4 projects must be able to adopt NOYDB with one line in `nuxt.config.ts`. This is the second front door to the v0.3 adoption goal alongside the scaffolder.

## Technical design

- `packages/nuxt/src/module.ts` exports `defineNuxtModule({ meta: { name: '@noy-db/nuxt', configKey: 'noydb', compatibility: { nuxt: '^4.0.0' } } })`.
- Options shape (typed, autocompleted in `nuxt.config.ts`): `{ adapter, sync?, auth?, devtools?, pinia? }` — see ROADMAP.md "2. `@noy-db/nuxt`".
- Auto-imports registered: `useNoydb`, `useCollection`, `useQuery`, `useSync`, `defineNoydbStore`. Implemented via `addImports`.
- Runtime plugin is `runtime/plugin.client.ts` only — never registered on the server.
- `useCollection()` returns `{ data, status, error, refresh, clear }` to match Nuxt 4's `useAsyncData` shape. During SSR `data` is empty/null and `status === 'idle'`.
- Devtools tab via `@nuxt/devtools-kit` v2 — compartment tree, sync status, ledger tail, query playground, keyring inspector. Stripped from production builds.
- Optional Nitro server proxy (off by default) at `runtime/server/api/noydb/[...].ts` — proxies ciphertext only; CI must verify the server bundle never imports `crypto.subtle` or DEK/KEK symbols.
- Optional Nitro task `runtime/server/tasks/noydb-backup.ts` for scheduled encrypted backups.
- `nitro:build:before` hook asserts the server bundle does not contain forbidden symbols. Fails the build otherwise.

## Acceptance criteria

- [ ] **Implementation:** `packages/nuxt/` exports `defineNuxtModule` default, builds with `@nuxt/module-builder`.
- [ ] **Unit tests:** `__tests__/module.test.ts` with at least 12 `it()` blocks: module loads with default options, each option branch (adapter / sync / auth / devtools / pinia), auto-imports registered, client plugin registered only on client, server plugin not registered, devtools tab disabled in prod, Nitro proxy off by default, options type-check.
- [ ] **Integration tests:** Nuxt fixture in `packages/nuxt/test/fixtures/basic/` built with `@nuxt/test-utils`; asserts pages render, `useCollection` hydrates client-side, SSR HTML contains skeleton not plaintext.
- [ ] **Server-bundle assertion test:** parses the built Nitro output and fails if it contains the strings `crypto.subtle`, `decrypt`, `DEK`, `KEK`, or `unwrapKey`.
- [ ] **Type tests:** `expect-type` checks on the `noydb` config key in `nuxt.config.ts`.
- [ ] **Docs:** `packages/nuxt/README.md` with one-line install + every option; update `docs/getting-started.md`.
- [ ] **Changeset:** new package release at `0.3.0`.
- [ ] **CI:** new job `nuxt-module-test` running the Nuxt fixture build on Node 20 + 22.
- [ ] **Bundle:** module dist <15 KB gzipped (excluding peer-imported NOYDB packages).

## Dependencies

- Blocked by: #4 (defineNoydbStore must exist for the auto-import)
- Blocks: #3 (nuxi extension lives in this package), #10 (reference demo)

## Estimate

L

## Labels

`release: v0.3`, `area: nuxt`, `type: feature`
