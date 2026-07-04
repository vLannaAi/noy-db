/** Single-point audited reveal — one field of one record, decrypted once. @module */
import type { ClassifiedRevealCtx } from './strategy.js'
import { ClassifiedRevealError } from './errors.js'

export async function revealField(ctx: ClassifiedRevealCtx, id: string, field: string): Promise<unknown> {
  const view = await ctx.getView(id)
  if (view === null) {
    throw new ClassifiedRevealError(ctx.collection, field, `record "${id}" not found in "${ctx.collection}"`)
  }
  const slot = view[field] as { sealed?: boolean; reveal?: () => Promise<unknown> } | undefined
  const value = slot !== undefined && slot.sealed === true && typeof slot.reveal === 'function'
    ? await slot.reveal()
    : slot
  await ctx.onAccess?.('reveal', id)
  return value
}
