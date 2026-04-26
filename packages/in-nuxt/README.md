# @noy-db/in-nuxt

> Nuxt 4 module for [noy-db](https://github.com/vLannaAi/noy-db) — auto-imports, SSR-safe runtime plugin, and the `@noy-db/in-pinia` bridge.

**Nuxt 4+ exclusive.** For Nuxt 3, use `@noy-db/in-vue` and `@noy-db/in-pinia` directly with a hand-written plugin.

```bash
pnpm add @noy-db/in-nuxt @noy-db/hub @noy-db/in-pinia @noy-db/in-vue
# pick an adapter for your environment:
pnpm add @noy-db/to-browser-idb    # localStorage / IndexedDB
pnpm add @noy-db/to-file       # local disk / USB (Node only)
pnpm add @noy-db/to-aws-dynamo     # AWS DynamoDB
```

## Quick start

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@noy-db/in-nuxt'],

  noydb: {
    adapter: 'browser',
    pinia: true,
    sync: { adapter: 'dynamo', table: 'noydb-prod', region: 'ap-southeast-1' },
    auth: { mode: 'biometric', sessionTimeout: '15m' },
  },
})
```

After installing the module, every component in your app gets these auto-imported:

| From `@noy-db/in-vue`         | From `@noy-db/in-pinia` (when `pinia: true`, default) |
|-----------------------------|----------------------------------------------------|
| `useNoydb()`                | `defineNoydbStore()`                               |
| `useCollection<T>()`        | `createNoydbPiniaPlugin()`                         |
| `useSync()`                 | `setActiveNoydb()`                                  |
|                             | `getActiveNoydb()`                                  |

## Bootstrap

The module exposes your typed config through `useRuntimeConfig().public.noydb` but it does **not** auto-instantiate the Noydb instance. You decide when and how to construct it — typically in a custom Nuxt plugin or your first protected page:

```ts
// plugins/noydb.client.ts
import { createNoydb } from '@noy-db/hub'
import { browserIdbStore } from '@noy-db/to-browser-idb'
import { setActiveNoydb } from '@noy-db/in-pinia'

export default defineNuxtPlugin(async () => {
  const config = useRuntimeConfig().public.noydb

  const db = await createNoydb({
    adapter: browser({ prefix: 'my-app' }),
    user: 'owner',
    secret: () => promptUserForPassphrase(),
  })

  setActiveNoydb(db)
})
```

The reason it's not automatic: `createNoydb` requires a passphrase callback that can't be serialized through Nuxt's runtime config. Eager auto-instantiation is a future enhancement, gated on a real consumer signing off on the bootstrap UX.

## Use it in a component

Once `setActiveNoydb` has been called, every Pinia store can transparently use NOYDB:

```ts
// stores/invoices.ts
export const useInvoices = defineNoydbStore<Invoice>('invoices', {
  compartment: 'C101',
})
```

```vue
<!-- pages/invoices.vue -->
<script setup lang="ts">
const invoices = useInvoices()
await invoices.$ready

const open = computed(() =>
  invoices.query()
    .where('status', '==', 'open')
    .orderBy('dueDate')
    .toArray()
)
</script>

<template>
  <ul>
    <li v-for="inv in open" :key="inv.id">
      {{ inv.client }} — {{ inv.amount }}
    </li>
  </ul>
</template>
```

`defineNoydbStore`, `useInvoices`, `computed`, etc. are all auto-imported — no `import` lines needed.

## SSR safety

The module's runtime plugin is registered with `mode: 'client'`. Nuxt **never** loads it on the server, so your server bundle never imports any code that touches `crypto.subtle`. During SSR:

- `useCollection()` returns an empty reactive ref (templates render skeleton state)
- `defineNoydbStore` stores hydrate to their initial state
- No keys, no decryption, no crypto API calls reach the server

A planned CI bundle assertion will verify this property automatically by grepping the built nitro output for forbidden symbols.

## Module options

| Option       | Type                                                | Default       | Description |
|--------------|-----------------------------------------------------|---------------|-------------|
| `adapter`    | `'browser' \| 'memory' \| 'file' \| 'dynamo' \| 's3'` | —             | Hint for which built-in adapter to use. Just metadata — your bootstrap code constructs the actual adapter. |
| `pinia`      | `boolean`                                           | `true`        | Auto-import the `@noy-db/in-pinia` helpers. Set to `false` if you don't use Pinia. |
| `sync`       | `{ adapter, table, region, bucket, mode }`          | —             | Optional sync configuration metadata, exposed via `runtimeConfig.public.noydb.sync`. |
| `auth`       | `{ mode, sessionTimeout }`                          | —             | Optional auth metadata. The actual passphrase callback lives in your bootstrap code. |
| `devtools`   | `boolean`                                           | `true`        | Enable the (planned) devtools tab. Currently a passthrough — the tab itself is a future enhancement. |

Every field is fully typed. Open `nuxt.config.ts` in your IDE and you'll get autocomplete on `noydb:`.

## What's NOT yet included

The following features are tracked as future follow-ups:

- **Devtools tab via `@nuxt/devtools-kit`** — compartment tree, sync status, ledger tail, query playground
- **Optional Nitro server proxy** at `/api/_noydb/[...]` for behind-the-scenes auth gating
- **Optional Nitro scheduled backup task** for encrypted off-site backups
- **`nuxi noydb <cmd>` CLI extension**
- **Eager Noydb instantiation** — once a real consumer signs off on the bootstrap UX

The module ships the foundation: typed options, auto-imports, and the SSR-safe client plugin. That's the load-bearing infrastructure; everything above can be added incrementally without breaking existing apps.

## Status

See [ROADMAP.md](../../ROADMAP.md) for the forward plan.

## License

MIT © vLannaAi
