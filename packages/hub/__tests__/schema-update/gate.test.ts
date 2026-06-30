import { describe, expect, it } from 'vitest'
import { SchemaUpdateGate } from '../../src/with-shape/schema-update/gate.js'

describe('SchemaUpdateGate', () => {
  it('assertWritable resolves when the decision is allow', async () => {
    const gate = new SchemaUpdateGate(Promise.resolve({ action: 'allow' }))
    await expect(gate.assertWritable()).resolves.toBeUndefined()
  })
  it('assertWritable throws the strategy error when the decision is reject', async () => {
    const err = new Error('nope')
    const gate = new SchemaUpdateGate(Promise.resolve({ action: 'reject', error: err }))
    await expect(gate.assertWritable()).rejects.toBe(err)
  })
  it('re-asserts the same rejection on repeated writes (cached decision)', async () => {
    const err = new Error('still nope')
    const gate = new SchemaUpdateGate(Promise.resolve({ action: 'reject', error: err }))
    await expect(gate.assertWritable()).rejects.toBe(err)
    await expect(gate.assertWritable()).rejects.toBe(err)
  })
  it('a rejected detection promise does not block writes (detection failure ≠ schema rejection)', async () => {
    const gate = new SchemaUpdateGate(Promise.reject(new Error('detection crashed')))
    await expect(gate.assertWritable()).resolves.toBeUndefined()
  })
})
