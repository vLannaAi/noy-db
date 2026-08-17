import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, InvalidKeyError, KeyringCorruptError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'

/** Shared memory adapter — persists across createNoydb calls. */
function persistentMemory(): NoydbStore {
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

interface Invoice { amount: number; status: string }

describe('persistence round-trip (simulated page reload)', () => {
  const COMP = 'C101'
  const PASS = 'test-secret-2026'
  const USER = 'owner-01'

  it('second createNoydb with same adapter+secret loads existing keyring and reads records', async () => {
    const adapter = persistentMemory()

    // Session 1: create and write
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 5000, status: 'draft' })
    await comp1.collection<Invoice>('invoices').put('inv-2', { amount: 3000, status: 'paid' })
    db1.close()

    // Session 2: reopen with same credentials (simulates page reload)
    const db2 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp2 = await db2.openVault(COMP)
    const inv1 = await comp2.collection<Invoice>('invoices').get('inv-1')
    const inv2 = await comp2.collection<Invoice>('invoices').get('inv-2')

    expect(inv1).toEqual({ amount: 5000, status: 'draft' })
    expect(inv2).toEqual({ amount: 3000, status: 'paid' })
    db2.close()
  })

  it('second createNoydb with wrong secret throws InvalidKeyError', async () => {
    const adapter = persistentMemory()

    // Session 1: create keyring + add DEK via collection use
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'x' })
    db1.close()

    // Session 2: wrong secret — must throw, NOT silently create new keyring
    const db2 = await createNoydb({ store: adapter, user: USER, secret: 'wrong-secret' })
    await expect(db2.openVault(COMP)).rejects.toThrow(InvalidKeyError)
    db2.close()
  })

  it('issue #6: onInvalidKey: "reset" recovers a stale keyring as a blank vault', async () => {
    // Use a custom adapter that exposes a "partial clear" — wipes all non-keyring
    // collections while keeping the _keyring row, simulating what happens when a
    // user deletes IDB records in DevTools but the keyring survives.
    const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
    function gc(c: string, col: string) {
      let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
      let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
      return coll
    }
    const adapter: NoydbStore = {
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
    // Expose a way to wipe all non-keyring collections for a vault (partial clear).
    function clearDataCollections(vault: string) {
      const comp = store.get(vault)
      if (!comp) return
      for (const colName of [...comp.keys()]) {
        if (!colName.startsWith('_')) comp.delete(colName)
      }
    }

    // Session 1: create vault with secret PASS, write data
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 999, status: 'paid' })
    db1.close()

    // Simulate: user cleared the IDB data records but _keyring row survived.
    clearDataCollections(COMP)

    // Now the user's WebAuthn credential was rotated → different derived secret.
    // Without onInvalidKey: 'reset' this throws InvalidKeyError (stale keyring, wrong key).
    const db2 = await createNoydb({
      store: adapter,
      user: USER,
      secret: 'rotated-secret-from-new-credential',
      onInvalidKey: 'reset',
    })

    // Expected: blank vault — no TamperedError, no InvalidKeyError
    const comp2 = await db2.openVault(COMP)
    expect(await comp2.collection<Invoice>('invoices').list()).toHaveLength(0)
    db2.close()

    // Verify: new session with the rotated secret opens the blank vault correctly
    const db3 = await createNoydb({ store: adapter, user: USER, secret: 'rotated-secret-from-new-credential' })
    const comp3 = await db3.openVault(COMP)
    await comp3.collection<Invoice>('invoices').put('inv-new', { amount: 1, status: 'draft' })
    expect(await comp3.collection<Invoice>('invoices').count()).toBe(1)
    db3.close()
  })

  it('issue #6: onInvalidKey defaults to "error" — wrong secret still throws', async () => {
    const adapter = persistentMemory()

    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    await db1.openVault(COMP)
    db1.close()

    // No onInvalidKey option → default 'error' behavior unchanged
    const db2 = await createNoydb({ store: adapter, user: USER, secret: 'wrong' })
    await expect(db2.openVault(COMP)).rejects.toThrow(InvalidKeyError)
    db2.close()
  })

  it('third session after changeSecret uses new secret correctly', async () => {
    const adapter = persistentMemory()

    // Session 1: create and write
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 7000, status: 'sent' })
    await db1.changeSecret(COMP, 'new-secret', { allowWeakSecret: true })
    db1.close()

    // Session 2: old secret fails
    const db2 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    await expect(db2.openVault(COMP)).rejects.toThrow()
    db2.close()

    // Session 3: new secret works and data is intact
    const db3 = await createNoydb({ store: adapter, user: USER, secret: 'new-secret' })
    const comp3 = await db3.openVault(COMP)
    const inv = await comp3.collection<Invoice>('invoices').get('inv-1')
    expect(inv).toEqual({ amount: 7000, status: 'sent' })
    db3.close()
  })

  it('issue #82: partial DEK corruption throws KeyringCorruptError, NOT onInvalidKey: "reset"', async () => {
    // Build a vault with multiple DEKs (one per collection + system).
    const adapter = persistentMemory()
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'paid' })
    await comp1.collection<Invoice>('payments').put('pay-1', { amount: 50, status: 'cleared' })
    db1.close()

    // Surgically corrupt ONE wrapped DEK in the keyring file. Pick a
    // collection name (any one — they all wrap with AES-KW under the
    // same KEK), replace its base64 ciphertext with garbage of the
    // same length. The other DEKs remain valid.
    const env = await adapter.get(COMP, '_keyring', USER)
    const file = JSON.parse(env!._data) as { deks: Record<string, string> }
    const collNames = Object.keys(file.deks).filter((n) => !n.startsWith('_'))
    const victim = collNames[0]!
    const original = file.deks[victim]!
    file.deks[victim] = Buffer.from(new Uint8Array(original.length).fill(0)).toString('base64').slice(0, original.length)
    await adapter.put(COMP, '_keyring', USER, {
      ...env!,
      _data: JSON.stringify(file),
    })

    // Reload with the CORRECT secret + onInvalidKey: 'reset'. Pre-fix,
    // the loop's first failure threw InvalidKeyError, the reset path fired,
    // and the keyring was destroyed. Post-fix, the partial unwrap is
    // recognized as corruption and KeyringCorruptError is raised — the
    // reset path does NOT fire.
    const db2 = await createNoydb({
      store: adapter,
      user: USER,
      secret: PASS,
      onInvalidKey: 'reset',
    })
    await expect(db2.openVault(COMP)).rejects.toBeInstanceOf(KeyringCorruptError)
    db2.close()

    // The keyring on disk was NOT replaced — opening with a different
    // secret still fails, proving the original keyring survives.
    const db3 = await createNoydb({ store: adapter, user: USER, secret: 'wrong-pass' })
    await expect(db3.openVault(COMP)).rejects.toThrow(InvalidKeyError)
    db3.close()
  })

  it('issue #113: canary distinguishes single-DEK corruption from wrong secret', async () => {
    // Pre-#113 (with #99 only), a keyring with exactly one corrupted DEK
    // could not be distinguished from a wrong secret — both surfaced
    // as InvalidKeyError, and onInvalidKey: 'reset' would silently
    // destroy the user's only DEK. Post-#113, the canary proves the KEK
    // is correct; the corrupted DEK is reported as KeyringCorruptError.
    const adapter = persistentMemory()
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'paid' })
    db1.close()

    const env = await adapter.get(COMP, '_keyring', USER)
    const file = JSON.parse(env!._data) as { deks: Record<string, string>; canary?: string }
    expect(file.canary).toBeDefined() // sanity: canary minted on owner-create
    const original = file.deks['invoices']!
    file.deks['invoices'] = Buffer.from(new Uint8Array(original.length).fill(0))
      .toString('base64')
      .slice(0, original.length)
    await adapter.put(COMP, '_keyring', USER, { ...env!, _data: JSON.stringify(file) })

    // Correct secret + onInvalidKey: 'reset': the canary proves the
    // KEK is right, the corrupt DEK becomes KeyringCorruptError, reset
    // does NOT fire.
    const db2 = await createNoydb({
      store: adapter, user: USER, secret: PASS, onInvalidKey: 'reset',
    })
    await expect(db2.openVault(COMP)).rejects.toBeInstanceOf(KeyringCorruptError)
    db2.close()

    // Wrong secret still throws InvalidKeyError — keyring on disk
    // wasn't reset.
    const dbWrong = await createNoydb({ store: adapter, user: USER, secret: 'wrong-pass' })
    await expect(dbWrong.openVault(COMP)).rejects.toThrow(InvalidKeyError)
    dbWrong.close()
  })

  it('issue #113: canary corruption with intact DEKs surfaces as KeyringCorruptError', async () => {
    const adapter = persistentMemory()
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'paid' })
    db1.close()

    const env = await adapter.get(COMP, '_keyring', USER)
    const file = JSON.parse(env!._data) as { canary?: string }
    expect(file.canary).toBeDefined()
    file.canary = Buffer.from(new Uint8Array(file.canary!.length).fill(0))
      .toString('base64')
      .slice(0, file.canary!.length)
    await adapter.put(COMP, '_keyring', USER, { ...env!, _data: JSON.stringify(file) })

    const db2 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    await expect(db2.openVault(COMP)).rejects.toBeInstanceOf(KeyringCorruptError)
    db2.close()
  })

  // #1096 — this test previously asserted the OPPOSITE: that a canary-less
  // keyring still loaded via the multi-DEK heuristic (issue #113's legacy
  // fallback). That fallback is deleted. Stripping a plaintext field was the
  // store's way to opt out of verification, so absence is now the alarm — and
  // the setup below is the attack, not a compatibility scenario.
  it('#1096: a keyring whose canary was stripped is refused, not fallen back on', async () => {
    const adapter = persistentMemory()
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'paid' })
    db1.close()

    const env = await adapter.get(COMP, '_keyring', USER)
    const file = JSON.parse(env!._data) as Record<string, unknown>
    delete file['canary']
    await adapter.put(COMP, '_keyring', USER, { ...env!, _data: JSON.stringify(file) })

    // The secret is CORRECT and every DEK would unwrap — the refusal is about
    // the missing canary alone.
    const db2 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    await expect(db2.openVault(COMP)).rejects.toMatchObject({
      name: 'KeyringTamperedError',
      details: { userId: USER, reason: 'canary-missing' },
    })
    db2.close()
  })

  it('count and list on fresh instance reflect adapter state', async () => {
    const adapter = persistentMemory()

    // Session 1
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    const invoices1 = comp1.collection<Invoice>('invoices')
    await invoices1.put('inv-1', { amount: 100, status: 'a' })
    await invoices1.put('inv-2', { amount: 200, status: 'b' })
    await invoices1.put('inv-3', { amount: 300, status: 'c' })
    await invoices1.delete('inv-2')
    db1.close()

    // Session 2: fresh instance must reflect the delete
    const db2 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp2 = await db2.openVault(COMP)
    const invoices2 = comp2.collection<Invoice>('invoices')
    const count = await invoices2.count()
    const list = await invoices2.list()
    expect(count).toBe(2)
    expect(list).toHaveLength(2)
    expect(list.find(i => i.status === 'b')).toBeUndefined()
    db2.close()
  })

  it('query() before await returns empty (documents sync cache dependency)', async () => {
    const adapter = persistentMemory()
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp = await db.openVault(COMP)
    const invoices = comp.collection<Invoice>('invoices')
    await invoices.put('inv-1', { amount: 100, status: 'a' })
    db.close()

    // Fresh collection on same adapter — query before any await
    const db2 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp2 = await db2.openVault(COMP)
    const freshInvoices = comp2.collection<Invoice>('invoices')
    const syncResult = freshInvoices.query(() => true)
    expect(syncResult).toEqual([]) // cache not yet hydrated

    const asyncResult = await freshInvoices.list()
    expect(asyncResult).toHaveLength(1)

    const afterHydration = freshInvoices.query(() => true)
    expect(afterHydration).toHaveLength(1)
    db2.close()
  })
})
