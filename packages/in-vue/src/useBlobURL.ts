/**
 * `useBlobURL` — Vue composable that decrypts an encrypted blob slot
 * and surfaces a browser ObjectURL ready to feed into `<img src>`,
 * `<a href>`, etc. Auto-revokes the prior URL when the reactive id
 * changes and on scope dispose, so long-lived pages (attachment
 * viewers, image grids) cannot leak ObjectURLs.
 *
 * SSR-safe: when `URL.createObjectURL` is unavailable (Node without
 * DOM, restricted workers), the ref stays at `null` instead of
 * throwing.
 *
 * @module
 */

import {
  ref,
  watch,
  getCurrentScope,
  onScopeDispose,
  type Ref,
} from 'vue'
import type { Collection } from '@noy-db/hub'

/** Options accepted by {@link useBlobURL}. */
export interface UseBlobURLOptions {
  /**
   * Slot name within the record's blob set. Defaults to `'default'`.
   * Pass an explicit name when records carry multiple attachments.
   */
  readonly slot?: string
  /**
   * MIME type override. Either a static string or a function called
   * each time a fresh URL is built. When omitted, the slot's stored
   * `mimeType` (set at upload time) is used.
   */
  readonly mimeType?: string | (() => string | undefined)
}

/**
 * Build a reactive ObjectURL for a blob slot on a record. The URL is
 * recomputed whenever the id getter's return value changes; the prior
 * URL is revoked **before** the new one is created, so consumers
 * never see two live URLs for the same composable instance.
 *
 * @example
 * ```ts
 * const recordId = ref('inv-001')
 * const url = useBlobURL(invoiceCollection, () => recordId.value, {
 *   slot: 'pdf',
 *   mimeType: 'application/pdf',
 * })
 * ```
 *
 * @param collection - Hub collection that owns the record.
 * @param idGetter   - Function returning the current record id (or
 *                     `null` / `undefined` to clear the URL).
 * @param options    - Optional slot name and mimeType override.
 * @returns A `Ref<string | null>` — `null` while loading, after a
 *          stop, or when no slot is found.
 */
export function useBlobURL<T>(
  collection: Collection<T>,
  idGetter: () => string | null | undefined,
  options: UseBlobURLOptions = {},
): Ref<string | null> {
  const url = ref<string | null>(null)
  const slot = options.slot ?? 'default'

  // SSR / non-DOM hosts: bail out, leave url at null. The hub layer
  // would throw here, but the composable's contract is "stay quiet so
  // server-rendered output is empty."
  const browserAware =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'

  let revokeCurrent: (() => void) | null = null
  let stopped = false
  let loadToken = 0

  const revoke = (): void => {
    if (revokeCurrent) {
      revokeCurrent()
      revokeCurrent = null
    }
  }

  async function load(id: string | null | undefined): Promise<void> {
    // Revoke FIRST — the spec is explicit that the prior URL is
    // released before the next one is created, even if the next
    // create fails or the id resolves to null.
    revoke()
    url.value = null
    if (!browserAware || stopped || !id) return

    // Token-guard against stale resolutions: if the id changes again
    // before this call's awaits settle, the older promise's result
    // must be discarded so we don't strand an URL that no upstream
    // ref points at.
    const myToken = ++loadToken
    const mimeType =
      typeof options.mimeType === 'function'
        ? options.mimeType()
        : options.mimeType
    const built = await collection
      .blob(id)
      .objectURL(slot, mimeType !== undefined ? { mimeType } : {})
    if (myToken !== loadToken || stopped) {
      // A newer load won the race or the scope was disposed mid-flight.
      // Drop this URL on the floor.
      built?.revoke()
      return
    }
    if (!built) return
    revokeCurrent = built.revoke
    url.value = built.url
  }

  // watch with `immediate: true` covers the initial load — no separate
  // `load(idGetter())` call needed, and watch automatically tracks
  // reactive deps inside the getter.
  watch(idGetter, (next) => {
    void load(next)
  }, { immediate: true })

  if (getCurrentScope()) {
    onScopeDispose(() => {
      stopped = true
      revoke()
      url.value = null
    })
  }

  return url
}
