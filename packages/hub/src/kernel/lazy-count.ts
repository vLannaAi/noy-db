/**
 * Lazy-mode `count()` support (#706): count ids whose envelope is LIVE at
 * tier 0 — parity with eager count (the hydrated cache excludes tombstones,
 * delete markers, and elevated records, #701). Envelope inspection only —
 * no record body is ever decrypted here.
 */
import type { NoydbStore } from './types.js'
import { isTombstone, isDeleteMarker } from './enclave/index.js'

export async function countLiveEnvelopes(
  adapter: NoydbStore, vault: string, name: string, storeCiphertext: boolean,
): Promise<number> {
  const ids = await adapter.list(vault, name)
  let n = 0
  for (const id of ids) {
    const env = await adapter.get(vault, name, id)
    if (env && !isTombstone(env, storeCiphertext) && !isDeleteMarker(env) && (env._tier ?? 0) === 0) n++
  }
  return n
}
