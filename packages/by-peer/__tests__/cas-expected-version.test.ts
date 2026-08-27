/**
 * #1026 — a `peerStore()`-backed vault could create and read records but never
 * overwrite one: every update failed CAS with `expected null, found <n>`.
 *
 * JSON cannot represent `undefined` inside an array, so
 * `JSON.stringify([v, c, id, env, undefined])` serialises the trailing argument
 * as `null`. The store contract types it `expectedVersion?: number` — `null` is
 * not a legal value — and a store's guard is `expectedVersion !== undefined`,
 * which `null` passes. So the wire hop silently rewrote "do not CAS-check" into
 * "assert this record is at version null", which no existing record can satisfy.
 *
 * Creates kept working because the check short-circuits when there is no
 * existing record, which is exactly why the failure presented as
 * "remote stores are read-only" rather than as a serialisation bug.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '@noy-db/hub'
import { toMemory } from '@noy-db/to-memory'
import { servePeerStore, peerStore, pairInMemory } from '../src/index.js'

const SECRET = 'cas-expected-version-2026'

async function hostAndGuest() {
  const hostStore = toMemory()
  const hostDb = await createNoydb({ store: hostStore, user: 'ann', secret: SECRET, validateSecret: false })
  const hostVault = await hostDb.openVault('niwat')

  const [hostCh, guestCh] = pairInMemory()
  servePeerStore({ channel: hostCh, store: hostStore, token: 'test-invite-token' })

  const guestDb = await createNoydb({
    store: peerStore({ channel: guestCh, token: 'test-invite-token', token: 'test-invite-token' }), user: 'ann', secret: SECRET, validateSecret: false,
  })
  const guestVault = await guestDb.openVault('niwat')
  return { hostStore, hostVault, guestVault }
}

interface Bill extends Record<string, unknown> { id: string; total: number }

describe('#1026 — CAS through a peerStore', () => {
  it('a guest can overwrite a record the host created', async () => {
    const { hostVault, guestVault } = await hostAndGuest()
    await hostVault.collection<Bill>('bills').put('b-1', { id: 'b-1', total: 100 })

    expect((await guestVault.collection<Bill>('bills').get('b-1'))?.total).toBe(100)
    await expect(guestVault.collection<Bill>('bills').put('b-1', { id: 'b-1', total: 250 }))
      .resolves.not.toThrow()
    expect((await guestVault.collection<Bill>('bills').get('b-1'))?.total).toBe(250)
  })

  it('a guest can overwrite a record it created itself, repeatedly', async () => {
    const { guestVault } = await hostAndGuest()
    const bills = guestVault.collection<Bill>('bills')
    await bills.put('g-1', { id: 'g-1', total: 1 })
    await bills.put('g-1', { id: 'g-1', total: 2 })
    await bills.put('g-1', { id: 'g-1', total: 3 })
    expect((await bills.get('g-1'))?.total).toBe(3)
  })

  it('the guest’s update actually lands in the host’s store', async () => {
    const { hostStore, hostVault, guestVault } = await hostAndGuest()
    await hostVault.collection<Bill>('bills').put('b-1', { id: 'b-1', total: 100 })
    await guestVault.collection<Bill>('bills').put('b-1', { id: 'b-1', total: 250 })

    // Read through a FRESH host vault. The original `hostVault` is hydrated, so
    // its in-memory snapshot predates the guest's write — that staleness is
    // ordinary two-writer behaviour, not the CAS bug, and asserting against it
    // would test the cache rather than the write.
    const reopened = await createNoydb({ store: hostStore, user: 'ann', secret: SECRET, validateSecret: false })
    const fresh = await reopened.openVault('niwat')
    expect((await fresh.collection<Bill>('bills').get('b-1'))?.total).toBe(250)
  })

  it('creates still work — the path that always did', async () => {
    const { guestVault } = await hostAndGuest()
    await expect(guestVault.collection<Bill>('bills').put('b-new', { id: 'b-new', total: 1 }))
      .resolves.not.toThrow()
  })

  it('a delete followed by a re-create round-trips', async () => {
    const { guestVault } = await hostAndGuest()
    const bills = guestVault.collection<Bill>('bills')
    await bills.put('b-1', { id: 'b-1', total: 1 })
    await bills.delete('b-1')
    expect(await bills.get('b-1')).toBeNull()
    await expect(bills.put('b-1', { id: 'b-1', total: 9 })).resolves.not.toThrow()
  })

  it('a REAL version conflict still throws — the fix must not disable CAS', async () => {
    const { hostStore } = await hostAndGuest()
    const [hostCh, guestCh] = pairInMemory()
    servePeerStore({ channel: hostCh, store: hostStore, token: 'test-invite-token' })
    const remote = peerStore({ channel: guestCh, token: 'test-invite-token', token: 'test-invite-token' })

    const envelope = { _noydb: 1 as const, _v: 1, _ts: new Date().toISOString(), _iv: '', _data: '{}' }
    await remote.put('niwat', 'raw', 'r1', envelope)
    // Stored at _v 1; asserting _v 7 must be refused, not silently accepted.
    await expect(remote.put('niwat', 'raw', 'r1', { ...envelope, _v: 2 }, 7))
      .rejects.toBeInstanceOf(ConflictError)
  })
})
