import type { ClassifiedStrategy, ClassifiedVerifyCtx } from './strategy.js'
import type { VdigFieldPolicy } from '../../kernel/types.js'
import type { ClassifiedFieldSpec } from './descriptor.js'

function policyOf(spec: ClassifiedFieldSpec): VdigFieldPolicy {
  return {
    normalize: spec.verifyNormalize ?? 'password',
    notLastN: spec.notLastN ?? 0,
    equatable: false,
    ...(spec.rotateDays !== undefined ? { rotateDays: spec.rotateDays } : {}),
  }
}

const engineCtx = (ctx: ClassifiedVerifyCtx) => ({
  collection: ctx.collection,
  getEnvelope: ctx.getEnvelope,
  resolveCek: ctx.resolveCek,
  getDEK: ctx.getDEK,
  now: ctx.now,
})

/** Opt-in factory: enables reveal + verify/verifyText/matchGroup (stage 2). */
export function withClassified(): ClassifiedStrategy {
  return {
    async reveal(ctx, id, field) {
      const { revealSealedField } = await import('../../kernel/enclave/classify/reveal.js')
      const value = await revealSealedField({
        collection: ctx.collection, encrypted: ctx.encrypted,
        getEnvelope: ctx.getEnvelope, resolveCek: ctx.resolveCek, getDEK: ctx.getDEK,
      }, id, field)
      await ctx.onAccess?.('reveal', id)
      return value
    },
    async verify(ctx, id, field, candidate) {
      const { verifyDigestField } = await import('../../kernel/enclave/classify/verify.js')
      const verdict = await verifyDigestField(engineCtx(ctx), id, field, candidate, policyOf(ctx.spec))
      await ctx.onAccess?.('verify', id)                    // fires on ok AND fail (attempt audit)
      return verdict
    },
    async verifyText(ctx, id, field, candidate) {
      const { verifyTextField } = await import('../../kernel/enclave/classify/verify.js')
      const verdict = await verifyTextField(engineCtx(ctx), id, field, candidate, ctx.spec.verifyNormalize ?? 'password')
      await ctx.onAccess?.('verify', id)
      return verdict
    },
    async matchGroup(ctx, id, answers, opts) {
      const { matchGroupFields } = await import('../../kernel/enclave/classify/verify.js')
      const members = (ctx.groupMembers ?? []).map((m) => ({ field: m.field, policy: policyOf(m.spec) }))
      const result = await matchGroupFields(engineCtx(ctx), id, answers, members, opts)
      await ctx.onAccess?.('verify', id)                    // ONE entry per call (Q6)
      return result
    },
  }
}
