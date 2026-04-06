/**
 * Active NOYDB instance binding.
 *
 * `defineNoydbStore` resolves the `Noydb` instance from one of three places,
 * in priority order:
 *
 *   1. The store options' explicit `noydb:` field (highest precedence — useful
 *      for tests and multi-database apps).
 *   2. A globally bound instance set via `setActiveNoydb()` — this is what the
 *      Nuxt module's runtime plugin and playground apps use.
 *   3. Throws a clear error if neither is set.
 *
 * Keeping the binding pluggable means tests can pass an instance directly
 * without polluting global state.
 */

import type { Noydb } from '@noy-db/core'

let activeInstance: Noydb | null = null

/** Bind a Noydb instance globally. Called by the Nuxt module / app plugin. */
export function setActiveNoydb(instance: Noydb | null): void {
  activeInstance = instance
}

/** Returns the globally bound Noydb instance, or null if none. */
export function getActiveNoydb(): Noydb | null {
  return activeInstance
}

/**
 * Resolve the Noydb instance to use for a store. Throws if no instance is
 * bound — the error message points the developer at the three options.
 */
export function resolveNoydb(explicit?: Noydb | null): Noydb {
  if (explicit) return explicit
  if (activeInstance) return activeInstance
  throw new Error(
    '@noy-db/pinia: no Noydb instance bound.\n' +
    '  Option A — pass `noydb:` directly to defineNoydbStore({...})\n' +
    '  Option B — call setActiveNoydb(instance) once at app startup\n' +
    '  Option C — install the @noy-db/nuxt module (Nuxt 4+)',
  )
}
