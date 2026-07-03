import { describe, it, expect } from 'vitest'
import { applyListProjection } from '../../src/with-shape/introspection/projection.js'
import type { CollectionDescription } from '../../src/with-shape/introspection/describe.js'

const desc = {
  collection: 'cards', label: 'Cards',
  fields: [
    { key: 'pan', type: 'string', label: 'Pan', sensitivity: 'secret',
      classified: { preset: 'creditCard.pan', storage: 'recoverable', list: { mask: '•••• ${last4}' } } },
    { key: 'cvcNote', type: 'string', label: 'N', sensitivity: 'pii' },
    { key: 'pan_last4', type: 'string', label: 'Last4' },
    { key: 'total', type: 'number', label: 'Total' },
  ],
} as unknown as CollectionDescription

describe('applyListProjection', () => {
  const rec = { pan: { sealed: true }, pan_last4: '4242', cvcNote: 'call bank', total: 9 }

  it('masks classified fields resolving ${rider} from companions; leaves safe fields', () => {
    const out = applyListProjection(desc, rec)
    expect(out.pan).toBe('•••• 4242')
    expect(out.pan_last4).toBe('4242')
    expect(out.total).toBe(9)
    expect(out.cvcNote).toBe('call bank')       // plain pii untouched without opts
    expect(rec.pan).toEqual({ sealed: true })   // non-mutating
  })

  it('opts.sensitivity handles plain-tagged fields: omit drops, mask blots', () => {
    expect(applyListProjection(desc, rec, { sensitivity: 'omit' })).not.toHaveProperty('cvcNote')
    expect(applyListProjection(desc, rec, { sensitivity: 'mask' }).cvcNote).toBe('•••')
  })

  it('classified list:omit drops the field; missing rider companions blot to •', () => {
    const d2 = { ...desc, fields: [
      { key: 'x', type: 'string', label: 'X', classified: { preset: 'p', storage: 'never', list: 'omit' } },
      { key: 'pan', type: 'string', label: 'P', classified: { preset: 'p', storage: 'recoverable', list: { mask: '•••• ${last4}' } } },
    ] } as unknown as CollectionDescription
    const out = applyListProjection(d2, { x: 'boom', pan: 'raw' })
    expect(out).not.toHaveProperty('x')
    expect(out.pan).toBe('•••• •')
  })
})
