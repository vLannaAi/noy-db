/** The ② capability seam for classified read-egress ops (stage 1: reveal; stage 2: verify). @module */
import type { ClassifiedFieldSpec } from './descriptor.js'
import { ClassifiedNotEnabledError } from '../../kernel/errors.js'
import type { EncryptedEnvelope } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'

export type { ClassifiedVerdict } from '../../kernel/types.js'
import type { ClassifiedVerdict } from '../../kernel/types.js'

export interface ClassifiedRevealCtx {
  readonly collection: string
  readonly spec: ClassifiedFieldSpec
  /** True on an encrypted collection — false selects the plaintext-body read. */
  readonly encrypted: boolean
  readonly getEnvelope: (id: string) => Promise<EncryptedEnvelope | null>
  readonly resolveCek: (env: EncryptedEnvelope) => Promise<EnclaveKey | undefined>
  readonly getDEK: () => Promise<EnclaveKey>
  readonly onAccess?: ((op: 'reveal', id: string) => Promise<void>) | undefined
}

export interface ClassifiedVerifyCtx {
  readonly collection: string
  readonly spec: ClassifiedFieldSpec
  readonly getEnvelope: (id: string) => Promise<EncryptedEnvelope | null>       // raw envelope, NOT a decrypted view
  readonly resolveCek: (env: EncryptedEnvelope) => Promise<EnclaveKey | undefined>
  readonly getDEK: () => Promise<EnclaveKey>
  readonly now: () => number                                        // injected (Q7)
  /** Group members resolved by the collection (matchGroup only). */
  readonly groupMembers?: ReadonlyArray<{ readonly field: string; readonly spec: ClassifiedFieldSpec }>
  readonly onAccess?: ((op: 'verify', id: string) => Promise<void>) | undefined
}

export interface ClassifiedStrategy {
  reveal(ctx: ClassifiedRevealCtx, id: string, field: string): Promise<unknown>
  verify(ctx: ClassifiedVerifyCtx, id: string, field: string, candidate: string): Promise<ClassifiedVerdict>
  verifyText(ctx: ClassifiedVerifyCtx, id: string, field: string, candidate: string): Promise<ClassifiedVerdict>
  matchGroup(ctx: ClassifiedVerifyCtx, id: string, answers: Record<string, string>,
             opts: { readonly min: number }): Promise<{ readonly passed: boolean }>
}

export const NO_CLASSIFIED: ClassifiedStrategy = {
  async reveal() { throw new ClassifiedNotEnabledError() },
  async verify() { throw new ClassifiedNotEnabledError() },
  async verifyText() { throw new ClassifiedNotEnabledError() },
  async matchGroup() { throw new ClassifiedNotEnabledError() },
}
