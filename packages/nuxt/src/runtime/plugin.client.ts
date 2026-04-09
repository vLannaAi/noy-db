/**
 * Client-only runtime plugin for the @noy-db/nuxt module.
 *
 * This file is registered with `mode: 'client'` so Nuxt NEVER imports it
 * into the server bundle. Every line below assumes a browser context.
 *
 * The plugin's job in v0.3:
 *
 *   1. Read the user's noydb config from `useRuntimeConfig().public.noydb`
 *      and stash it on the Nuxt app context for later access via the
 *      auto-imported `useRuntimeConfig()` composable.
 *
 *   2. NOT auto-instantiate Noydb. The library requires a passphrase
 *      callback to derive keys, and that callback can't be serialized
 *      through runtime config. Users call `setActiveNoydb(instance)`
 *      themselves from their app's setup file (the README documents
 *      the recommended pattern).
 *
 * Future work (v0.4):
 *   - Read a user-supplied `bootstrap` callback from a Nuxt provide()
 *     and call it here to construct Noydb automatically when possible
 *   - Wire the devtools tab via @nuxt/devtools-kit
 *   - Surface ledger / sync status on the Nuxt app context
 */

import { defineNuxtPlugin, useRuntimeConfig } from 'nuxt/app'

export default defineNuxtPlugin({
  name: 'noy-db:client',
  enforce: 'pre',
  setup(_nuxtApp) {
    // Read the typed module options the user passed in nuxt.config.ts.
    // The cast is safe because @noy-db/nuxt's module file augments
    // PublicRuntimeConfig with the noydb shape (see module.ts).
    const config = useRuntimeConfig().public.noydb

    // Surface the config on `globalThis` so non-Vue contexts (e.g.,
    // a custom error reporter or a Web Worker) can read it. This is
    // intentionally on `globalThis` rather than the Nuxt provide()
    // map so the v0.3 helper packages stay framework-agnostic.
    if (config) {
      ;(globalThis as { __NOYDB_NUXT_CONFIG__?: unknown }).__NOYDB_NUXT_CONFIG__ = config
    }

    // No return value — the plugin's only side effect is the global
    // assignment above. Future versions will return `provide` keys
    // for first-class composable access.
  },
})
