# @noy-db/pinia

## 0.4.1

### Patch Changes

- **Peer dep fix**: changed `peerDependencies` spec from `workspace:*` to `workspace:^` so published packages accept any semver-compatible `@noy-db/*` version rather than pinning to the exact version the workspace was built against. Without this fix, installing `@noy-db/core@0.4.0` alongside `@noy-db/memory@0.3.0` produced an `ERESOLVE` error because memory's peer dep was published as the literal `"0.3.0"` string.

- **Version line unified**: every `@noy-db/*` package is now on the **0.4.1** line. Previously the line was mixed (core/pinia on 0.4.0, adapters on 0.3.0, vue on 0.2.0, create on 0.3.2). No functional code changes — this is a manifest-only release to make v0.4 actually installable.

## 0.4.0

### Minor Changes

- **Schema validation propagated to `defineNoydbStore`** (#42). The `schema` option now accepts any [Standard Schema v1](https://standardschema.dev) validator (Zod, Valibot, ArkType, Effect Schema) and threads it down to the underlying `Collection`. Validation runs before encryption on every `add()`/`update()` and after decryption on every read — duplicate `.parse()` calls in the store layer were removed because the Collection handles it.

  ```ts
  import { z } from 'zod'

  const InvoiceSchema = z.object({ /* ... */ })

  export const useInvoices = defineNoydbStore<z.infer<typeof InvoiceSchema>>('invoices', {
    compartment: 'demo-co',
    schema: InvoiceSchema,
  })
  ```

  **Breaking change**: the `schema` option now expects a Standard Schema v1 validator instead of a hand-rolled `{ parse }` shim. Zod schemas already implement the protocol; consumers using a custom `{ parse }` object need to wrap it in the v1 protocol shape. See `packages/pinia/__tests__/defineNoydbStore.test.ts` for an inline example.

- Bumps `@noy-db/core` peer to `^0.4.0` for the new `StandardSchemaV1` types and the schema option on `Collection`.

## 0.3.0

### Minor Changes

- **Initial release of `@noy-db/pinia`** — Pinia integration for noy-db. Two adoption paths:

  **Greenfield — `defineNoydbStore`** (closes #10). A drop-in alternative to `defineStore` that wires a Pinia store to a NOYDB compartment + collection. The store exposes `items`, `count`, `byId`, `add`, `update`, `remove`, `refresh`, `query`, `$ready`, plus a `$noydb` escape hatch. Fully compatible with `storeToRefs`, Vue Devtools, SSR, and `pinia-plugin-persistedstate`.

  ```ts
  export const useInvoices = defineNoydbStore<Invoice>('invoices', {
    compartment: 'demo-co',
  })
  ```

  **Augmentation — `createNoydbPiniaPlugin`** (closes #11). A Pinia plugin that lets existing `defineStore` calls opt into NOYDB persistence by adding a single `noydb:` option. No component code changes required. Lazy `Noydb` instantiation, compartment cache, `$noydbFlush` API for explicit flush.

  ```ts
  pinia.use(createNoydbPiniaPlugin({ adapter: browser(), user, secret }))

  export const useClients = defineStore('clients', {
    state: () => ({ list: [] as Client[] }),
    noydb: { compartment: 'demo-co', collection: 'clients', persist: 'list' },
    actions: { add(c: Client) { this.list.push(c) } },
  })
  ```

  Reference Vue + Pinia playground at `playground/pinia/`.
