import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'

/**
 * Existence authority (spec § Convergence & existence authority, rule 1): the
 * base row is the sole authority on record existence. `null` (absent) and the
 * tombstone shape (`_iv === '' && _data === ''`, per `buildTombstone()`) both
 * read as "not live" — undecrypted, envelope-level checks only.
 */
export function isEnvelopeLive(env: EncryptedEnvelope | null): boolean {
  return env !== null && !(env._iv === '' && env._data === '')
}

/** One undecrypted adapter `get` on the base — the store-shape the spec pins (zero extra crypto). */
export async function isBaseLive(adapter: NoydbStore, vault: string, base: string, id: string): Promise<boolean> {
  return isEnvelopeLive(await adapter.get(vault, base, id))
}

/** The set of base ids that are currently live — used to id-filter satellite `list()` results. */
export async function liveBaseIdSet(adapter: NoydbStore, vault: string, base: string): Promise<Set<string>> {
  const ids = await adapter.list(vault, base)
  const out = new Set<string>()
  for (const id of ids) if (await isBaseLive(adapter, vault, base, id)) out.add(id)
  return out
}
