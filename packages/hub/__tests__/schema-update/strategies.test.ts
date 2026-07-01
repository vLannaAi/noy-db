import { describe, expect, it } from 'vitest'
import { blindUpdate, lockSchema, additiveOnly } from '../../src/with-shape/schema-update/strategies.js'
import { NonAdditiveSchemaChangeError, SchemaLockedError } from '../../src/kernel/errors.js'
import type { SchemaDelta } from '../../src/with-shape/schema-update/types.js'

const delta = (over: Partial<SchemaDelta>): SchemaDelta => ({
  collection: 'invoices', kind: 'additive', added: [], removed: [], changed: [], ...over,
})
const ctx = { collection: 'invoices' }

describe('blindUpdate', () => {
  it('always allows', async () => {
    expect(await blindUpdate().onSchemaDelta(delta({ kind: 'non-additive' }), ctx)).toEqual({ action: 'allow' })
  })
})

describe('additiveOnly', () => {
  it('allows additive', async () => {
    expect(await additiveOnly().onSchemaDelta(delta({ kind: 'additive' }), ctx)).toEqual({ action: 'allow' })
  })
  it('allows none', async () => {
    expect(await additiveOnly().onSchemaDelta(delta({ kind: 'none' }), ctx)).toEqual({ action: 'allow' })
  })
  it('rejects non-additive with NonAdditiveSchemaChangeError', async () => {
    const d = await additiveOnly().onSchemaDelta(delta({ kind: 'non-additive', removed: ['amount'] }), ctx)
    expect(d.action).toBe('reject')
    if (d.action === 'reject') expect(d.error).toBeInstanceOf(NonAdditiveSchemaChangeError)
  })
})

describe('lockSchema', () => {
  it('rejects any change when no fields given', async () => {
    const d = await lockSchema().onSchemaDelta(delta({ kind: 'additive', added: ['note'] }), ctx)
    expect(d.action).toBe('reject')
    if (d.action === 'reject') expect(d.error).toBeInstanceOf(SchemaLockedError)
  })
  it('allows none even when locked', async () => {
    expect(await lockSchema().onSchemaDelta(delta({ kind: 'none' }), ctx)).toEqual({ action: 'allow' })
  })
  it('with fields: rejects only when a listed field changes', async () => {
    const onlyId = lockSchema({ fields: ['id'] })
    expect(await onlyId.onSchemaDelta(delta({ kind: 'additive', added: ['note'] }), ctx)).toEqual({ action: 'allow' })
    const hit = await onlyId.onSchemaDelta(delta({ kind: 'non-additive', removed: ['id'] }), ctx)
    expect(hit.action).toBe('reject')
  })
})
