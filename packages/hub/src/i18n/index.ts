/**
 * `@noy-db/hub/i18n` — subpath export for the multi-locale primitives.
 *
 * Apps that only speak English never have to import from this subpath
 * — the main `@noy-db/hub` entry still re-exports these symbols for
 * backward compatibility through.x. Consumers that opt into the
 * subpath import get a smaller bundle (~2 KB estimated savings).
 *
 * Re-exports:
 *   - `dictKey`, `DictionaryHandle`, dictionary collection helpers
 *   - `i18nText`, `resolveI18nText`, `applyI18nLocale`, validators
 */

export * from './core.js'
export * from './dictionary.js'

// ─── Strategy seam ─────────────────────────────────────
export { withI18n } from './active.js'
export type { I18nStrategy } from './strategy.js'
