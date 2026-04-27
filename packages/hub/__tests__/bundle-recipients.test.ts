/**
 * Re-keyed multi-recipient bundle coverage (#301).
 *
 * Verifies the new `exportPassphrase` and `recipients` options on
 * writeNoydbBundle:
 *
 *   - Single-recipient shorthand round-trips with a different
 *     passphrase, reading back the original records under the new
 *     unlock secret.
 *   - Multi-recipient: every supplied recipient becomes a keyring
 *     entry that unlocks independently. The source keyring is gone
 *     from the bundle — the source passphrase no longer works.
 *   - Per-recipient permission scoping: a slot with
 *     `{ invoices: 'ro' }` carries the invoices DEK only, so other
 *     collections stay opaque even though the ciphertext is shipped.
 *   - Mutual exclusion of exportPassphrase + recipients.
 */

import { describe, it, expect } from 'vitest'
import type {
  NoydbStore, EncryptedEnvelope, VaultSnapshot, BundleRecipient,
} from '../src/index.js'
import {
  ConflictError, createNoydb, writeNoydbBundle, readNoydbBundle,
} from '../src/index.js'
import { withHistory } from '../src/history/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const comp = store.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (n.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; amount: number }
interface Payment { id: string; amount: number }

async function setupSourceVault() {
  const db = await createNoydb({
    store: memory(), user: 'alice', secret: 'source-pw-2026',
    historyStrategy: withHistory(),
  })
  const vault = await db.openVault('demo')
  await vault.collection<Invoice>('invoices').put('a', { id: 'a', amount: 100 })
  await vault.collection<Invoice>('invoices').put('b', { id: 'b', amount: 200 })
  await vault.collection<Payment>('payments').put('p', { id: 'p', amount: 100 })
  return { db, vault }
}

/**
 * Restore a bundle into a fresh adapter and unlock with the given
 * passphrase. The bundle's keyrings are sealed under recipient
 * passphrases, not under whatever passphrase a `vault.load()` call
 * would use to re-derive them — so we bypass `load()` and write the
 * bundle's keyrings + collections directly to the adapter, then open
 * a noy-db instance as the recipient. The recipient's `openVault()`
 * reads the keyring file straight from the adapter and unwraps it
 * with the supplied passphrase, exactly the way a real recipient on
 * a different device would.
 */
async function restoreAs(
  bundleBytes: Uint8Array,
  recipientUserId: string,
  recipientPassphrase: string,
): Promise<{ db: Awaited<ReturnType<typeof createNoydb>> }> {
  const { dumpJson } = await readNoydbBundle(bundleBytes)
  const dump = JSON.parse(dumpJson) as {
    _compartment: string
    keyrings: Record<string, unknown>
    collections: Record<string, Record<string, EncryptedEnvelope>>
    _internal?: Record<string, Record<string, EncryptedEnvelope>>
  }
  const compartment = dump._compartment

  const targetStore = memory()

  for (const [userId, kf] of Object.entries(dump.keyrings)) {
    await targetStore.put(compartment, '_keyring', userId, {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '',
      _data: JSON.stringify(kf),
    })
  }
  for (const [collName, records] of Object.entries(dump.collections)) {
    for (const [id, env] of Object.entries(records)) {
      await targetStore.put(compartment, collName, id, env)
    }
  }
  if (dump._internal) {
    for (const [collName, records] of Object.entries(dump._internal)) {
      for (const [id, env] of Object.entries(records)) {
        await targetStore.put(compartment, collName, id, env)
      }
    }
  }

  const db = await createNoydb({
    store: targetStore, user: recipientUserId, secret: recipientPassphrase,
    historyStrategy: withHistory(),
  })
  return { db }
}

describe('writeNoydbBundle — exportPassphrase shorthand (#301)', () => {
  it('single-recipient bundle unlocks with the new passphrase', async () => {
    const { db: src, vault } = await setupSourceVault()
    const bytes = await writeNoydbBundle(vault, { exportPassphrase: 'recipient-pw-2026' })
    src.close()

    const { db } = await restoreAs(bytes, 'alice', 'recipient-pw-2026')
    const restored = await db.openVault('demo')
    const inv = await restored.collection<Invoice>('invoices').get('a')
    expect(inv).toEqual({ id: 'a', amount: 100 })
    db.close()
  })

  it('source passphrase no longer unlocks the re-keyed bundle', async () => {
    const { db: src, vault } = await setupSourceVault()
    const bytes = await writeNoydbBundle(vault, { exportPassphrase: 'recipient-pw-2026' })
    src.close()

    // Try opening with the SOURCE passphrase via restoreAs — must
    // fail at openVault time because the bundle's keyring is sealed
    // for the recipient passphrase, not the source one.
    await expect(
      restoreAs(bytes, 'alice', 'source-pw-2026').then(r => r.db.openVault('demo')),
    ).rejects.toThrow()
  })
})

