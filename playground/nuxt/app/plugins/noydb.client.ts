/**
 * NOYDB bootstrap plugin.
 *
 * Client-only by naming convention — the `.client.ts` suffix tells
 * Nuxt 4 to skip this file on the server. That's the same SSR-safety
 * guarantee `@noy-db/in-nuxt`'s internal plugin has, but here in the
 * user's code.
 *
 * The plugin:
 *   1. Constructs a Noydb instance with the IndexedDB store
 *   2. Binds it globally via setActiveNoydb() so every Pinia store
 *      created with defineNoydbStore can find it
 *
 * In a real app, the `secret` would come from a passphrase prompt,
 * biometric unlock, or session token. The demo hard-codes a string so
 * every page loads work without user interaction — documented clearly
 * in the README so nobody copies this into production.
 */

import { createNoydb } from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/tx'
import { browserIdbStore } from '@noy-db/to-browser-idb'
// setActiveNoydb is auto-imported by the @noy-db/in-nuxt module. We reference
// it here via the global identifier without an explicit import.

export default defineNuxtPlugin({
  name: 'noydb:bootstrap',
  enforce: 'pre',
  async setup(_nuxtApp) {
    const store = browserIdbStore({ prefix: 'noydb-nuxt-demo' })
    const secret = 'nuxt-demo-passphrase-2026'

    // First-boot grant: open the demo vault, then re-grant the owner
    // keyring with the import + export capabilities the demo pages
    // need (#249 / #308). Idempotent — `grant` with the same userId
    // updates the existing keyring file.
    const init = await createNoydb({ store, user: 'demo-owner', secret })
    await init.openVault('demo')
    await init.grant('demo', {
      userId: 'demo-owner', displayName: 'Demo Owner', role: 'owner',
      passphrase: secret,
      exportCapability: { plaintext: ['*'], bundle: true },
      importCapability: { plaintext: ['*'], bundle: true },
    })
    init.close()

    // withTransactions opted in so as-* readers' apply() can use the
    // tx envelope (#309). The strategy is gated behind an explicit
    // import to keep bundles small for consumers who never import.
    const db = await createNoydb({
      store, user: 'demo-owner', secret,
      txStrategy: withTransactions(),
    })

    setActiveNoydb(db)
  },
})
