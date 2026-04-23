# {{PROJECT_NAME}}

A Vite + Vue 3 + Pinia + [noy-db](https://github.com/vLannaAi/noy-db)
starter. Pure client-side SPA — no Nuxt, no SSR. Scaffolded by
`create-noy-db`.

## Stack

- **Vite** — dev server + build
- **Vue 3** — `<script setup>` + composition API
- **Pinia** — reactive state management
- **@noy-db/hub** — zero-knowledge encrypted document store
- **@noy-db/in-pinia** — `defineNoydbStore` wires a Pinia store to an
  encrypted collection
- **@noy-db/to-browser-idb** — IndexedDB adapter (atomic CAS, large
  quota)

Everything stored is encrypted with AES-256-GCM before it touches
IndexedDB. The adapter only ever sees ciphertext.

## When to pick this template

- You want **Vue + Pinia** reactivity without a full Nuxt / SSR setup.
- You're building a **client-side SPA**, a desktop-wrapped
  (Electron / Tauri) app, or embedding into an existing static host.
- You want a shorter install graph and faster dev server startup than
  Nuxt provides.

If you want SSR + file-based routing, pick the `nuxt-default`
template instead (`npm create noy-db@latest -- --template nuxt-default`).
If you want no framework at all, pick `vanilla`.

## Getting started

```bash
pnpm install     # or npm/yarn/bun
pnpm dev         # vite dev on http://localhost:5173
pnpm build       # production build
pnpm preview     # preview the production build
pnpm verify      # run the noy-db integrity check
pnpm typecheck   # vue-tsc
```

First time the page loads it will prompt for a **passphrase** — that
passphrase derives the master key. Lose it and the data is
unrecoverable (by design).

## Project layout

```
src/
  main.ts                  — app bootstrap: pinia + noydb + mount
  App.vue                  — root component
  components/
    InvoiceTable.vue       — reactive table bound to the store
    AddInvoiceForm.vue     — form that dispatches store.add()
  stores/
    invoices.ts            — defineNoydbStore<Invoice>('invoices', { vault: 'demo' })
```

The store exposes:

| Member | Description |
|--------|-------------|
| `items` | reactive array of records |
| `count` | reactive getter |
| `$ready` | promise resolved on first hydration |
| `add(id, record)` | encrypt + persist + update reactive state |
| `update(id, record)` | upsert (`Collection.put` semantics) |
| `remove(id)` | delete + update reactive state |
| `refresh()` | re-hydrate from the adapter |
| `query()` | chainable query DSL |

## Verifying zero-knowledge

Open DevTools → Application → IndexedDB → your origin. Every record
shows `{ _noydb: 1, _v, _ts, _iv, _data }`. The `_data` blob is
AES-GCM ciphertext — the literal record contents never appear.

## Adding a collection

```bash
npx noy-db add clients
```

Scaffolds `src/stores/clients.ts` with a typed Client interface +
a `defineNoydbStore` binding. Edit the generated interface to match
your domain.

## Documentation

- [noy-db getting started](https://github.com/vLannaAi/noy-db/blob/main/docs/START_HERE.md)
- [Topology matrix](https://github.com/vLannaAi/noy-db/blob/main/docs/topology-matrix.md)
- [Architecture](https://github.com/vLannaAi/noy-db/blob/main/docs/architecture.md)
- [Roadmap](https://github.com/vLannaAi/noy-db/blob/main/ROADMAP.md)
