# @noy-db/in-pinia

> Pinia integration for [noy-db](https://github.com/vLannaAi/noy-db) — drop-in encrypted Pinia stores for Vue 3 / Nuxt 4.

```bash
pnpm add @noy-db/in-pinia @noy-db/hub pinia vue
# pick an adapter for your environment:
pnpm add @noy-db/to-file       # local disk / USB
pnpm add @noy-db/to-browser-idb    # localStorage / IndexedDB
pnpm add @noy-db/to-aws-dynamo     # AWS DynamoDB
```

## Quick start

```ts
// stores/invoices.ts
import { defineNoydbStore } from '@noy-db/in-pinia';

interface Invoice {
  id: string;
  amount: number;
  status: 'draft' | 'open' | 'paid';
  client: string;
}

export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'C101',
});
```

```ts
// main.ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createNoydb } from '@noy-db/hub';
import { jsonFile } from '@noy-db/to-file';
import { setActiveNoydb } from '@noy-db/in-pinia';
import App from './App.vue';

const db = await createNoydb({
  adapter: jsonFile({ dir: './data' }),
  user: 'owner',
  secret: () => prompt('Passphrase')!,
});

setActiveNoydb(db);

createApp(App).use(createPinia()).mount('#app');
```

```vue
<!-- App.vue -->
<script setup lang="ts">
import { useInvoices } from './stores/invoices';

const invoices = useInvoices();
await invoices.$ready;

async function addOne() {
  const id = `inv-${Date.now()}`;
  await invoices.add(id, { id, amount: 100, status: 'draft', client: 'Acme' });
}
</script>

<template>
  <div>
    <button @click="addOne">Add invoice</button>
    <p>{{ invoices.count }} invoices</p>
    <ul>
      <li v-for="inv in invoices.items" :key="inv.id">
        {{ inv.client }} — {{ inv.amount }} — {{ inv.status }}
      </li>
    </ul>
  </div>
</template>
```

## Store API

Every store returned by `defineNoydbStore` exposes:

| Member | Type | Purpose |
|---|---|---|
| `items` | `Ref<T[]>` | Reactive array of all decrypted records |
| `count` | `ComputedRef<number>` | Reactive count |
| `$ready` | `Promise<void>` | Resolves once the collection has hydrated on first use |
| `byId(id)` | `(id) => T \| undefined` | O(N) cache lookup |
| `add(id, record)` | `async (id, T) => void` | Encrypt + persist + update reactive state |
| `update(id, record)` | `async (id, T) => void` | Alias for `add` (NOYDB `put` is upsert) |
| `remove(id)` | `async (id) => void` | Delete + update reactive state |
| `refresh()` | `async () => void` | Re-hydrate from the adapter (use after sync pulls) |
| `query()` | `() => Query<T>` | Chainable query DSL — see `@noy-db/hub` |

## Composition

The store is a real Pinia store. All these work unmodified:

- `storeToRefs(store)` — destructure with reactivity intact
- Vue Devtools — appears in the devtools tab like any other store
- SSR — `items` is empty during server render, hydrates on the client
- `pinia-plugin-persistedstate` — works as a fallback layer below NOYDB encryption

## Schema validation

Pass any object exposing `parse(input): T` (Zod, Valibot, ArkType, Effect Schema, etc.):

```ts
import { z } from 'zod';

const InvoiceSchema = z.object({
  id: z.string(),
  amount: z.number().positive(),
  status: z.enum(['draft', 'open', 'paid']),
  client: z.string(),
});

export const useInvoices = defineNoydbStore<z.infer<typeof InvoiceSchema>>('invoices', {
  compartment: 'C101',
  schema: InvoiceSchema,
});
```

`add()` and `update()` will throw if the record fails validation, before any encryption or write happens.

## Query DSL

The store's `query()` method returns the same chainable builder as `Collection.query()`:

```ts
const overdue = invoices.query()
  .where('status', '==', 'open')
  .where('dueDate', '<', new Date())
  .orderBy('dueDate', 'asc')
  .limit(50)
  .toArray();
```

See [`@noy-db/hub` query DSL docs](../core/README.md#query-dsl) for the full operator list.

## Status

See [ROADMAP.md](../../ROADMAP.md) for the forward plan.

## License

MIT © vLannaAi
