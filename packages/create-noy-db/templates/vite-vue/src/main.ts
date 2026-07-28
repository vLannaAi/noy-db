/**
 * {{PROJECT_NAME}} — Vite + Vue 3 + Pinia + noy-db starter.
 *
 * Bootstrap order:
 *   1. Install Pinia (required by `@noy-db/in-pinia`).
 *   2. Open the encrypted vault via `createNoydb` + `toBrowserIdb`.
 *   3. Register the active instance with `setActiveNoydb` so any
 *      `defineNoydbStore` call can find it without manual wiring.
 *   4. Mount the Vue app.
 *
 * The secret prompt is deliberately simple — swap in a proper
 * modal once you've understood the flow.
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createNoydb } from '@noy-db/hub'
import { toBrowserIdb } from '@noy-db/to-browser-idb'
import { setActiveNoydb } from '@noy-db/in-pinia'
import App from './App.vue'
import './style.css'

async function bootstrap(): Promise<void> {
  const pinia = createPinia()

  // 1. Collect the secret. Reload = re-enter.
  const secret =
    prompt(
      'Enter secret for {{PROJECT_NAME}}\n\n' +
        'Derives the master encryption key. Lose it and the data is unrecoverable.',
    ) ?? ''
  if (secret.length === 0) {
    document.body.textContent = 'Cancelled — reload to try again.'
    return
  }

  // 2. Open the encrypted vault backed by IndexedDB. The adapter sees
  //    only ciphertext (open DevTools → Application → IndexedDB to
  //    verify).
  const db = await createNoydb({
    store: toBrowserIdb({ prefix: '{{PROJECT_NAME}}' }),
    user: 'owner',
    secret: secret,
  })
  await db.openVault('demo')

  // 3. Register as the active instance. Pinia stores created via
  //    `defineNoydbStore` will resolve against this handle.
  setActiveNoydb(db)

  // 4. Mount.
  createApp(App).use(pinia).mount('#app')
}

void bootstrap()
