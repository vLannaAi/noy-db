# {{PROJECT_NAME}}

A Nuxt 4 + Pinia + [noy-db](https://github.com/vLannaAi/noy-db) starter, scaffolded by `create-noy-db`.

## Stack

- **Nuxt 4** — fullstack Vue framework
- **Pinia** — reactive state management
- **@noy-db/nuxt** — Nuxt module for noy-db (auto-imports, SSR-safe runtime, devtools tab)
- **@noy-db/pinia** — `defineNoydbStore` — drop-in `defineStore` replacement that wires a Pinia store to an encrypted compartment + collection
- **@noy-db/{{ADAPTER}}** — storage adapter

Everything stored is encrypted with AES-256-GCM before it touches the adapter. The adapter only ever sees ciphertext.

## Getting started

```bash
pnpm install     # or npm/yarn/bun
pnpm dev         # nuxt dev on http://localhost:3000
pnpm build       # production build
pnpm preview     # preview the production build
pnpm verify      # run the noy-db integrity check
```

## Adding a collection

```bash
npx noy-db add clients
```

This scaffolds `app/stores/clients.ts` and `app/pages/clients.vue`. Edit the generated `Client` interface to match your domain, then visit `/clients` in your dev server.

## Documentation

- [noy-db getting started](https://github.com/vLannaAi/noy-db/blob/main/docs/getting-started.md)
- [End-user features](https://github.com/vLannaAi/noy-db/blob/main/docs/end-user-features.md)
- [Architecture](https://github.com/vLannaAi/noy-db/blob/main/docs/architecture.md)
- [Roadmap](https://github.com/vLannaAi/noy-db/blob/main/ROADMAP.md)
