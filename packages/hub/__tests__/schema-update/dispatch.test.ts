import { describe, expect, it } from 'vitest'
import { evaluateStrategies } from '../../src/with-shape/schema-update/dispatch.js'
import { additiveOnly, lockSchema, blindUpdate } from '../../src/with-shape/schema-update/strategies.js'
import type { SchemaDelta } from '../../src/with-shape/schema-update/types.js'

const ctx = { collection: 'invoices' }
const nonAdditive: SchemaDelta = { collection: 'invoices', kind: 'non-additive', added: [], removed: ['amount'], changed: [] }
const additive: SchemaDelta = { collection: 'invoices', kind: 'additive', added: ['note'], removed: [], changed: [] }

describe('evaluateStrategies', () => {
  it('empty list → allow', async () => {
    expect(await evaluateStrategies(additive, [], ctx)).toEqual({ action: 'allow' })
  })
  it('all allow → allow', async () => {
    expect(await evaluateStrategies(additive, [blindUpdate(), additiveOnly()], ctx)).toEqual({ action: 'allow' })
  })
  it('first non-allow wins and short-circuits', async () => {
    let secondRan = false
    const spy = { name: 'spy', onSchemaDelta: () => { secondRan = true; return { action: 'allow' as const } } }
    const d = await evaluateStrategies(nonAdditive, [additiveOnly(), spy], ctx)
    expect(d.action).toBe('reject')
    expect(secondRan).toBe(false)
  })
  it('order is the only precedence: lockSchema first beats additiveOnly', async () => {
    const d = await evaluateStrategies(nonAdditive, [lockSchema(), additiveOnly()], ctx)
    expect(d.action).toBe('reject')
    if (d.action === 'reject') expect(d.error.name).toBe('SchemaLockedError')
  })
})
