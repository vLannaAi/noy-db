# {{PROJECT_NAME}}

A Vite + TypeScript + [noy-db](https://github.com/vLannaAi/noy-db)
starter with **no framework** — just the browser, the hub, and the
IndexedDB store. Scaffolded by `create-noy-db`.

## Stack

- **Vite** — dev server + build
- **@noy-db/hub** — zero-knowledge encrypted document store
- **@noy-db/to-browser-idb** — IndexedDB adapter (atomic CAS, larger
  quota than localStorage)

Everything stored is encrypted with AES-256-GCM before it touches
IndexedDB. The adapter only ever sees ciphertext.

## When to pick this template

- You want the **smallest possible** noy-db starting point.
- You're integrating noy-db into an existing non-framework app (hand-rolled
  DOM, web components, a library).
- You want to learn the hub API without a framework abstraction layer in
  the way.

If you want Vue, Pinia, or Nuxt, pick the `nuxt-default` template
instead (`npm create noy-db@latest -- --template nuxt-default`).

## Getting started

```bash
pnpm install     # or npm/yarn/bun
pnpm dev         # vite dev on http://localhost:5173
pnpm build       # production build
pnpm preview     # preview the production build
pnpm verify      # run the noy-db integrity check
```

First time the page loads it will prompt for a **passphrase** — that
passphrase derives the master key. Lose it and the data is
unrecoverable (by design: the library cannot help you).

## What's in `src/main.ts`

The starter walks through the full lifecycle:

1. `createNoydb({ store: browserIdbStore(), secret: passphrase })` —
   open the encrypted store.
2. `await db.openVault('demo')` — create or open a vault (tenant).
3. `vault.collection<Invoice>('invoices')` — typed collection.
4. CRUD operations — `.put()` / `.get()` / `.delete()` / `.list()`.
5. `db.close()` — clears the master key from memory.

The UI is intentionally plain HTML — swap in your framework of choice
once you've understood the flow.

## Verifying zero-knowledge

Open DevTools → Application → IndexedDB → your origin → `noydb_demo`
(or whatever vault name you used). Every record shows `{ _noydb: 1,
_v, _ts, _iv, _data }`. The `_data` blob is AES-GCM ciphertext — the
literal record contents never appear.

## Adding a collection

```bash
npx noy-db add clients
```

This scaffolds `src/clients.ts` with a typed Client interface +
CRUD helpers. Edit the generated interface to match your domain.

## Documentation

- [noy-db getting started](https://github.com/vLannaAi/noy-db/blob/main/docs/getting-started.md)
- [Topology matrix](https://github.com/vLannaAi/noy-db/blob/main/docs/topology-matrix.md) — pick the right stack
- [Architecture](https://github.com/vLannaAi/noy-db/blob/main/docs/architecture.md)
- [Roadmap](https://github.com/vLannaAi/noy-db/blob/main/ROADMAP.md)
