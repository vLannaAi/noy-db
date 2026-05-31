import { describe, expect, it } from 'vitest'
import { coordinatedCutover } from '../../src/schema-update/cutover.js'
import type { SchemaDelta } from '../../src/schema-update/types.js'

const delta = (kind: SchemaDelta['kind']): SchemaDelta =>
  ({ collection: 'invoices', kind, added: [], removed: [], changed: [] })
const ctx = { collection: 'invoices' }
const transform = (d: Record<string, unknown>) => ({ ...d, migrated: true })

describe('coordinatedCutover', () => {
  it('returns cutover (with the transform) on a non-additive delta', async () => {
    const d = await coordinatedCutover({ transform }).onSchemaDelta(delta('non-additive'), ctx)
    expect(d.action).toBe('cutover')
    if (d.action === 'cutover') expect(d.transform).toBe(transform)
  })
  it('allows additive and none', async () => {
    const s = coordinatedCutover({ transform })
    expect(await s.onSchemaDelta(delta('additive'), ctx)).toEqual({ action: 'allow' })
    expect(await s.onSchemaDelta(delta('none'), ctx)).toEqual({ action: 'allow' })
  })
})
