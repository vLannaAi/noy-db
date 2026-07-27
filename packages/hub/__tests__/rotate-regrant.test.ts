/**
 * #854 — `rotate()` drops other members' access, and says so.
 *
 * The jsdoc used to promise that "every current member keeps access, but with
 * fresh keys" while the engine deleted the rotated collections from every
 * other member's keyring. Nothing asserted either behaviour, so the contract
 * and the code drifted apart unnoticed.
 *
 * These tests pin the behaviour the engine actually has — which is the correct
 * one under zero-knowledge, since the caller cannot derive another member's
 * KEK to re-wrap a fresh DEK for them — and pin the `needsRegrant` report that
 * now makes the access loss visible instead of silent.
 */
import { describe, it, expect, beforeEach } from 'vitest'

import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb } from '../src/kernel/noydb.js'
import type { Noydb } from '../src/kernel/noydb.js'
import { withTeam } from '../src/with-party/team/index.js'

interface Invoice extends Record<string, unknown> { amount: number }

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(v: string, col: string) {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(v, col, id) { return store.get(v)?.get(col)?.get(id) ?? null },
    async put(v, col, id, env) { gc(v, col).set(id, env) },
    async delete(v, col, id) { gc(v, col).delete(id) },
    async list(v, col) { return [...(store.get(v)?.get(col)?.keys() ?? [])] },
    async listCollections(v) { return [...(store.get(v)?.keys() ?? [])] },
    async clear(v, col) { gc(v, col).clear() },
  } as unknown as NoydbStore
}

const VAULT = 'acme'

describe('rotate() re-grant reporting (#854)', () => {
  let adapter: NoydbStore
  let ownerDb: Noydb

  beforeEach(async () => {
    adapter = inlineMemory()
    ownerDb = await createNoydb({ teamStrategy: withTeam(), store: adapter, user: 'owner-01', secret: 'owner-pass-phrase' })
    const v = await ownerDb.openVault(VAULT)
    await v.collection<Invoice>('invoices').put('inv-1', { amount: 100 })
    await v.collection<Invoice>('payments').put('pay-1', { amount: 50 })

    await ownerDb.grant(VAULT, {
      userId: 'bob', displayName: 'Bob', role: 'operator',
      secret: 'bob-pass-phrase',
      permissions: { invoices: 'rw', payments: 'ro' },
    })
  })

  it('reports every (member, collection) pair whose access it dropped', async () => {
    const result = await ownerDb.rotate(VAULT, ['invoices'])

    expect(result.needsRegrant).toEqual([{ userId: 'bob', collection: 'invoices' }])
  })

  it('does NOT report a member who never held the rotated collection', async () => {
    // Bob has no `archive`, so rotating it costs him nothing to re-grant.
    const result = await ownerDb.rotate(VAULT, ['archive'])

    expect(result.needsRegrant).toEqual([])
  })

  it('reports one entry per (member, collection), not per member', async () => {
    const result = await ownerDb.rotate(VAULT, ['invoices', 'payments'])

    expect(result.needsRegrant).toHaveLength(2)
    expect(result.needsRegrant).toContainEqual({ userId: 'bob', collection: 'invoices' })
    expect(result.needsRegrant).toContainEqual({ userId: 'bob', collection: 'payments' })
  })

  it('never reports the caller — their own keyring is re-wrapped in place', async () => {
    const result = await ownerDb.rotate(VAULT, ['invoices', 'payments'])

    expect(result.needsRegrant.some((r) => r.userId === 'owner-01')).toBe(false)
  })

  it('leaves the caller able to read the rotated collection', async () => {
    await ownerDb.rotate(VAULT, ['invoices'])

    const v = await ownerDb.openVault(VAULT)
    expect((await v.collection<Invoice>('invoices').get('inv-1'))?.amount).toBe(100)
  })

  it('keeps the member in the vault — rotate is not revoke', async () => {
    await ownerDb.rotate(VAULT, ['invoices'])

    expect((await ownerDb.listUsers(VAULT)).map((u) => u.userId)).toContain('bob')
  })

  it('leaves a non-rotated collection untouched for the member', async () => {
    const result = await ownerDb.rotate(VAULT, ['invoices'])

    // `payments` was not rotated, so Bob's entry for it survives and is
    // absent from the re-grant list.
    expect(result.needsRegrant.some((r) => r.collection === 'payments')).toBe(false)
  })
})
