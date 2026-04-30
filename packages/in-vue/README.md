# @noy-db/in-vue

> Vue 3 / Nuxt composables for [noy-db](https://github.com/vLannaAi/noy-db) — reactive `useNoydb`, `useCollection`, `useSync`, and biometric plugin.

[![npm](https://img.shields.io/npm/v/@noy-db/in-vue.svg)](https://www.npmjs.com/package/@noy-db/in-vue)

## Install

```bash
pnpm add @noy-db/hub @noy-db/to-browser-idb @noy-db/in-vue
```

## Setup

```ts
// main.ts
import { createApp } from 'vue'
import { NoydbPlugin } from '@noy-db/in-vue'
import { browserIdbStore } from '@noy-db/to-browser-idb'
import App from './App.vue'

createApp(App)
  .use(NoydbPlugin, {
    adapter: browserIdbStore({ obfuscate: true }),
    userId: 'alice',
  })
  .mount('#app')
```

## Composables

```vue
<script setup lang="ts">
import { useNoydb, useCollection, useSync } from '@noy-db/in-vue'

type Invoice = { id: string; amount: number; customer: string }

const { db, unlock, locked } = useNoydb()
const { items, put, remove } = useCollection<Invoice>('C101', 'invoices')
const { push, pull, status } = useSync()

async function login(passphrase: string) {
  await unlock(passphrase)
}
</script>

<template>
  <button v-if="locked" @click="login('…')">Unlock</button>
  <ul v-else>
    <li v-for="inv in items" :key="inv.id">{{ inv.customer }}: ฿{{ inv.amount }}</li>
  </ul>
</template>
```

## Biometric unlock (WebAuthn)

```ts
import { enrollBiometric, unlockWithBiometric } from '@noy-db/in-vue'

await enrollBiometric('alice', passphrase)
// …later, on another session:
const passphrase = await unlockWithBiometric('alice')
```

## License

MIT © vLannaAi — see the [noy-db repo](https://github.com/vLannaAi/noy-db) for full documentation.
