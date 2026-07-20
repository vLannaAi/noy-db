/**
 * Classified strategy seam (#629 Task 5 — moved out of
 * `via/classified/strategy.ts`, precedent: `port/with/i18n-strategy.ts`).
 * Lives on the `/with` port (the one seam the kernel spine may import
 * statically) so `Collection`/`Vault` can hold the `NO_CLASSIFIED` default
 * without a spine→service static import.
 *
 * This file (unlike `via/classified/**`) is NOT subject to the
 * `via-enclave-isolation` architecture guard — it may import `EnclaveKey`
 * from the enclave barrel freely, the same way `port/with/i18n-strategy.ts`
 * did before #629 Task 4's DictionaryHandle cutover.
 *
 * The ② capability seam for classified read-egress ops (stage 1: reveal;
 * stage 2: verify).
 *
 * @internal
 */
import type { ClassifiedFieldSpec } from '../../via/classified/descriptor.js'
import { ClassifiedNotEnabledError } from '../../kernel/errors.js'
import type { EncryptedEnvelope } from '../../kernel/types.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'
import { linkClassifiedVia } from '../../via/classified/binding.js'

// #629 Task 10 — re-export the classified binding's erase-cfg TYPE (not
// `via/classified/binding.js` directly) so the kernel spine can name
// it for the post-construction `classifySealedShred` wiring, same rationale
// as `resolveClassifiedFields`/`guardClassifiedCompat` above.
export type { ClassifiedViaConfig } from '../../via/classified/binding.js'

export type { ClassifiedVerdict } from '../../kernel/types.js'
import type { ClassifiedVerdict } from '../../kernel/types.js'

// #629 Task 6 — the classified binding's construction-time resolve/guard,
// re-exported here (not `via/classified/{resolve,guards}.js` directly)
// so the kernel spine keeps importing only this one `/with` port seam, same
// rationale as `NO_CLASSIFIED` below.
export { resolveClassifiedFields, type ClassifiedEntry, type ResolvedClassified } from '../../via/classified/resolve.js'
export { guardClassifiedCompat, type ClassifiedGuardCtx } from '../../via/classified/guards.js'
export type { ClassifiedFieldSpec }

// Install the classified Via binder EAGERLY — unlike money()/i18nText(),
// several classified fixtures (both hub tests and consumer code) build a raw
// `ClassifiedFieldSpec` object literal without ever calling a
// `classified.*()` preset (bypassing `via/classified/presets.ts`
// entirely — an intentionally supported pattern, see that module's Task 5
// doc comment). Linking lazily at preset-call time (the money/i18n pattern)
// would leave `viaBinder('classified')` unlinked for those declarations.
// This port module is already unconditionally imported by the kernel spine
// (for the `NO_CLASSIFIED` strategy default below), so linking here
// guarantees the binder is always installed before `compileViaBindings`
// ever needs it, regardless of how a collection's classifiedFields were
// constructed.
linkClassifiedVia()

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
  readonly onAccess?: ((op: 'verify' | 'find', id: string) => Promise<void>) | undefined
}

export interface ClassifiedStrategy {
  reveal(ctx: ClassifiedRevealCtx, id: string, field: string): Promise<unknown>
  verify(ctx: ClassifiedVerifyCtx, id: string, field: string, candidate: string): Promise<ClassifiedVerdict>
  verifyText(ctx: ClassifiedVerifyCtx, id: string, field: string, candidate: string): Promise<ClassifiedVerdict>
  matchGroup(ctx: ClassifiedVerifyCtx, id: string, answers: Record<string, string>,
             opts: { readonly min: number }): Promise<{ readonly passed: boolean }>
  computeTarget(ctx: ClassifiedVerifyCtx, field: string, candidate: string, costByte?: number): Promise<string | null>
}

export const NO_CLASSIFIED: ClassifiedStrategy = {
  async reveal() { throw new ClassifiedNotEnabledError() },
  async verify() { throw new ClassifiedNotEnabledError() },
  async verifyText() { throw new ClassifiedNotEnabledError() },
  async matchGroup() { throw new ClassifiedNotEnabledError() },
  async computeTarget() { throw new ClassifiedNotEnabledError() },
}
