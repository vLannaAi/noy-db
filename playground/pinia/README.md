# NOYDB + Pinia playground

A minimal Vue 3 + Vite + Pinia app demonstrating `@noy-db/pinia`'s `defineNoydbStore`.

## What it shows

- One-line Pinia adoption: a single `defineNoydbStore` call returns a fully-typed reactive store backed by encrypted IndexedDB
- The chainable query DSL filtering by status and minimum amount, recomputing reactively
- `add()` / `remove()` mutations triggering automatic re-renders
- The active NOYDB instance bound globally with `setActiveNoydb()` from `main.ts`

## Run it

```bash
pnpm install            # from the monorepo root
pnpm --filter @noy-db/playground-pinia dev
```

Then open <http://localhost:5174>.

## Inspect the encrypted storage

Open DevTools → **Application** → **IndexedDB** → `noydb-pinia-demo`.

You'll see one entry per record in the form `{_iv, _data}` — `_iv` is the random 12-byte AES-GCM nonce and `_data` is the AES-256-GCM ciphertext. **The browser storage layer never sees plaintext.** The DEK that decrypts these records lives only in memory, derived from the passphrase via PBKDF2.

## How the Pinia integration works

```ts
// stores/invoices.ts
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'demo',
})
```

That's it. Behind the scenes:

1. `defineNoydbStore` registers a Pinia store with `id: 'invoices'`.
2. On first access, the store opens the `'demo'` compartment via the globally bound Noydb instance and grabs the `'invoices'` collection.
3. `items` is a `shallowRef<Invoice[]>` that mirrors the decrypted cache.
4. `add()` validates (if a schema is provided), encrypts, persists, then updates the reactive ref.
5. `query()` returns a `Query<Invoice>` builder bound to the same cache, supporting all of `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `contains`, `startsWith`, `between`, plus `.orderBy()`, `.limit()`, `.offset()`, `.first()`, `.count()`, and an escape-hatch `.filter(fn)`.

## Bootstrap

`main.ts` is where Noydb is created and bound:

```ts
const db = await createNoydb({
  adapter: browser({ prefix: 'noydb-pinia-demo' }),
  user: 'demo-owner',
  secret: 'pinia-playground-passphrase-2026',
})

setActiveNoydb(db)
```

In a real app you would prompt for the passphrase at unlock time and never hard-code it. The `@noy-db/nuxt` module (v0.3, in progress) wires this up automatically for Nuxt apps.

## What's NOT in this playground (yet)

- Multi-user keyrings — the demo runs as a single owner
- Sync against a remote adapter — purely local
- The schema-validation path through `@noy-db/pinia` (would require adding `zod` as a dep)
- The `nuxi noydb` extension — that's the Nuxt module's territory, see #9

These will appear in a follow-up Nuxt 4 reference demo (#16).
