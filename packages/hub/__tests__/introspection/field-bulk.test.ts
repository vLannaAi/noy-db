/**
 * `FieldMeta.bulk` — read-shape sensitivity declaration (#1363, from the #1251
 * design).
 *
 * ⚠️ THIS IS TELEMETRY PLUMBING, NOT A CONTROL. Against an insider holding the
 * device and local keys, `bulk` prevents nothing; it makes bulk extraction
 * visible early, attributable and loud. The real remediation is key custody
 * (tiers, per-collection DEKs). The kernel does NOTHING with this axis except
 * carry it through introspection.
 *
 * The axis is ORTHOGONAL to `sensitivity`: a company tax id is `'public'` by
 * law AND `bulk: 'sensitive'`, because the protected quantity is the coverage
 * of the set, not the value of one field.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { resolveFieldMeta } from '../../src/with-shape/introspection/field-meta.js'
import { buildJsonSchema } from '../../src/with-shape/introspection/json-schema.js'
import { createNoydb } from '../../src/kernel/noydb.js'
import { memoryStore } from '../../src/kernel/memory-store.js'

describe('FieldMeta.bulk — merge', () => {
  it('carries `bulk` from the channel, orthogonally to `sensitivity`', () => {
    const r = resolveFieldMeta('taxId13', {
      channel: { label: 'Tax ID', sensitivity: 'public', bulk: 'sensitive' },
    })
    expect(r.sensitivity).toBe('public')
    expect(r.bulk).toBe('sensitive')
  })

  it('channel > zodMeta > inferred, same precedence as every other axis', () => {
    expect(resolveFieldMeta('x', { zodMeta: { bulk: 'sensitive' } }).bulk).toBe('sensitive')
    expect(resolveFieldMeta('x', { channel: { label: 'X' } }).bulk).toBeUndefined()
  })

  it('is absent — not defaulted — when nobody declares it (zero cost unopted)', () => {
    expect('bulk' in resolveFieldMeta('x', { inferred: { label: 'X' } })).toBe(false)
  })
})

describe('FieldMeta.bulk — introspection', () => {
  it('describe() surfaces bulk from the fieldMeta channel while sensitivity stays public', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: 'pw-bulk-1' })
    const v = await db.openVault('v')
    const clients = v.collection<{ id: string; taxId13: string }>('clients', {
      fieldMeta: { taxId13: { label: 'Tax ID', sensitivity: 'public', bulk: 'sensitive' } },
    })
    const f = clients.describe().fields.find((x) => x.key === 'taxId13')
    expect(f?.sensitivity).toBe('public')
    expect(f?.bulk).toBe('sensitive')
  })

  it('describeAsync() reads bulk off a zod .meta() declaration', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: 'pw-bulk-2' })
    const v = await db.openVault('v')
    const schema = z.object({
      id: z.string(),
      taxId13: z.string().meta({ label: 'Tax ID', sensitivity: 'public', bulk: 'sensitive' }),
    })
    const clients = v.collection('clients', { schema })
    const d = await clients.describe({ resolveDictLabels: false })
    const f = d.fields.find((x) => x.key === 'taxId13')
    expect(f?.bulk).toBe('sensitive')
    expect(f?.sensitivity).toBe('public')
  })

  it('dumpSchema() carries bulk, so a sensor can discover which collections to account for', async () => {
    const db = await createNoydb({ store: memoryStore(), user: 'alice', secret: 'pw-bulk-3' })
    const v = await db.openVault('v')
    v.collection('clients', {
      schema: z.object({ id: z.string(), taxId13: z.string() }),
      fieldMeta: { taxId13: { label: 'Tax ID', bulk: 'sensitive' } },
    })
    v.collection('notes', {
      schema: z.object({ id: z.string(), note: z.string() }),
      fieldMeta: { note: { label: 'Note' } },
    })
    const snap = await v.dumpSchema()
    expect(snap.collections['clients']?.fields['taxId13']?.bulk).toBe('sensitive')
    expect(snap.collections['notes']?.fields['note']?.bulk).toBeUndefined()
  })

  it('buildJsonSchema emits x-bulk alongside x-sensitivity', () => {
    const out = buildJsonSchema({
      collection: 'clients',
      fields: [{
        key: 'taxId13', type: 'string', optional: false, label: 'Tax ID',
        sensitivity: 'public', bulk: 'sensitive', widget: 'text', editable: true,
      }],
    } as never) as { properties: Record<string, Record<string, unknown>> }
    expect(out.properties['taxId13']?.['x-bulk']).toBe('sensitive')
    expect(out.properties['taxId13']?.['x-sensitivity']).toBe('public')
  })
})
