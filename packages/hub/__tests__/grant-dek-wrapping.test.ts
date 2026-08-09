/**
 * #1004 — `grant()` produced a keyring slot whose holder authenticates
 * successfully and then fails EVERY read with `TamperedError`.
 *
 * Three distinct defects sat behind the one symptom:
 *
 *  1. A DEK miss MINTED a fresh DEK (`ensureCollectionDEK`) even when the
 *     collection already existed. Decrypting real ciphertext with a brand
 *     new key fails the AES-GCM tag, so a plain authorization gap surfaced
 *     as the tamper alarm — the signal reserved for actual ciphertext
 *     corruption. It must be `NoAccessError`.
 *  2. `grant({ permissions: { invoices: 'rw' } })` issued BEFORE `invoices`
 *     existed wrapped nothing (the grantor had no DEK to wrap yet) and
 *     nothing ever back-filled it. Re-wrapping later is impossible — it
 *     needs the grantee's KEK, which is derived from a secret the vault
 *     never stores — so the DEK has to exist AT grant time.
 *  3. `grant()` accepted `secret: undefined` and returned a slot, deriving
 *     a KEK from a non-secret. The damage only showed up when a different
 *     user tried to unlock, arbitrarily later.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, NoAccessError, TamperedError, ValidationError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withTeam } from '../src/with-party/team/index.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

interface Thing extends Record<string, unknown> { id: string; n: number }

const VAULT = 'niwat'

async function ownerWithSeed(store: NoydbStore) {
  const db = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
  const vault = await db.openVault(VAULT)
  await vault.collection<Thing>('things').put('t1', { id: 't1', n: 1 })
  return db
}

describe('#1004 — grant() DEK wrapping', () => {
  describe('a DEK miss on an existing collection is denied, not re-keyed', () => {
    it('raises NoAccessError (not TamperedError) for an operator granted no collections', async () => {
      const store = inlineMemory()
      const owner = await ownerWithSeed(store)
      await owner.grant(VAULT, {
        userId: 'belle', displayName: 'Belle', role: 'operator',
        secret: 'belle-secret-2026', allowWeakSecret: true,
      })

      const belle = await createNoydb({ store, user: 'belle', secret: 'belle-secret-2026', teamStrategy: withTeam() })
      const vault = await belle.openVault(VAULT)

      await expect(vault.collection<Thing>('things').list()).rejects.toThrow(NoAccessError)
      await expect(vault.collection<Thing>('things').list()).rejects.not.toThrow(TamperedError)
    })

    it('raises NoAccessError for a client granted no collections', async () => {
      const store = inlineMemory()
      const owner = await ownerWithSeed(store)
      await owner.grant(VAULT, {
        userId: 'carl', displayName: 'Carl', role: 'client',
        secret: 'carl-secret-2026', allowWeakSecret: true,
      })

      const carl = await createNoydb({ store, user: 'carl', secret: 'carl-secret-2026', teamStrategy: withTeam() })
      const vault = await carl.openVault(VAULT)
      await expect(vault.collection<Thing>('things').get('t1')).rejects.toThrow(NoAccessError)
    })

    it('does not re-key: the owner still reads the collection after a denied access attempt', async () => {
      const store = inlineMemory()
      const owner = await ownerWithSeed(store)
      await owner.grant(VAULT, {
        userId: 'belle', displayName: 'Belle', role: 'operator',
        secret: 'belle-secret-2026', allowWeakSecret: true,
      })
      const belle = await createNoydb({ store, user: 'belle', secret: 'belle-secret-2026', teamStrategy: withTeam() })
      await expect((await belle.openVault(VAULT)).collection<Thing>('things').list())
        .rejects.toThrow(NoAccessError)

      const reread = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
      const rows = await (await reread.openVault(VAULT)).collection<Thing>('things').list()
      expect(rows).toEqual([{ id: 't1', n: 1 }])
    })

    it('still mints a DEK for a genuinely new collection', async () => {
      const store = inlineMemory()
      const owner = await ownerWithSeed(store)
      const vault = await owner.openVault(VAULT)
      await expect(vault.collection<Thing>('brand-new').put('x', { id: 'x', n: 9 })).resolves.not.toThrow()
      expect(await vault.collection<Thing>('brand-new').list()).toEqual([{ id: 'x', n: 9 }])
    })
  })

  describe('permission-scoped roles receive the DEKs they were granted', () => {
    it('an operator granted { things: rw } can read, when granted AFTER the collection exists', async () => {
      const store = inlineMemory()
      const owner = await ownerWithSeed(store)
      await owner.grant(VAULT, {
        userId: 'belle', displayName: 'Belle', role: 'operator',
        secret: 'belle-secret-2026', allowWeakSecret: true, permissions: { things: 'rw' },
      })

      const belle = await createNoydb({ store, user: 'belle', secret: 'belle-secret-2026', teamStrategy: withTeam() })
      const rows = await (await belle.openVault(VAULT)).collection<Thing>('things').list()
      expect(rows).toEqual([{ id: 't1', n: 1 }])
    })

    it('an operator granted { things: rw } can read, when granted BEFORE the collection exists', async () => {
      const store = inlineMemory()
      const owner = await createNoydb({ store, user: 'ann', secret: 'ann-secret-2026', teamStrategy: withTeam() })
      const vault = await owner.openVault(VAULT)

      // Grant first — `things` does not exist yet.
      await owner.grant(VAULT, {
        userId: 'belle', displayName: 'Belle', role: 'operator',
        secret: 'belle-secret-2026', allowWeakSecret: true, permissions: { things: 'rw' },
      })
      await vault.collection<Thing>('things').put('t1', { id: 't1', n: 1 })

      const belle = await createNoydb({ store, user: 'belle', secret: 'belle-secret-2026', teamStrategy: withTeam() })
      const rows = await (await belle.openVault(VAULT)).collection<Thing>('things').list()
      expect(rows).toEqual([{ id: 't1', n: 1 }])
    })

    it('the grantee reads ONLY the granted collection — an unrelated one is still denied', async () => {
      const store = inlineMemory()
      const owner = await ownerWithSeed(store)
      await (await owner.openVault(VAULT)).collection<Thing>('secrets').put('s1', { id: 's1', n: 42 })
      await owner.grant(VAULT, {
        userId: 'belle', displayName: 'Belle', role: 'operator',
        secret: 'belle-secret-2026', allowWeakSecret: true, permissions: { things: 'rw' },
      })

      const belle = await createNoydb({ store, user: 'belle', secret: 'belle-secret-2026', teamStrategy: withTeam() })
      const vault = await belle.openVault(VAULT)
      expect(await vault.collection<Thing>('things').list()).toEqual([{ id: 't1', n: 1 }])
      await expect(vault.collection<Thing>('secrets').list()).rejects.toThrow(NoAccessError)
    })

    it('admin, viewer and custodian keep whole-vault read access', async () => {
      for (const role of ['admin', 'viewer', 'custodian'] as const) {
        const store = inlineMemory()
        const owner = await ownerWithSeed(store)
        await owner.grant(VAULT, {
          userId: 'u', displayName: 'U', role,
          secret: 'u-secret-2026', allowWeakSecret: true,
        })
        const other = await createNoydb({ store, user: 'u', secret: 'u-secret-2026', teamStrategy: withTeam() })
        const rows = await (await other.openVault(VAULT)).collection<Thing>('things').list()
        expect(rows, `role ${role}`).toEqual([{ id: 't1', n: 1 }])
      }
    })
  })

  describe('grant() refuses to mint a slot from a non-secret', () => {
    it('throws ValidationError when `secret` is missing', async () => {
      const store = inlineMemory()
      const owner = await ownerWithSeed(store)
      await expect(
        owner.grant(VAULT, {
          userId: 'eve', displayName: 'Eve', role: 'operator', allowWeakSecret: true,
        } as unknown as Parameters<typeof owner.grant>[1]),
      ).rejects.toThrow(ValidationError)
    })

    it('throws ValidationError when `secret` is an empty or whitespace string', async () => {
      const store = inlineMemory()
      const owner = await ownerWithSeed(store)
      for (const secret of ['', '   ']) {
        await expect(
          owner.grant(VAULT, {
            userId: 'eve', displayName: 'Eve', role: 'operator', secret, allowWeakSecret: true,
          }),
        ).rejects.toThrow(ValidationError)
      }
    })

    it('leaves no keyring slot behind when it refuses', async () => {
      const store = inlineMemory()
      const owner = await ownerWithSeed(store)
      await expect(
        owner.grant(VAULT, {
          userId: 'eve', displayName: 'Eve', role: 'operator', secret: '', allowWeakSecret: true,
        }),
      ).rejects.toThrow(ValidationError)
      expect(await store.list(VAULT, '_keyring')).not.toContain('eve')
    })
  })
})
