import { describe, it, expect } from 'vitest'
import { NO_CLASSIFIED } from '../../src/via/classified/strategy.js'
import type { ClassifiedVerifyCtx } from '../../src/via/classified/strategy.js'
import { withClassified } from '../../src/via/classified/active.js'
import { classified } from '../../src/via/classified/presets.js'
import { ClassifiedNotEnabledError } from '../../src/kernel/errors.js'
import { generateDEK } from '../../src/kernel/enclave/index.js'
import { normalizeForVerify } from '../../src/kernel/enclave/classify/normalize.js'
import { mintBidxTag } from '../../src/kernel/enclave/classify/bidx.js'

describe('NO_CLASSIFIED.computeTarget', () => {
  it('throws ClassifiedNotEnabledError', async () => {
    await expect(NO_CLASSIFIED.computeTarget({} as never, 'password', 'x'))
      .rejects.toBeInstanceOf(ClassifiedNotEnabledError)
  })
})

describe('withClassified().computeTarget', () => {
  it('derives the same tag mintBidxTag would produce for the matching candidate', async () => {
    const dek = await generateDEK()
    const ctx: ClassifiedVerifyCtx = {
      collection: 'users',
      spec: classified.password({ equatable: true }),
      getEnvelope: async () => null,
      resolveCek: async () => undefined,
      getDEK: async () => dek,
      now: () => Date.now(),
    }
    const target = await withClassified().computeTarget(ctx, 'password', 'hunter2-hunter2')
    const expected = await mintBidxTag(normalizeForVerify('password', 'hunter2-hunter2'), dek, 'users', 'password')
    expect(target).toBe(expected)
  }, 30_000)
})
