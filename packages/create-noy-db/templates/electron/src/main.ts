/**
 * {{PROJECT_NAME}} — renderer bootstrap.
 *
 * Opens a Noydb vault backed by `@noy-db/to-file`, writing JSON to
 * a directory under the user's data folder. Perfect for the
 * USB-stick workflow: point the `dir` at an external mount and
 * the vault travels with you.
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createNoydb } from '@noy-db/hub'
import { jsonFile } from '@noy-db/to-file'
import { setActiveNoydb } from '@noy-db/in-pinia'
import path from 'node:path'
import App from './App.vue'
import './style.css'

async function bootstrap(): Promise<void> {
  const pinia = createPinia()

  // Default directory: `<userData>/{{PROJECT_NAME}}/vault`. For a
  // USB-stick workflow, prompt the user for a path and use that
  // instead (e.g. `/Volumes/USB/myapp`).
  const baseDir = process.env.VITE_DEV_SERVER_URL
    ? path.resolve('./.{{PROJECT_NAME}}-dev-vault')
    : path.resolve(process.resourcesPath ?? '.', '{{PROJECT_NAME}}-vault')

  const passphrase = prompt(
    'Enter passphrase for {{PROJECT_NAME}}\n\n' +
      'Master encryption key — lose it and the data is unrecoverable.',
  ) ?? ''
  if (passphrase.length === 0) {
    document.body.textContent = 'Cancelled — reload to try again.'
    return
  }

  const db = await createNoydb({
    store: jsonFile({ dir: baseDir }),
    user: 'owner',
    secret: passphrase,
  })
  await db.openVault('demo')
  setActiveNoydb(db)
  createApp(App).use(pinia).mount('#app')
}

void bootstrap()
