/**
 * @noy-db/nuxt — Nuxt 4 module for noy-db.
 *
 * Public API:
 *   - default export: the Nuxt module factory
 *   - `ModuleOptions` type: shape of the `noydb:` key in `nuxt.config.ts`
 *
 * The module auto-imports the @noy-db/vue and (optionally) @noy-db/pinia
 * composables, exposes the user's options through Nuxt's runtime config,
 * and registers a CLIENT-ONLY runtime plugin so the SSR bundle never
 * touches `crypto.subtle`. Eager Noydb instantiation is intentionally
 * left to user code — see the README "Bootstrap" section.
 */

import noydbModule, { type ModuleOptions } from './module.js'

export default noydbModule
export type { ModuleOptions }
