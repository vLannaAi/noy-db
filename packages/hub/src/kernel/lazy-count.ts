/**
 * Lazy-mode `count()` support (#706): count ids whose envelope is LIVE at
 * tier 0 — parity with eager count (the hydrated cache excludes tombstones,
 * delete markers, and elevated records, #701). Envelope inspection only —
 * no record body is ever decrypted here.
 *
 * #713: when the adapter implements the optional `listPage`, page through
 * it and apply the same predicate to each page's envelopes — one
 * round-trip per page instead of one `list()` + one `get()` per id. Stores
 * without `listPage` keep the original N+1 loop.
 */
import type { EncryptedEnvelope, NoydbStore } from './types.js'
import { isTombstone, isDeleteMarker } from './enclave/index.js'

/** Page size for the listPage batching path (#713). */
const COUNT_PAGE_SIZE = 1000

function isLive(env: EncryptedEnvelope | null, storeCiphertext: boolean): boolean {
  return !!env && !isTombstone(env, storeCiphertext) && !isDeleteMarker(env) && (env._tier ?? 0) === 0
}

export async function countLiveEnvelopes(
  adapter: NoydbStore, vault: string, name: string, storeCiphertext: boolean,
): Promise<number> {
  let n = 0
  if (adapter.listPage) {
    let cursor: string | undefined
    let page = await adapter.listPage(vault, name, cursor, COUNT_PAGE_SIZE)
    while (true) {
      for (const { envelope } of page.items) {
        if (isLive(envelope, storeCiphertext)) n++
      }
      if (page.nextCursor === null) break
      cursor = page.nextCursor
      page = await adapter.listPage(vault, name, cursor, COUNT_PAGE_SIZE)
    }
    return n
  }
  const ids = await adapter.list(vault, name)
  for (const id of ids) {
    const env = await adapter.get(vault, name, id)
    if (isLive(env, storeCiphertext)) n++
  }
  return n
}
