/**
 * Nuxt 4 module for noy-db.
 *
 * Built with `@nuxt/kit`'s `defineNuxtModule`. Targets Nuxt 4+ exclusively
 * (no Nuxt 3 compatibility shim — Nuxt 3 users should consume `@noy-db/vue`
 * and `@noy-db/pinia` directly with a hand-written plugin).
 *
 * Module responsibilities (v0.3 scope):
 *
 *   1. Auto-import the @noy-db/vue composables (`useNoydb`, `useCollection`,
 *      `useSync`) and, when `pinia: true` (default), the @noy-db/pinia
 *      helpers (`defineNoydbStore`, `createNoydbPiniaPlugin`, `setActiveNoydb`).
 *
 *   2. Expose the user's `noydb:` config through `runtimeConfig.public.noydb`
 *      so the runtime plugin and downstream composables can read it
 *      without re-parsing nuxt.config.ts.
 *
 *   3. Register a CLIENT-ONLY runtime plugin (`runtime/plugin.client.ts`)
 *      that sets up the noydb context. The server bundle is never touched —
 *      this is the load-bearing SSR-safety property.
 *
 * Out-of-scope for v0.3 (deferred to follow-up issues):
 *   - Devtools tab via @nuxt/devtools-kit
 *   - Optional Nitro server proxy (`/api/_noydb/...`)
 *   - Optional Nitro scheduled backup task
 *   - `nuxi noydb` CLI extension (#9, separate package work)
 *   - Eager Noydb instantiation (requires the user's passphrase callback,
 *     which can't be serialized through runtime config — better to let
 *     users call setActiveNoydb from their own setup file)
 */

import { defineNuxtModule, addImports, addPlugin, createResolver } from '@nuxt/kit'

/**
 * Configuration shape for the `noydb:` key in `nuxt.config.ts`.
 *
 * Every field is optional. The defaults give a reasonable bootstrap for
 * a typical Vue/Nuxt app — Pinia helpers auto-imported, browser adapter
 * preferred. Users override by passing the relevant fields.
 */
export interface ModuleOptions {
  /**
   * Which built-in adapter to prefer. The runtime plugin reads this and
   * picks a matching adapter package. Defaults to `'browser'` because
   * Nuxt apps run in the browser at runtime.
   *
   * Note: this is just a HINT. Users can always construct their own
   * adapter and pass it to `createNoydb()` directly — this option exists
   * to keep simple cases simple.
   */
  adapter?: 'browser' | 'memory' | 'file' | 'dynamo' | 's3'

  /**
   * Auto-import the @noy-db/pinia helpers (`defineNoydbStore`,
   * `createNoydbPiniaPlugin`, `setActiveNoydb`). Defaults to `true`
   * because Pinia is the recommended state layer for v0.3.
   *
   * Set to `false` if you only want the bare @noy-db/vue composables
   * (saves ~3 KB from the auto-import metadata).
   */
  pinia?: boolean

  /**
   * Optional sync configuration. Currently a passthrough — the runtime
   * plugin reads it from `runtimeConfig.public.noydb.sync` and the user
   * is responsible for wiring it into their `createNoydb()` call.
   */
  sync?: {
    adapter?: 'dynamo' | 's3'
    table?: string
    region?: string
    bucket?: string
    mode?: 'auto' | 'manual' | 'off'
  }

  /**
   * Optional auth configuration metadata. Same passthrough pattern as
   * `sync`. The user provides the actual passphrase / biometric callback
   * in their own setup file.
   */
  auth?: {
    mode?: 'passphrase' | 'biometric' | 'session'
    sessionTimeout?: string
  }

  /**
   * Whether to enable the (planned) devtools tab in `nuxi dev`. Currently
   * a passthrough — the devtools tab itself ships in a v0.4 follow-up.
   */
  devtools?: boolean
}

/**
 * The exported Nuxt module factory.
 *
 * Test-friendly: `defineNuxtModule` returns a NuxtModule object whose
 * `.meta`, `.getOptions`, and `.setup` fields can be inspected without a
 * full Nuxt build. Unit tests use those introspection points instead of
 * spinning up `@nuxt/test-utils`.
 */
export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@noy-db/nuxt',
    configKey: 'noydb',
    compatibility: {
      // Nuxt 4 only — see the module-level docstring for the rationale.
      nuxt: '^4.0.0',
    },
  },

  defaults: {
    pinia: true,
    devtools: true,
  },

  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)

    // ─── 1. Expose the user's options to runtime via runtimeConfig ───
    //
    // We stash the typed options under `runtimeConfig.public.noydb` so
    // the client plugin (and any downstream composable) can read them
    // without re-parsing nuxt.config.ts. `public` is required so the
    // values reach the browser bundle — but EVERY field is metadata
    // (adapter name, table name, etc.), NEVER a secret. Passphrases
    // and tokens are still provided at runtime via user callbacks.
    nuxt.options.runtimeConfig.public.noydb = {
      // The cast is necessary because Nuxt's runtimeConfig type is
      // structurally `Record<string, any>` — modules are expected to
      // own their own typing via module augmentation (which we do
      // below).
      ...(nuxt.options.runtimeConfig.public.noydb ?? {}),
      ...options,
    }

    // ─── 2. Auto-imports for @noy-db/vue composables ────────────────
    //
    // These are the v0.2 composables shipped by @noy-db/vue. Importing
    // them automatically removes one line of boilerplate per component.
    addImports([
      { name: 'useNoydb', from: '@noy-db/vue' },
      { name: 'useCollection', from: '@noy-db/vue' },
      { name: 'useSync', from: '@noy-db/vue' },
    ])

    // ─── 3. Auto-imports for @noy-db/pinia (opt-out) ────────────────
    //
    // Most users want the Pinia helpers — `defineNoydbStore` is the
    // headline v0.3 API. We default to enabling them and let users
    // opt out via `pinia: false` if they're not using Pinia at all.
    if (options.pinia !== false) {
      addImports([
        { name: 'defineNoydbStore', from: '@noy-db/pinia' },
        { name: 'createNoydbPiniaPlugin', from: '@noy-db/pinia' },
        { name: 'setActiveNoydb', from: '@noy-db/pinia' },
        { name: 'getActiveNoydb', from: '@noy-db/pinia' },
      ])
    }

    // ─── 4. Register the client-only runtime plugin ─────────────────
    //
    // mode: 'client' is the LOAD-BEARING SSR-safety guarantee. Nuxt
    // skips this plugin entirely on the server, so the server bundle
    // never imports any code that touches `crypto.subtle`. The CI
    // bundle assertion (planned for a follow-up) verifies this by
    // grepping the built nitro output for forbidden symbols.
    //
    // The path resolves to the COMPILED runtime file in `dist/runtime/`.
    // tsup builds this as a separate entry alongside the module index.
    addPlugin({
      src: resolver.resolve('./runtime/plugin.client.js'),
      mode: 'client',
    })
  },
})

/**
 * Module augmentation so the `noydb:` config key in `nuxt.config.ts`
 * is fully typed and autocompleted in the IDE.
 *
 * The augmentation is a side-effect of importing the module — once a
 * project adds `'@noy-db/nuxt'` to its `modules` array, TypeScript picks
 * up the typed `noydb` option without requiring an explicit import.
 */
declare module '@nuxt/schema' {
  interface NuxtConfig {
    noydb?: ModuleOptions
  }
  interface NuxtOptions {
    noydb?: ModuleOptions
  }
  interface PublicRuntimeConfig {
    noydb?: ModuleOptions
  }
}