describe('writeNoydbBundle — multi-recipient (#301)', () => {
  it('every recipient unlocks independently with their own passphrase', async () => {
    const { db: src, vault } = await setupSourceVault()
    const recipients: readonly BundleRecipient[] = [
      { id: 'alice-r', passphrase: 'alice-pw', role: 'viewer' },
      { id: 'bob-r',   passphrase: 'bob-pw',   role: 'viewer' },
    ]
    const bytes = await writeNoydbBundle(vault, { recipients })
    src.close()

    const aliceDb = await restoreAs(bytes, 'alice-r', 'alice-pw')
    const aliceVault = await aliceDb.db.openVault('demo')
    expect(await aliceVault.collection<Invoice>('invoices').get('a'))
      .toEqual({ id: 'a', amount: 100 })
    aliceDb.db.close()

    const bobDb = await restoreAs(bytes, 'bob-r', 'bob-pw')
    const bobVault = await bobDb.db.openVault('demo')
    expect(await bobVault.collection<Invoice>('invoices').get('b'))
      .toEqual({ id: 'b', amount: 200 })
    bobDb.db.close()
  })

  it('per-recipient permission scoping limits the DEKs each slot carries', async () => {
    const { db: src, vault } = await setupSourceVault()
    const recipients: readonly BundleRecipient[] = [
      // 'restricted' gets only invoices — payments DEK must NOT be wrapped.
      { id: 'restricted', passphrase: 'r-pw', role: 'operator',
        permissions: { invoices: 'ro' } },
    ]
    const bytes = await writeNoydbBundle(vault, { recipients })
    src.close()

    const r = await restoreAs(bytes, 'restricted', 'r-pw')
    const rv = await r.db.openVault('demo')

    // Invoices: readable.
    expect(await rv.collection<Invoice>('invoices').get('a'))
      .toEqual({ id: 'a', amount: 100 })

    // Payments: the DEK isn't in this slot's keyring; reading throws.
    await expect(
      rv.collection<Payment>('payments').get('p'),
    ).rejects.toThrow()

    r.db.close()
  })

  it('rejects mutual exclusion of exportPassphrase + recipients', async () => {
    const { db: src, vault } = await setupSourceVault()
    await expect(
      writeNoydbBundle(vault, {
        exportPassphrase: 'pw',
        recipients: [{ id: 'r', passphrase: 'r-pw' }],
      }),
    ).rejects.toThrow(/either exportPassphrase or recipients, not both/)
    src.close()
  })

  it('rejects duplicate recipient ids', async () => {
    const { db: src, vault } = await setupSourceVault()
    await expect(
      writeNoydbBundle(vault, {
        recipients: [
          { id: 'same', passphrase: 'pw1' },
          { id: 'same', passphrase: 'pw2' },
        ],
      }),
    ).rejects.toThrow(/duplicate recipient id/)
    src.close()
  })
})

describe('writeNoydbBundle — recipients compose with slice (#301)', () => {
  // Note on `collections` + `recipients` + history: dropping a whole
  // collection from a vault that has a ledger leaves dangling ledger
  // references, which `vault.load()` rejects via the integrity check.
  // Pruning the ledger alongside the collections drop is a follow-up
  // (the ledger entries are encrypted, so a precise filter requires
  // unwrapping them — out of scope for the metadata-only slice path).
  // For the time being, recipients composes cleanly with the `since`
  // filter (which keeps every collection in place but drops older
  // records), exercised below.
  it('since filter composes with recipient re-key', async () => {
    const { db: src, vault } = await setupSourceVault()
    // Use a cutoff far in the past so every record survives the
    // since filter while still proving the two pipelines compose.
    const bytes = await writeNoydbBundle(vault, {
      since: '2000-01-01T00:00:00Z',
      recipients: [{ id: 'r', passphrase: 'r-pw' }],
    })
    src.close()

    const r = await restoreAs(bytes, 'r', 'r-pw')
    const rv = await r.db.openVault('demo')
    expect(await rv.collection<Invoice>('invoices').get('a'))
      .toEqual({ id: 'a', amount: 100 })
    expect(await rv.collection<Payment>('payments').get('p'))
      .toEqual({ id: 'p', amount: 100 })
    r.db.close()
  })
})
