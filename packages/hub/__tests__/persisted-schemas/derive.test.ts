import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { derivePersistedSchema, isZodSchema } from '../../src/persisted-schemas/derive.js'

describe('isZodSchema', () => {
  it('identifies a Zod schema via _def.typeName', () => {
    expect(isZodSchema(z.object({ id: z.string() }))).toBe(true)
    expect(isZodSchema(z.string())).toBe(true)
  })

  it('rejects non-Zod values', () => {
    expect(isZodSchema(null)).toBe(false)
    expect(isZodSchema({})).toBe(false)
    expect(isZodSchema({ '~standard': { version: 1 } })).toBe(false)
    expect(isZodSchema('string')).toBe(false)
  })
})

describe('derivePersistedSchema', () => {
  it('derives a Zod envelope with JSON Schema body and a 64-char hex hash', async () => {
    const Invoice = z.object({
      id: z.string(),
      amount: z.number().positive(),
    })
    const env = await derivePersistedSchema(Invoice)
    expect(env._noydb_schema).toBe(1)
    expect(env.kind).toBe('Zod')
    expect(env.jsonSchema).toMatchObject({
      type: 'object',
      properties: {
        id: expect.objectContaining({ type: 'string' }),
        amount: expect.objectContaining({ type: 'number' }),
      },
    })
    expect(env.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(env.derivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(env.reason).toBeUndefined()
  })

  it('produces an identical hash for two equivalent Zod schemas', async () => {
    const a = await derivePersistedSchema(z.object({ a: z.string(), b: z.number() }))
    const b = await derivePersistedSchema(z.object({ a: z.string(), b: z.number() }))
    expect(a.hash).toBe(b.hash)
  })

  it('produces a different hash when the schema shape changes', async () => {
    const a = await derivePersistedSchema(z.object({ id: z.string() }))
    const b = await derivePersistedSchema(z.object({ id: z.string(), extra: z.number() }))
    expect(a.hash).not.toBe(b.hash)
  })

  it('writes a stub envelope (jsonSchema: null + reason) for a non-Zod Standard Schema validator', async () => {
    const fakeValibot = { '~standard': { version: 1, vendor: 'valibot', validate: () => ({}) } }
    const env = await derivePersistedSchema(fakeValibot as unknown as never)
    expect(env._noydb_schema).toBe(1)
    expect(env.kind).toBe('Unknown')
    expect(env.jsonSchema).toBeNull()
    expect(env.hash).toBeNull()
    expect(env.reason).toMatch(/derivation not yet supported/i)
  })
})
