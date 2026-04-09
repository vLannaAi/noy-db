/**
 * NOYDB bootstrap plugin.
 *
 * Client-only by naming convention — the `.client.ts` suffix tells
 * Nuxt 4 to skip this file on the server. That's the same SSR-safety
 * guarantee `@noy-db/nuxt`'s internal plugin has, but here in the
 * user's code.
 *
 * The plugin:
 *   1. Constructs a Noydb instance with the browser adapter
 *   2. Binds it globally via setActiveNoydb() so every Pinia store
 *      created with defineNoydbStore can find it
 *
 * In a real app, the `secret` would come from a passphrase prompt,
 * biometric unlock, or session token. The demo hard-codes a string so
 * every page loads work without user interaction — documented clearly
 * in the README so nobody copies this into production.
 */

import { createNoydb } from '@noy-db/core'
import { browser } from '@noy-db/browser'
// setActiveNoydb is auto-imported by the @noy-db/nuxt module. We reference
// it here via the global identifier without an explicit import.

export default defineNuxtPlugin({
  name: 'noydb:bootstrap',
  enforce: 'pre',
  async setup(_nuxtApp) {
    const db = await createNoydb({
      adapter: browser({ prefix: 'noydb-nuxt-demo' }),
      user: 'demo-owner',
      // Demo-only passphrase — production apps MUST prompt the user.
      secret: 'nuxt-demo-passphrase-2026',
    })

    setActiveNoydb(db)
  },
})
