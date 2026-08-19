import { describe, it, expect } from 'vitest'
import { rosterCanonical, mintRosterTag, verifyRosterTag } from '../src/with-party/team/roster-tag.js'
import { generateDEK } from '../src/kernel/enclave/index.js'

const base = {
  user_id: 'bob', role: 'viewer' as const,
  permissions: { invoices: 'ro' as const, salaries: 'rw' as const },
  granted_by: 'owner-01',
  deks: { invoices: 'WRAPPED-1', salaries: 'WRAPPED-2' }, // #1115 — names are bound, values are not
} // expires_at / export_capability / import_capability / pending_deks absent

describe('rosterCanonical', () => {
  it('is deterministic under permission key order', () => {
    const reordered = { ...base, permissions: { salaries: 'rw' as const, invoices: 'ro' as const } }
    expect(rosterCanonical(base)).toBe(rosterCanonical(reordered))
  })
  it('distinguishes absent from present optional fields', () => {
    expect(rosterCanonical(base)).not.toBe(rosterCanonical({ ...base, expires_at: '2030-01-01T00:00:00Z' }))
  })
})

describe('mint/verify', () => {
  it('round-trips', async () => {
    const key = await generateDEK()
    const tag = await mintRosterTag(base, key)
    expect(await verifyRosterTag(base, tag, key)).toBe(true)
  })
  it('refuses an edited role — the #1096 forgery', async () => {
    const key = await generateDEK()
    const tag = await mintRosterTag(base, key)
    expect(await verifyRosterTag({ ...base, role: 'admin' }, tag, key)).toBe(false)
  })
  it('refuses edited permissions, not only role', async () => {
    const key = await generateDEK()
    const tag = await mintRosterTag(base, key)
    expect(await verifyRosterTag({ ...base, permissions: { salaries: 'rw' } }, tag, key)).toBe(false)
  })
  it('refuses a TRANSPLANTED tag — user_id is bound', async () => {
    const key = await generateDEK()
    const adminAlice = await mintRosterTag({ ...base, user_id: 'alice', role: 'admin' }, key)
    expect(await verifyRosterTag({ ...base, role: 'admin' }, adminAlice, key)).toBe(false)
  })
  it('refuses a missing tag and a wrong key, without throwing', async () => {
    const key = await generateDEK()
    const other = await generateDEK()
    const tag = await mintRosterTag(base, key)
    expect(await verifyRosterTag(base, undefined, key)).toBe(false)
    expect(await verifyRosterTag(base, tag, other)).toBe(false)
  })
})
