/**
 * Single-point audited reveal, stage-2 rework (I6): decrypt ONE sealed slot
 * from the raw envelope — no full record view, no collection.get(), so no
 * spurious 'get' consent entry. Fail-closed gates (b)/(c) live here; gate
 * (a) (storage:'never') fires in collection.reveal before any strategy call.
 * @module
 */
import { dualReadSealedSlot } from '../record-keys/sealed-slot.js'
import { isTombstone } from '../record-keys/tombstone.js'
import { ClassifiedRevealError } from '../../errors.js'
import type { EncryptedEnvelope } from '../../types.js'
import type { EnclaveKey } from '../crypto.js'

export interface RevealEngineCtx {
  readonly collection: string
  readonly encrypted: boolean
  getEnvelope(id: string): Promise<EncryptedEnvelope | null>
  resolveCek(env: EncryptedEnvelope): Promise<EnclaveKey | undefined>
  getDEK(): Promise<EnclaveKey>
}

export async function revealSealedField(ctx: RevealEngineCtx, id: string, field: string): Promise<unknown> {
  const env = await ctx.getEnvelope(id)
  if (env === null || isTombstone(env, ctx.encrypted)) {
    throw new ClassifiedRevealError(ctx.collection, field, `record "${id}" not found in "${ctx.collection}"`)
  }
  if (!ctx.encrypted) {
    // Plaintext collection: nothing is sealed; the value sits in the open body.
    const record = JSON.parse(env._data || '{}') as Record<string, unknown>
    if (!(field in record)) {
      throw new ClassifiedRevealError(ctx.collection, field, `no stored value for "${field}"`)
    }
    return record[field]
  }
  const blob = env._sealed?.[field]
  if (blob === undefined) {
    // Gate (c): fail-closed error, never parseSealedSlot(undefined)'s TypeError.
    throw new ClassifiedRevealError(ctx.collection, field, `no sealed value stored for "${field}"`)
  }
  const cek = await ctx.resolveCek(env)
  const dek = await ctx.getDEK()
  return JSON.parse(await dualReadSealedSlot(blob, field, ctx.collection, cek, dek))
}
