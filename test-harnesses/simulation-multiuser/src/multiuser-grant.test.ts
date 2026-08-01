/**
 * Multi-user simulation (#927).
 *
 * Two (and more) distinct `user` identities on ONE shared store, using
 * the real `withTeam()` grant flow end to end — real hub instances,
 * real `toMemory()` store, nothing mocked. Each member unlocks with
 * their OWN secret; what a grant hands over is a wrapped copy of the
 * collection DEKs, not the owner's secret. The scenarios pin:
 *
 *  1. grant → collaborate: the owner grants an operator `rw` on one
 *     collection; the member (own instance, own secret) reads the
 *     owner's records and writes back; the owner reads the member's
 *     write — a full two-user round trip through ciphertext;
 *  2. role enforcement: a viewer reads everything but every write is
 *     refused with `ReadOnlyError`;
 *  3. zero-knowledge refusal: a user with NO grant cannot even open
 *     the vault — `openVault` throws `NoAccessError` rather than
 *     self-provisioning a keyring into someone else's vault;
 *  4. revoke: after the owner revokes a member, a fresh session for
 *     that member is refused the same way.
 *
 * Sequencing rule (pinned in #920's concurrent suite): an instance
 * snapshots the vault keyring at `openVault()` — member instances are
 * opened only AFTER the owner's seed writes minted the collection DEKs
 * and the grant wrapped them for the member.
 *
 * Hub-side errors are matched by `constructor.name`, mirroring the
 * concurrent harness's published-seam convention.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../../../packages/hub/src/index.js'
import { withTeam } from '../../../packages/hub/src/with-party/team/index.js'
import { toMemory } from '../../../packages/to-memory/src/index.js'
import type { Noydb } from '../../../packages/hub/src/index.js'
import type { NoydbStore } from '../../../packages/hub/src/kernel/types.js'

const VAULT = 'acme'

interface Invoice extends Record<string, unknown> { customer: string; amount: number }

async function open(store: NoydbStore, user: string, secret: string): Promise<Noydb> {
  return createNoydb({ teamStrategy: withTeam(), store, user, secret })
}

async function caught(p: Promise<unknown>): Promise<Error | null> {
  return p.then(() => null, (e: unknown) => e as Error)
}

describe('simulation: two user identities on one shared store', () => {
  let shared: NoydbStore
  let ownerDb: Noydb

  beforeEach(async () => {
    shared = toMemory()
    ownerDb = await open(shared, 'owner-01', 'owner-pass')
    // Seed BEFORE any grant/member-open so the collection DEK exists to be
    // wrapped for the member (keyring snapshot rule — see header).
    const vault = await ownerDb.openVault(VAULT)
    await vault.collection<Invoice>('invoices').put('inv-001', { customer: 'alpha', amount: 5000 })
  })

  it('owner grants an operator rw; the member reads and writes with their OWN secret; owner reads it back', async () => {
    await ownerDb.grant(VAULT, {
      userId: 'op-01', displayName: 'Operator', role: 'operator',
      secret: 'op-own-pass',
      permissions: { invoices: 'rw' },
    })

    // A separate instance, separate identity, separate secret.
    const memberDb = await open(shared, 'op-01', 'op-own-pass')
    const memberVault = await memberDb.openVault(VAULT)
    const memberInvoices = memberVault.collection<Invoice>('invoices')

    // Member decrypts the owner's record...
    expect(await memberInvoices.get('inv-001')).toEqual({ customer: 'alpha', amount: 5000 })
    // ...and writes back into the shared vault.
    await memberInvoices.put('inv-002', { customer: 'beta', amount: 750 })

    // The owner reads the member's write through a FRESH session — an
    // already-open instance hydrated its cache at openVault() and does not
    // refetch records that appeared later (cross-instance refresh is the
    // sync engine's job, not the cache's).
    const ownerAgain = await open(shared, 'owner-01', 'owner-pass')
    expect(await (await ownerAgain.openVault(VAULT)).collection<Invoice>('invoices').get('inv-002'))
      .toEqual({ customer: 'beta', amount: 750 })
    // And the shared store never saw plaintext.
    const env = (await shared.get(VAULT, 'invoices', 'inv-002'))!
    expect(env._iv.length).toBeGreaterThan(0)
    expect(() => JSON.parse(env._data)).toThrow()
  })

  it('a viewer reads everything but every write is refused with ReadOnlyError', async () => {
    await ownerDb.grant(VAULT, {
      userId: 'viewer-01', displayName: 'Viewer', role: 'viewer',
      secret: 'viewer-own-pass',
    })

    const viewerDb = await open(shared, 'viewer-01', 'viewer-own-pass')
    const invoices = (await viewerDb.openVault(VAULT)).collection<Invoice>('invoices')

    expect(await invoices.get('inv-001')).toEqual({ customer: 'alpha', amount: 5000 })

    const putErr = await caught(invoices.put('inv-bad', { customer: 'x', amount: 0 }))
    expect(putErr).toBeInstanceOf(Error)
    expect(putErr!.constructor.name).toBe('ReadOnlyError')

    const delErr = await caught(invoices.delete('inv-001'))
    expect(delErr).toBeInstanceOf(Error)
    expect(delErr!.constructor.name).toBe('ReadOnlyError')

    // Nothing landed in the store.
    expect(await shared.get(VAULT, 'invoices', 'inv-bad')).toBeNull()
    expect(await shared.get(VAULT, 'invoices', 'inv-001')).not.toBeNull()
  })

  it('a user with NO grant cannot open the vault at all — no self-provisioning into a held vault', async () => {
    const strangerDb = await open(shared, 'stranger-01', 'stranger-pass')

    const err = await caught(strangerDb.openVault(VAULT))
    expect(err).toBeInstanceOf(Error)
    expect(err!.constructor.name).toBe('NoAccessError')
    expect(err!.message).toContain('refusing to self-provision')

    // The refusal left no keyring behind for the stranger.
    expect(await shared.get(VAULT, '_keyring', 'stranger-01')).toBeNull()
  })

  it('after revoke, a fresh session for the ex-member is refused like any stranger', async () => {
    await ownerDb.grant(VAULT, {
      userId: 'op-01', displayName: 'Operator', role: 'operator',
      secret: 'op-own-pass',
      permissions: { invoices: 'rw' },
    })
    // The grant works before revoke...
    const before = await open(shared, 'op-01', 'op-own-pass')
    expect(await (await before.openVault(VAULT)).collection<Invoice>('invoices').get('inv-001'))
      .toEqual({ customer: 'alpha', amount: 5000 })

    await ownerDb.revoke(VAULT, { userId: 'op-01', rotateKeys: false })

    // ...and a NEW session after revoke finds no keyring and is refused.
    const after = await open(shared, 'op-01', 'op-own-pass')
    const err = await caught(after.openVault(VAULT))
    expect(err).toBeInstanceOf(Error)
    expect(err!.constructor.name).toBe('NoAccessError')
  })
})
