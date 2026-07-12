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
import { enforceScript } from './script.js'
import { computeExemptFills, densify } from './densify.js'
import type { DictionaryHandle } from './dictionary.js'
import { withLookup } from '../via-lookup/active.js'

export function withI18n(): I18nStrategy {
  // #650 Task 1: the handle-construction logic moved to
  // shape/via-lookup/active.ts (LookupHandle, renamed from
  // DictionaryHandle, new home). buildDictionaryHandle below is now a
  // thin field-name translator over buildLookupHandle — same handle.
  const lookup = withLookup()
  return {
    applyI18nLocale,
    validateI18nTextValue,
    enforceScript,
    computeExemptFills,
    densify,
    buildDictionaryHandle<Keys extends string = string>(
      opts: BuildDictionaryHandleOptions<Keys>,
    ): DictionaryHandle<Keys> {
      return lookup.buildLookupHandle<Keys>({
        adapter: opts.adapter,
        compartmentName: opts.compartmentName,
        dimensionName: opts.dictionaryName,
        keyring: opts.keyring,
        reservedEnvelopes: opts.reservedEnvelopes,
        encrypted: opts.encrypted,
        ledger: opts.ledger,
        options: opts.options,
        findAndUpdateReferences: opts.findAndUpdateReferences,
        emitter: opts.emitter,
        buildDeleteMarker: opts.buildDeleteMarker, // #647 fix wave 1
        onDirty: opts.onDirty, // #650 Task 4
        onRecordMutated: opts.onRecordMutated, // #650 Task 4
      })
    },
  }
}
