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

// ─── Resolution policy + script enforcement ────────────
export { resolvePolicy } from './policy.js'
export type { OnMissing, Layer, OnMissingPolicy } from './policy.js'
export { inferScripts, enforceScript } from './script.js'
export type { ScriptWarning } from './script.js'

// ─── Strategy seam ─────────────────────────────────────
export { withI18n } from './active.js'
export type { I18nStrategy } from './strategy.js'

// ─── i18n errors ───────────────────────────────────────
// Re-exported from the central errors module so subpath consumers can
// `instanceof MissingTranslationError` without falling back to the
// root barrel. Tree-shakers drop the names a consumer doesn't reference.
export {
  ReservedCollectionNameError,
  DictKeyMissingError,
  DictKeyInUseError,
  MissingTranslationError,
  LocaleNotSpecifiedError,
  TranslatorNotConfiguredError,
  ScriptViolationError,
} from '../errors.js'
