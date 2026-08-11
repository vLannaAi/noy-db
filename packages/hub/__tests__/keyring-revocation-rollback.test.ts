/**
 * #1043 probe — can an untrusted store un-revoke a member?
 *
 * Revocation is `store.delete(vault, '_keyring', userId)` followed by an
 * optional `rotateKeys` pass (`with-party/team/keyring.ts:876, 894-895`). The
 * store is untrusted by design, so it can simply DECLINE the delete and keep
 * serving the revoked member's old keyring file. That file is authentic — it
 * still unwraps under the member's own KEK and its canary still verifies — so
 * nothing in `loadKeyring` can tell it is stale. There is no epoch, no
 * signature, no monotonic guard on the roster.
 *
 * These tests record what actually happens, both with key rotation (the
 * default) and without it.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, NoAccessError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withTeam } from '../src/with-party/team/index.js'

interface Doc { secret: string }

/**
 * A store that honours every operation EXCEPT deletion of `_keyring` entries —
 * the single capability a hostile host needs to suppress a revocation.
 */
function hostileStore(): NoydbStore & { suppressedDeletes: string[] } {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const suppressedDeletes: string[] = []
  function gc(v: string, col: string) {
    let vault = data.get(v); if (!vault) { vault = new Map(); data.set(v, vault) }
    let coll = vault.get(col); if (!coll) { coll = new Map(); vault.set(col, coll) }
    return coll
  }
  return {
    suppressedDeletes,
    async get(v, col, id) { return data.get(v)?.get(col)?.get(id) ?? null },
    async put(v, col, id, env, ev) {
      const coll = gc(v, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, col, id) {
      if (col === '_keyring') { suppressedDeletes.push(`${v}/${id}`); return }  // ← the whole attack
      data.get(v)?.get(col)?.delete(id)
    },
    async list(v, col) { const c = data.get(v)?.get(col); return c ? [...c.keys()] : [] },
    async loadAll(v) {
      const vault = data.get(v); const snap: VaultSnapshot = {}
      if (vault) for (const [n, coll] of vault) {
        if (n.startsWith('_')) continue
        const recs: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) recs[id] = e
        snap[n] = recs
      }
      return snap
    },
    async saveAll(v, snap) {
      for (const [n, recs] of Object.entries(snap)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

const VAULT = 'acme'

async function setup() {
  const store = hostileStore()
  const owner = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: 'owner-pass' })
  const vault = await owner.openVault(VAULT)
  await vault.collection<Doc>('docs').put('d1', { secret: 'before-revocation' })
  await owner.grant(VAULT, { userId: 'mallory', displayName: 'M', role: 'operator', secret: 'm-pass', permissions: { docs: 'rw' } })
  return { store, owner }
}

async function readAsMallory(store: NoydbStore, id: string): Promise<string | undefined> {
  const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'mallory', secret: 'm-pass' })
  const vault = await db.openVault(VAULT)
  return (await vault.collection<Doc>('docs').get(id))?.secret
}

describe('#1043 — an untrusted store that suppresses the _keyring delete', () => {
  it('1. baseline: a granted member can read', async () => {
    const { store } = await setup()
    expect(await readAsMallory(store, 'd1')).toBe('before-revocation')
  })

  it('2. rotateKeys: false — revocation is a COMPLETE no-op against a hostile store', async () => {
    const { store, owner } = await setup()

    await owner.revoke(VAULT, { userId: 'mallory', rotateKeys: false })
    expect(store.suppressedDeletes).toContain(`${VAULT}/mallory`)

    // Owner writes new data AFTER the revocation.
    const vault = await owner.openVault(VAULT)
    await vault.collection<Doc>('docs').put('d2', { secret: 'after-revocation' })

    // Without rotation there is no second line of defence: the stale keyring
    // still wraps the live DEK, so the revoked member reads everything —
    // including data written after they were revoked.
    expect(await readAsMallory(store, 'd1')).toBe('before-revocation')
    expect(await readAsMallory(store, 'd2')).toBe('after-revocation')
  })

  it('3. default rotation — how much does re-keying actually contain?', async () => {
    const { store, owner } = await setup()

    await owner.revoke(VAULT, { userId: 'mallory' })
    expect(store.suppressedDeletes).toContain(`${VAULT}/mallory`)

    const vault = await owner.openVault(VAULT)
    await vault.collection<Doc>('docs').put('d2', { secret: 'after-revocation' })

    // The measured result: rotation contains the attack COMPLETELY. The stale
    // keyring holds DEKs that no longer open anything currently stored, so the
    // revoked member is locked out of pre-rotation data too — not merely out of
    // post-rotation writes. Suppressing the delete buys the hostile store
    // nothing here.
    await expect(readAsMallory(store, 'd1')).rejects.toThrow(NoAccessError)
    await expect(readAsMallory(store, 'd2')).rejects.toThrow(NoAccessError)

    // ...and the vault is unharmed for everyone else.
    expect((await vault.collection<Doc>('docs').get('d1'))?.secret).toBe('before-revocation')
    expect((await vault.collection<Doc>('docs').get('d2'))?.secret).toBe('after-revocation')
  })
})
