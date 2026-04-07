# @noy-db/pinia

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
