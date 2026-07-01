/**
 * Schema-cutover client registry. Each client keeps a
 * heartbeat doc at `_meta/schema-fence:client:<clientId>` carrying its
 * liveness (`lastSeen`) and the fence generation it has quiesced for
 * (`quiescedAtVersion`). Plaintext envelope, like the fence doc.
 */
import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'

const META_COLLECTION = '_meta'
const CLIENT_PREFIX = 'schema-fence:client:'

export interface ClientDoc {
  readonly clientId: string
  readonly lastSeen: number
  readonly quiescedAtVersion: number | null
  /**
   * Session that owns this writer (one user's writers across vaults). Additive
   * and optional so pre-#469 client docs keep parsing; readers default it.
   */
  readonly sessionId?: string
}

export async function writeClientDoc(
  store: NoydbStore,
  vault: string,
  clientId: string,
  doc: { lastSeen: number; quiescedAtVersion: number | null; sessionId?: string },
): Promise<void> {
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify({ clientId, ...doc }),
  }
  await store.put(vault, META_COLLECTION, `${CLIENT_PREFIX}${clientId}`, envelope)
}

export async function listClientDocs(store: NoydbStore, vault: string): Promise<ClientDoc[]> {
  const ids = await store.list(vault, META_COLLECTION)
  const out: ClientDoc[] = []
  for (const id of ids) {
    if (!id.startsWith(CLIENT_PREFIX)) continue
    const env = await store.get(vault, META_COLLECTION, id)
    if (!env) continue
    try {
      const parsed = JSON.parse(env._data) as unknown
      if (isClientDoc(parsed)) out.push(parsed)
    } catch { /* skip corrupt */ }
  }
  return out
}

/**
 * True when every *active* client (lastSeen within staleMs of now) has
 * `quiescedAtVersion === generation`. Stale clients are ignored. An empty
 * active set is vacuously quiesced.
 */
export async function activeQuiesced(
  store: NoydbStore,
  vault: string,
  opts: { generation: number; now: number; staleMs: number; excludeClientId?: string },
): Promise<boolean> {
  const docs = await listClientDocs(store, vault)
  const active = docs.filter(
    d => d.lastSeen >= opts.now - opts.staleMs && d.clientId !== opts.excludeClientId,
  )
  return active.every(d => d.quiescedAtVersion === opts.generation)
}

function isClientDoc(x: unknown): x is ClientDoc {
  if (x === null || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o['clientId'] === 'string'
    && typeof o['lastSeen'] === 'number'
    && (o['quiescedAtVersion'] === null || typeof o['quiescedAtVersion'] === 'number')
    && (o['sessionId'] === undefined || typeof o['sessionId'] === 'string')
}
