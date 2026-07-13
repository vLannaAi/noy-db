/**
 * Strategy seam for the optional i18n (multi-locale + dictionary)
 * service. `I18nStrategy` + `BuildDictionaryHandleOptions` + `NO_I18N`
 * now live on the kernel port (`port/with/i18n-strategy.ts`, #623
 * Task 7) — re-exported here for compat with existing importers of
 * this module. Real `applyI18nLocale` / `validateI18nTextValue` /
 * `DictionaryHandle` are only reachable via `withI18n()` in
 * `./active.ts`.
 *
 * @internal
 */

export type { I18nStrategy, BuildDictionaryHandleOptions } from '../../port/with/i18n-strategy.js'
export { NO_I18N } from '../../port/with/i18n-strategy.js'
