/** The ② capability seam for classified read-egress ops (stage 1: reveal). @module */
import type { ClassifiedFieldSpec } from './descriptor.js'
import { ClassifiedNotEnabledError } from '../../kernel/errors.js'

export interface ClassifiedRevealCtx {
  readonly collection: string
  readonly spec: ClassifiedFieldSpec
  getView(id: string): Promise<Record<string, unknown> | null>
  readonly onAccess?: ((op: 'reveal', id: string) => Promise<void>) | undefined
}

export interface ClassifiedStrategy {
  reveal(ctx: ClassifiedRevealCtx, id: string, field: string): Promise<unknown>
}

export const NO_CLASSIFIED: ClassifiedStrategy = {
  async reveal() { throw new ClassifiedNotEnabledError() },
}
