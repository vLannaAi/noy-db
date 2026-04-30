/**
 * Active i18n strategy — `withI18n()` returns the real implementation
 * that wires multi-locale resolution, i18nText validation, and the
 * `DictionaryHandle` for `dictKey` fields into the core read/write
 * paths.
 *
 * Consumers opt in by:
 *
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withI18n } from '@noy-db/hub/i18n'
 *
 * const db = await createNoydb({
 *   store: ...,
 *   user: ...,
 *   i18nStrategy: withI18n(),
 * })
 * ```
 *
 * The factory delegates to the existing `core.ts` and `dictionary.ts`
 * modules. Splitting the import chain through this file is what lets
 * tsup tree-shake the `~854 LOC` of dictionary + locale resolution
 * out of the default bundle when no `withI18n()` import is present.
 *
 * @public
 */

import type { I18nStrategy, BuildDictionaryHandleOptions } from './strategy.js'
import { applyI18nLocale, validateI18nTextValue } from './core.js'
import { DictionaryHandle } from './dictionary.js'

export function withI18n(): I18nStrategy {
  return {
    applyI18nLocale,
    validateI18nTextValue,
    buildDictionaryHandle<Keys extends string = string>(
      opts: BuildDictionaryHandleOptions<Keys>,
    ): DictionaryHandle<Keys> {
      return new DictionaryHandle<Keys>(
        opts.adapter,
        opts.compartmentName,
        opts.dictionaryName,
        opts.keyring,
        opts.getDEK,
        opts.encrypted,
        opts.ledger,
        opts.options,
        opts.findAndUpdateReferences,
        opts.emitter,
      )
    },
  }
}
