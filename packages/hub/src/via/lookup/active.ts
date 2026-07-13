/**
 * Active lookup strategy — `withLookup()` returns the real implementation
 * that constructs `LookupHandle` instances (the `_dict_*` / future
 * `_lookup_*` reserved-collection engine).
 *
 * #650 Task 1 (via-lookup extraction, phase D): this is the new home for
 * the handle-construction logic that used to live inline in
 * `via/i18n/active.ts`'s `withI18n().buildDictionaryHandle`, which
 * now delegates here (same handle, new home — see that file). Splitting
 * the import chain through this file is the same `#553` tree-shake seam
 * `via/i18n/active.ts` already used: the `LookupHandle` engine only
 * ships in a consumer's bundle once something reaches `withLookup()` (today
 * that's transitively via `withI18n()`; later phase-D tasks may call it
 * directly).
 *
 * @public
 */

import type { LookupStrategy, BuildLookupHandleOptions } from '../../port/with/lookup-strategy.js'
import { LookupHandle } from './handle.js'

export function withLookup(): LookupStrategy {
  return {
    buildLookupHandle<Keys extends string = string>(
      opts: BuildLookupHandleOptions<Keys>,
    ): LookupHandle<Keys> {
      return new LookupHandle<Keys>(
        opts.adapter,
        opts.compartmentName,
        opts.dimensionName,
        opts.keyring,
        opts.reservedEnvelopes,
        opts.encrypted,
        opts.ledger,
        opts.options,
        opts.findAndUpdateReferences,
        opts.emitter,
        opts.buildDeleteMarker, // #647 fix wave 1
        opts.onDirty, // #650 Task 4
        opts.onRecordMutated, // #650 Task 4
        opts.checkReferencesOnDelete, // #650 Task 5
      )
    },
  }
}
