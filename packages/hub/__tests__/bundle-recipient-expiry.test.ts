/**
 * Per-recipient `expiresAt` coverage (#306).
 *
 * Bundle slot expiry — each recipient slot can carry an ISO-8601
 * cutoff. Past the timestamp `loadKeyring` throws KeyringExpiredError
 * before any DEK unwrap is attempted.
 */

import { describe, it, expect } from 'vitest'
import type {
  NoydbStore, EncryptedEnvelope, VaultSnapshot, BundleRecipient,
} from '../src/index.js'
import {
  ConflictError, createNoydb, writeNoydbBundle, readNoydbBundle,
  KeyringExpiredError,
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

async function setupSourceVault() {
  const db = await createNoydb({
    store: memory(), user: 'alice', secret: 'source-pw-2026',
    historyStrategy: withHistory(),
  })
  const vault = await db.openVault('demo')
  await vault.collection<Invoice>('invoices').put('a', { id: 'a', amount: 100 })
  return { db, vault }
}

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

describe('writeNoydbBundle — recipient expiresAt (#306)', () => {
  it('past-cutoff slot refuses to open with KeyringExpiredError', async () => {
    const { db: src, vault } = await setupSourceVault()
    const yesterday = new Date(Date.now() - 86400_000).toISOString()
    const recipients: readonly BundleRecipient[] = [
      { id: 'auditor', passphrase: 'aud-pw', role: 'viewer', expiresAt: yesterday },
    ]
    const bytes = await writeNoydbBundle(vault, { recipients })
    src.close()

    const auditor = await restoreAs(bytes, 'auditor', 'aud-pw')
    await expect(auditor.db.openVault('demo')).rejects.toThrow(KeyringExpiredError)
    auditor.db.close()
  })

  it('future-cutoff slot opens normally', async () => {
    const { db: src, vault } = await setupSourceVault()
    const tomorrow = new Date(Date.now() + 86400_000).toISOString()
    const recipients: readonly BundleRecipient[] = [
      { id: 'auditor', passphrase: 'aud-pw', role: 'viewer', expiresAt: tomorrow },
    ]
    const bytes = await writeNoydbBundle(vault, { recipients })
    src.close()

    const auditor = await restoreAs(bytes, 'auditor', 'aud-pw')
    const v = await auditor.db.openVault('demo')
    expect(await v.collection<Invoice>('invoices').get('a')).toEqual({ id: 'a', amount: 100 })
    auditor.db.close()
  })

  it('omitted expiresAt = no cutoff (existing behavior unchanged)', async () => {
    const { db: src, vault } = await setupSourceVault()
    const recipients: readonly BundleRecipient[] = [
      { id: 'auditor', passphrase: 'aud-pw', role: 'viewer' },
    ]
    const bytes = await writeNoydbBundle(vault, { recipients })
    src.close()

    const auditor = await restoreAs(bytes, 'auditor', 'aud-pw')
    const v = await auditor.db.openVault('demo')
    expect(await v.collection<Invoice>('invoices').get('a')).toEqual({ id: 'a', amount: 100 })
    auditor.db.close()
  })

  it('expired error carries the userId and ISO timestamp', async () => {
    const { db: src, vault } = await setupSourceVault()
    const yesterday = new Date(Date.now() - 86400_000).toISOString()
    const recipients: readonly BundleRecipient[] = [
      { id: 'auditor', passphrase: 'aud-pw', role: 'viewer', expiresAt: yesterday },
    ]
    const bytes = await writeNoydbBundle(vault, { recipients })
    src.close()

    const auditor = await restoreAs(bytes, 'auditor', 'aud-pw')
    try {
      await auditor.db.openVault('demo')
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(KeyringExpiredError)
      const err = e as KeyringExpiredError
      expect(err.userId).toBe('auditor')
      expect(err.expiresAt).toBe(yesterday)
    }
    auditor.db.close()
  })
})
