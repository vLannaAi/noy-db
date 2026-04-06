# NOYDB × Nuxt 4 reference demo

A minimal Nuxt 4 application that exercises the full v0.3 NOYDB stack against a real Vue/Nuxt/Pinia consumer. Serves two purposes:

1. **Integration test.** If this demo builds and runs, every v0.3 package composes correctly. If it doesn't build, something in `@noy-db/nuxt`, `@noy-db/pinia`, `@noy-db/vue`, or `@noy-db/core` is broken.
2. **Documentation.** Shows how a real app wires everything together — the module config, the bootstrap plugin, the stores, the pages that use the Pinia API.

## What it demonstrates

- **`@noy-db/nuxt` module** configured in one block in `nuxt.config.ts`
- **Auto-imported composables** — `defineNoydbStore`, `setActiveNoydb`, `useInvoices`, `useClients` are all imported automatically
- **`defineNoydbStore` stores** for invoices and clients
- **Reactive query DSL** — the invoices list filter (`status`, `minAmount`) recomputes automatically as the user edits the form
- **`@noy-db/browser` adapter** — encrypted records land in IndexedDB; open DevTools → Application → IndexedDB to see the ciphertext
- **SSR safety** — the bootstrap plugin is `noydb.client.ts` (client-only by naming convention); the Nuxt module's internal plugin is also client-only; the server bundle never touches `crypto.subtle`

## Run it

From the monorepo root:

```bash
pnpm install
pnpm --filter @noy-db/playground-nuxt dev
```

Then open <http://localhost:3000>.

## Build it

```bash
pnpm --filter @noy-db/playground-nuxt build
```

This is the **integration test** — if it builds, everything composes correctly.

## Project layout

```
playground/nuxt/
├── nuxt.config.ts            # The one-line @noy-db/nuxt integration
├── app/
│   ├── app.vue               # Root layout (nav + theme)
│   ├── plugins/
│   │   └── noydb.client.ts   # Bootstrap: createNoydb + setActiveNoydb
│   ├── stores/
│   │   ├── invoices.ts       # defineNoydbStore<Invoice>
│   │   └── clients.ts        # defineNoydbStore<Client>
│   └── pages/
│       ├── index.vue         # Dashboard — aggregate stats
│       ├── invoices.vue      # CRUD + reactive query DSL filter
│       └── clients.vue       # CRUD list
└── README.md                 # ← you are here
```

## The important file: `stores/invoices.ts`

The whole point of the demo is that this is all the code needed to declare a reactive, encrypted, Pinia-backed store:

```ts
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo-co',
})
```

Everything else — encryption, key derivation, the adapter write-through, reactivity — happens inside `@noy-db/pinia` and the underlying NOYDB layers. The component just imports `useInvoices()` and uses it like any Pinia store.

## The other important file: `plugins/noydb.client.ts`

This is the **only** file in the demo that imports `@noy-db/core` directly. Every other file goes through the Pinia API. It runs once on client boot and:

1. Constructs a Noydb instance with the browser adapter
2. Binds it globally via `setActiveNoydb()` so every Pinia store created with `defineNoydbStore` can find it

In a real app, the `secret` would come from a passphrase prompt or biometric unlock. The demo hard-codes it so every page loads without user interaction.

> **Do not copy the hardcoded passphrase into production.** It's there to make the demo bootable without a UX detour. Real apps prompt the user.

## What's NOT in the demo

Deferred for later (each tracked as a separate issue / follow-up):

- **`nuxi noydb` CLI extension** — #9
- **Auto-generation via the scaffolder** — #7 hasn't shipped yet
- **Lazy hydration** — the demo uses eager mode because the dataset is tiny (5 seeded records); a separate demo could show `prefetch: false` for 10K+ records
- **Multiple compartments** — single-tenant demo
- **Sync to DynamoDB** — purely local; the browser adapter is enough to show the integration
- **Playwright E2E tests** — the build itself is the integration test; dedicated E2E tests live in a v0.4 follow-up
- **Multi-user keyring UI** — single-owner demo

## Status

Part of the v0.3 release. See [`ROADMAP.md`](../../ROADMAP.md#v03--pinia-first-dx--query--scale).
