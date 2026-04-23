/**
 * Admin-grants-admin (bounded delegation) tests — #62, v0.5.
 *
 * Coverage:
 *   1. **Grant capability** — admin can grant another admin (rejected
 *      under v0.4), and the resulting admin can actually unlock the
 *      vault with their own passphrase and read collections.
 *   2. **PrivilegeEscalationError class** — exported from the public
 *      API, has the right shape, distinct from PermissionDeniedError.
 *      The error is structurally unreachable in the v0.5 admin model
 *      (admin grants always inherit the full caller DEK set), so this
 *      test only asserts the class shape — the throw path is exercised
 *      by future per-collection admin scoping work.
 *   3. **Cascade-strict revoke** — revoking an admin who granted other
 *      admins (transitively) revokes the entire subtree in a single
 *      operation. A peer admin granted by a different chain is left
 *      alone. Single rotation pass at the end.
 *   4. **Cascade-warn revoke** — descendants are NOT removed; a
 *      console.warn is emitted listing them by id.
 *   5. **Owner is unrevocable** — even by an admin who has been newly
 *      promoted via the new delegation path. Same rule as v0.4.
 *   6. **Independence across delegation chains** — admin-A and admin-B
 *      both granted by owner. Revoking admin-A does not touch admin-B
 *      or anything granted by admin-B.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import {
  ConflictError,
  PrivilegeEscalationError,
  PermissionDeniedError,
} from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { amount: number; client: string }

describe('admin-grants-admin (bounded delegation) — #62', () => {
  const COMP = 'acme'
  let adapter: NoydbStore
  let ownerDb: Noydb

  beforeEach(async () => {
    adapter = memory()
    ownerDb = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
    const comp = await ownerDb.openVault(COMP)
    await comp.collection<Invoice>('invoices').put('inv-1', { amount: 100, client: 'Globex' })

    // Standing setup: one owner, one admin granted by owner.
    await ownerDb.grant(COMP, {
      userId: 'admin-1',
      displayName: 'First Admin',
      role: 'admin',
      passphrase: 'admin-1-pass',
    })
  })

  describe('grant capability', () => {
    it('admin can grant another admin (was rejected under v0.4)', async () => {
      const admin1Db = await createNoydb({ store: adapter, user: 'admin-1', secret: 'admin-1-pass' })
      await expect(
        admin1Db.grant(COMP, {
          userId: 'admin-2',
          displayName: 'Second Admin',
          role: 'admin',
          passphrase: 'admin-2-pass',
        }),
      ).resolves.not.toThrow()
    })

    it('the granted admin can unlock the vault and read records', async () => {
      const admin1Db = await createNoydb({ store: adapter, user: 'admin-1', secret: 'admin-1-pass' })
      await admin1Db.grant(COMP, {
        userId: 'admin-2',
        displayName: 'Second Admin',
        role: 'admin',
        passphrase: 'admin-2-pass',
      })

      const admin2Db = await createNoydb({ store: adapter, user: 'admin-2', secret: 'admin-2-pass' })
      const comp = await admin2Db.openVault(COMP)
      const inv = await comp.collection<Invoice>('invoices').get('inv-1')
      expect(inv?.amount).toBe(100)
    })

    it('the granted admin can themselves grant a third admin (transitive delegation)', async () => {
      const admin1Db = await createNoydb({ store: adapter, user: 'admin-1', secret: 'admin-1-pass' })
      await admin1Db.grant(COMP, {
        userId: 'admin-2',
        displayName: 'Second Admin',
        role: 'admin',
        passphrase: 'admin-2-pass',
      })

      const admin2Db = await createNoydb({ store: adapter, user: 'admin-2', secret: 'admin-2-pass' })
      await expect(
        admin2Db.grant(COMP, {
          userId: 'admin-3',
          displayName: 'Third Admin',
          role: 'admin',
          passphrase: 'admin-3-pass',
        }),
      ).resolves.not.toThrow()
    })

    it('admin-grants-admin still produces a working keyring for non-admin grantees too', async () => {
      // Sanity check that the admin → operator/viewer/client paths still
      // work after the canGrant change. The lateral admin delegation
      // shouldn't have any effect on these — but it's cheap to verify.
      const admin1Db = await createNoydb({ store: adapter, user: 'admin-1', secret: 'admin-1-pass' })
      await expect(
        admin1Db.grant(COMP, {
          userId: 'op-from-admin1',
          displayName: 'Op',
          role: 'operator',
          passphrase: 'op-pass',
          permissions: { invoices: 'rw' },
        }),
      ).resolves.not.toThrow()
    })
  })

  describe('PrivilegeEscalationError class', () => {
    it('is exported from the public API and has the right shape', () => {
      const err = new PrivilegeEscalationError('forbidden_collection')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(PrivilegeEscalationError)
      expect(err.name).toBe('PrivilegeEscalationError')
      expect(err.code).toBe('PRIVILEGE_ESCALATION')
      expect(err.offendingCollection).toBe('forbidden_collection')
    })

    it('is distinct from PermissionDeniedError (different code, different class)', () => {
      const escalation = new PrivilegeEscalationError('x')
      const denied = new PermissionDeniedError()
      expect(escalation.code).not.toBe(denied.code)
      expect(escalation).not.toBeInstanceOf(PermissionDeniedError)
    })
  })

  describe('cascade-strict revoke (default)', () => {
    it('revokes the full delegation subtree in one call', async () => {
      // Build a 3-level chain: owner → admin-1 → admin-2 → admin-3
      const admin1Db = await createNoydb({ store: adapter, user: 'admin-1', secret: 'admin-1-pass' })
      await admin1Db.grant(COMP, {
        userId: 'admin-2', displayName: 'A2', role: 'admin', passphrase: 'a2',
      })
      const admin2Db = await createNoydb({ store: adapter, user: 'admin-2', secret: 'a2' })
      await admin2Db.grant(COMP, {
        userId: 'admin-3', displayName: 'A3', role: 'admin', passphrase: 'a3',
      })

      // Sanity: all three admin keyrings exist before the revoke.
      const usersBefore = await ownerDb.listUsers(COMP)
      expect(usersBefore.map((u) => u.userId).sort()).toEqual(
        ['admin-1', 'admin-2', 'admin-3', 'owner-01'],
      )

      // Owner revokes admin-1. Cascade defaults to 'strict', so
      // admin-2 and admin-3 should be wiped too.
      await ownerDb.revoke(COMP, { userId: 'admin-1', rotateKeys: false })

      const usersAfter = await ownerDb.listUsers(COMP)
      expect(usersAfter.map((u) => u.userId)).toEqual(['owner-01'])
    })

    it('does not touch admins granted via a different chain', async () => {
      // Build two independent admin chains under the owner:
      //   owner → admin-1 → admin-2
      //   owner → admin-A
      // Revoking admin-1 should remove admin-1 and admin-2, leave admin-A.
      const admin1Db = await createNoydb({ store: adapter, user: 'admin-1', secret: 'admin-1-pass' })
      await admin1Db.grant(COMP, {
        userId: 'admin-2', displayName: 'A2', role: 'admin', passphrase: 'a2',
      })
      await ownerDb.grant(COMP, {
        userId: 'admin-A', displayName: 'AA', role: 'admin', passphrase: 'aa',
      })

      await ownerDb.revoke(COMP, { userId: 'admin-1', rotateKeys: false })

      const users = await ownerDb.listUsers(COMP)
      expect(users.map((u) => u.userId).sort()).toEqual(['admin-A', 'owner-01'])
    })

    it('non-admin descendants in the tree are unaffected by cascade', async () => {
      // admin-1 grants an operator. Revoking admin-1 cascades through
      // admin descendants only — the operator's keyring is left alone
      // (they'd lose access via the rotation pass anyway, but the
      // keyring file itself stays present until manually cleaned up).
      const admin1Db = await createNoydb({ store: adapter, user: 'admin-1', secret: 'admin-1-pass' })
      await admin1Db.grant(COMP, {
        userId: 'op-1', displayName: 'Op', role: 'operator', passphrase: 'op',
        permissions: { invoices: 'rw' },
      })

      await ownerDb.revoke(COMP, { userId: 'admin-1', rotateKeys: false })

      const users = await ownerDb.listUsers(COMP)
      expect(users.map((u) => u.userId).sort()).toEqual(['op-1', 'owner-01'])
    })
  })

  describe('cascade-warn revoke', () => {
    it('leaves descendant admins in place and emits console.warn listing them', async () => {
      const admin1Db = await createNoydb({ store: adapter, user: 'admin-1', secret: 'admin-1-pass' })
      await admin1Db.grant(COMP, {
        userId: 'admin-2', displayName: 'A2', role: 'admin', passphrase: 'a2',
      })
      const admin2Db = await createNoydb({ store: adapter, user: 'admin-2', secret: 'a2' })
      await admin2Db.grant(COMP, {
        userId: 'admin-3', displayName: 'A3', role: 'admin', passphrase: 'a3',
      })

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await ownerDb.revoke(COMP, {
        userId: 'admin-1',
        rotateKeys: false,
        cascade: 'warn',
      })

      // admin-1 is gone, admin-2 and admin-3 are still here.
      const users = await ownerDb.listUsers(COMP)
      expect(users.map((u) => u.userId).sort()).toEqual(
        ['admin-2', 'admin-3', 'owner-01'],
      )

      // The warning lists every orphaned admin by id.
      expect(warnSpy).toHaveBeenCalledOnce()
      const warning = warnSpy.mock.calls[0]![0] as string
      expect(warning).toContain('admin-2')
      expect(warning).toContain('admin-3')
      expect(warning).toContain("cascade='warn'")

      warnSpy.mockRestore()
    })
  })

  describe('owner is unrevocable (rule unchanged)', () => {
    it('a newly-promoted admin via the new delegation path still cannot revoke owner', async () => {
      const admin1Db = await createNoydb({ store: adapter, user: 'admin-1', secret: 'admin-1-pass' })
      await admin1Db.grant(COMP, {
        userId: 'admin-2', displayName: 'A2', role: 'admin', passphrase: 'a2',
      })
      const admin2Db = await createNoydb({ store: adapter, user: 'admin-2', secret: 'a2' })

      await expect(
        admin2Db.revoke(COMP, { userId: 'owner-01' }),
      ).rejects.toThrow(PermissionDeniedError)
    })
  })

  describe('admin can revoke peer admin', () => {
    it('admin-1 revoking admin-2 (peer, both granted by owner) succeeds', async () => {
      await ownerDb.grant(COMP, {
        userId: 'admin-2', displayName: 'A2', role: 'admin', passphrase: 'a2',
      })

      const admin1Db = await createNoydb({ store: adapter, user: 'admin-1', secret: 'admin-1-pass' })
      await expect(
        admin1Db.revoke(COMP, { userId: 'admin-2', rotateKeys: false }),
      ).resolves.not.toThrow()

      const users = await ownerDb.listUsers(COMP)
      expect(users.map((u) => u.userId).sort()).toEqual(['admin-1', 'owner-01'])
    })
  })
})
