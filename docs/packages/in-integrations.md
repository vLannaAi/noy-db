# `@noy-db/in-*` — Framework integrations

> **Where your code runs.** Each `in-*` package is a thin reactive binding
> that makes noy-db feel native inside a specific framework or library.
> Zero mandatory dependencies on noy-db's side — every binding is a
> peer-dep so you don't pay for what you don't use.

The `in-` prefix reads as *"runs **in** a framework runtime."* Unlike the
`to-*` family, `in-*` packages are optional ergonomics — you can always use
`@noy-db/hub` directly (the CLI playground does exactly that).

---

## The distinctive ones

| Package | What's unusual |
|---|---|
| [`@noy-db/in-ai`](../../packages/in-ai) | **LLM function-calling with ACL-scoped tools.** Walks your vault, emits OpenAI / Anthropic / Vercel-AI tool definitions gated by the keyring's permissions. An operator whose keyring has `ro` on `invoices` can't even *see* mutation tools — they don't ship to the model. |
| [`@noy-db/in-tanstack-query`](../../packages/in-tanstack-query) | **Framework-free query/mutation options.** Exports `{ queryKey, queryFn }` shapes, not hooks. Same code works across React / Vue / Solid / Svelte TanStack bindings. `bindInvalidation()` auto-invalidates on the collection's change stream. |
| [`@noy-db/in-tanstack-table`](../../packages/in-tanstack-table) | **Bridge to the Query DSL.** `buildQueryFromTableState()` maps Table sorting / filtering / pagination onto `collection.query()` chains. Round-trips for URL / localStorage state. |
| [`@noy-db/in-nextjs`](../../packages/in-nextjs) | **Dual-entry App Router helpers.** Server helpers use `cookies()` for session; `/client` subpath re-exports React hooks. Dynamic import of `next/headers` keeps it test-runnable outside Next. |
| [`@noy-db/in-svelte`](../../packages/in-svelte) | **Zero-dep Svelte stores.** Re-implements the store contract inline — no `svelte` peer-dep needed. Works with Svelte 4 `$store` and Svelte 5 runes. |
| [`@noy-db/in-yjs`](../../packages/in-yjs) | **Yjs Y.Doc interop.** Stores CRDT state in encrypted envelopes. Rich-text fields, collaborative editing, offline merging — all zero-knowledge to the backend. |

---

## The essentials

| Package | When to use |
|---|---|
| [`@noy-db/in-vue`](../../packages/in-vue) | Vue 3 composables — `useNoydb`, `useCollection`, `useSync`, `useBlobURL` (auto-revoking ObjectURL for encrypted blobs). Works outside Nuxt too. |
| [`@noy-db/in-pinia`](../../packages/in-pinia) | Pinia store factory — `defineNoydbStore<T>()` with `store.liveQuery(fn)` for auto-updating reactive queries plus `useCapabilityGrant` for time-boxed approval flows. Typed, reactive, SSR-safe. |
| [`@noy-db/in-nuxt`](../../packages/in-nuxt) | Nuxt 4 module — one config block, auto-import, devtools tab. |
| [`@noy-db/in-react`](../../packages/in-react) | React hooks — `useNoydb`, `useVault`, `useCollection`, `useQuery`, `useSync`. |

---

## Full catalog (10 packages)

**React + ecosystem**

- [`in-react`](../../packages/in-react) · hooks for React 18 / 19
- [`in-nextjs`](../../packages/in-nextjs) · Next.js App Router server + client
- [`in-tanstack-query`](../../packages/in-tanstack-query) · framework-free query options
- [`in-tanstack-table`](../../packages/in-tanstack-table) · Table ↔ Query DSL bridge
- [`in-zustand`](../../packages/in-zustand) · Zustand StateCreator factory

**Vue + ecosystem**

- [`in-vue`](../../packages/in-vue) · Vue 3 composables
- [`in-pinia`](../../packages/in-pinia) · Pinia store factory
- [`in-nuxt`](../../packages/in-nuxt) · Nuxt 4 module

**Other frameworks**

- [`in-svelte`](../../packages/in-svelte) · zero-dep Svelte stores

**Specialised**

- [`in-yjs`](../../packages/in-yjs) · Yjs CRDT interop
- [`in-ai`](../../packages/in-ai) · LLM function-calling adapter

---

## Framework-agnostic option

You never *need* one of these. `@noy-db/hub` ships a stable event system
(`noydb.on('change', …)`, `collection.subscribe(…)`) that any framework can
drive a reactive wrapper against. The `in-*` packages are 100–250 LOC each
— inspect one to learn the pattern and write your own for anything we
don't cover (Qwik, SolidJS, Astro, Alpine, …).

[← Back to README](../../README.md)
