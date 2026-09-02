/**
 * #1288 / lanna-db #4 rule 2 — a member who holds no DEK for a reserved
 * collection that already has records gets `TamperedError` WITH
 * `reason: 'key-absent'`, thrown by the DEK resolver before any decrypt —
 * not a bare AEAD failure from a fabricated key.
 *
 * The consumer's case (niwat #303): `_periods` is reserved, so it is never
 * named in a per-collection grant, and the periods write-gate decrypts it
 * before every subject write. The resolver exempted `_`-collections from the
 * #1004/#1010 entitlement checks and minted a fresh DEK on the miss — a key
 * that decrypts nothing — so the member could read the whole vault and every
 * write was refused as "record may have been tampered with".
 */
import { describe, it, expect } from 'vitest'
import { toMemory } from '../../to-memory/src/index.js'
import { createNoydb, TamperedError } from '../src/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { withTeam } from '../src/with-party/team/index.js'

interface Filing extends Record<string, unknown> {
  id: string
  clientId: string
  amount: number
  date: string
}

describe('TamperedError.reason = key-absent (#1288)', () => {
  it('a per-collection member writing a subject collection behind a closed period sees key-absent, not a bare tamper alert', async () => {
    const store = toMemory()
    const owner = await createNoydb({ store, user: 'owner', secret: 'owner-secret', periodsStrategy: withPeriods(), teamStrategy: withTeam() })
    const v = await owner.openVault('acme')
    const filings = v.collection<Filing>('filings')
    await filings.put('f1', { id: 'f1', clientId: 'A', amount: 100, date: '2026-06-15' })
    // Granted BEFORE any period exists: a grant wraps only the DEKs that exist
    // at grant time, so `_periods` — minted by the owner's first closePeriod
    // below — is never in this member's keyring, and cannot be back-filled.
    await owner.grant('acme', { userId: 'op', displayName: 'Op', role: 'operator', secret: 'op-secret', permissions: { filings: 'rw' } })
    await v.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'date' })

    const member = await createNoydb({ store, user: 'op', secret: 'op-secret', periodsStrategy: withPeriods(), teamStrategy: withTeam() })
    const mv = await member.openVault('acme')
    // Reads work — the member holds the filings DEK.
    expect((await mv.collection<Filing>('filings').get('f1'))?.amount).toBe(100)

    const err = await mv.collection<Filing>('filings')
      .put('f2', { id: 'f2', clientId: 'A', amount: 5, date: '2026-09-01' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TamperedError)
    expect((err as TamperedError).reason).toBe('key-absent')
    expect(String((err as Error).message)).toMatch(/_periods/)
  })

  it('a reserved collection with NO records still mints lazily — creating is not key absence', async () => {
    const store = toMemory()
    const owner = await createNoydb({ store, user: 'owner', secret: 'owner-secret', periodsStrategy: withPeriods(), teamStrategy: withTeam() })
    const v = await owner.openVault('acme')
    // First touch of `_periods` on a fresh vault: no records, so the resolver mints.
    await expect(v.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'date' })).resolves.not.toThrow()
  })
})
