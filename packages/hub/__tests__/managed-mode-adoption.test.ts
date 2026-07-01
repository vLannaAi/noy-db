/**
 * Managed-mode adoption (#208 follow-up) — Plan 10. The recipient owner is
 * minted in managed mode (passphrase sealed under a SealingKeyProvider) with
 * mandatory strong (Shamir) recovery (#195), so the partition auto-unlocks on
 * the recipient's device.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { ConflictError } from '../src/kernel/errors.js'
import { MemorySealingKeyProvider } from '../src/with-party/team/managed-passphrase.js'
import { shamirRecoveryProvider } from '@noy-db/on-shamir'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { extractPartition } from '../src/with-cargo/extract-partition.js'
import { adoptPartition, createOwnerOnAdoptedPartition } from '../src/with-cargo/adopt-partition.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
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
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Client { id: string; name: string; operatorUserId: string }

async function extractAndAdopt() {
  const db = await createNoydb({ store: memory(), user: 'alice', secret: 'alice-2026' })
  const company = await db.openVault('demo-co')
  await company.collection<Client>('clients').put('c-1', { id: 'c-1', name: 'Hotel', operatorUserId: 'belle' })
  const { bundleBytes, transferKey } = await extractPartition(company, { seeds: { clients: () => true } })

  const dest = memory()
  await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'acme' })
  return { dest, transferKey }
}

describe('managed-mode adoption', () => {
  it('mints a managed owner (sealed passphrase + Shamir recovery); recipient auto-unlocks', async () => {
    const { dest, transferKey } = await extractAndAdopt()
    const provider = new MemorySealingKeyProvider({ id: 'belle-keychain' })

    const result = await createOwnerOnAdoptedPartition(dest, 'acme', {
      userId: 'belle',
      passphraseMode: 'managed',
      sealingKey: provider,
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
      shamirRecovery: shamirRecoveryProvider(),
      transferKey,
    })
    expect(result).toEqual({ vaultName: 'acme', userId: 'belle' })

    // The sealed passphrase is persisted; the recipient opens with NO passphrase
    // — just the same sealing provider (the at-* auto-unlock #198 motivates).
    expect(await dest.get('acme', '_meta', 'sealed-passphrase')).toBeTruthy()
    const belleDb = await createNoydb({
      store: dest, user: 'belle', passphraseMode: 'managed',
      sealingKey: provider, shamirRecovery: shamirRecoveryProvider(),
    })
    const vault = await belleDb.openVault('acme')
    expect(await vault.collection<Client>('clients').get('c-1')).toMatchObject({ id: 'c-1', name: 'Hotel' })
  })

  it('rejects managed adoption without a strong (shamir) recovery profile', async () => {
    const { dest, transferKey } = await extractAndAdopt()
    await expect(
      createOwnerOnAdoptedPartition(dest, 'acme', {
        userId: 'belle',
        passphraseMode: 'managed',
        sealingKey: new MemorySealingKeyProvider({ id: 'belle-keychain' }),
        recovery: [{ profile: 'paper', entries: [] }], // paper alone is not strong
        shamirRecovery: shamirRecoveryProvider(),
        transferKey,
      }),
    ).rejects.toThrow(/shamir|strong/)
  })

  it('is idempotent under retry when recovery enrollment fails mid-ceremony', async () => {
    const { dest, transferKey } = await extractAndAdopt()
    const provider = new MemorySealingKeyProvider({ id: 'belle-keychain' })
    const real = shamirRecoveryProvider()

    // Inject a one-shot outage into the recovery-enrollment step (which runs
    // AFTER the keyring is minted and the seal is destroyed in the buggy order).
    let splitCalls = 0
    const flaky = {
      splitToShares(secret: Uint8Array, k: number, n: number) {
        if (splitCalls++ === 0) throw new Error('injected provider outage')
        return real.splitToShares(secret, k, n)
      },
      combineShares: (shares: readonly string[]) => real.combineShares(shares),
    }

    const opts = {
      userId: 'belle' as const,
      passphraseMode: 'managed' as const,
      sealingKey: provider,
      recovery: [{ profile: 'shamir' as const, k: 2, n: 3 }],
      shamirRecovery: flaky,
      transferKey,
    }

    // First attempt fails inside recovery enrollment.
    await expect(createOwnerOnAdoptedPartition(dest, 'acme', opts)).rejects.toThrow(/injected provider outage/)

    // Retry must RESUME and complete — not reject because the seal was
    // prematurely consumed before enrollment on the first attempt.
    const result = await createOwnerOnAdoptedPartition(dest, 'acme', opts)
    expect(result).toEqual({ vaultName: 'acme', userId: 'belle' })

    // Recovery is now enrolled and the partition auto-unlocks for the recipient.
    const belleDb = await createNoydb({
      store: dest, user: 'belle', passphraseMode: 'managed',
      sealingKey: provider, shamirRecovery: real,
    })
    const vault = await belleDb.openVault('acme')
    expect(await vault.collection<Client>('clients').get('c-1')).toMatchObject({ id: 'c-1', name: 'Hotel' })
  })

  it('refuses a different owner on a partition half-owned by another user', async () => {
    const { dest, transferKey } = await extractAndAdopt()
    const real = shamirRecoveryProvider()
    let splitCalls = 0
    const flaky = {
      splitToShares(secret: Uint8Array, k: number, n: number) {
        if (splitCalls++ === 0) throw new Error('injected provider outage')
        return real.splitToShares(secret, k, n)
      },
      combineShares: (shares: readonly string[]) => real.combineShares(shares),
    }

    // Belle mints the keyring but enrollment fails — the seal stays unconsumed,
    // leaving the partition half-owned by belle.
    await expect(
      createOwnerOnAdoptedPartition(dest, 'acme', {
        userId: 'belle',
        passphraseMode: 'managed',
        sealingKey: new MemorySealingKeyProvider({ id: 'belle-keychain' }),
        recovery: [{ profile: 'shamir', k: 2, n: 3 }],
        shamirRecovery: flaky,
        transferKey,
      }),
    ).rejects.toThrow(/injected provider outage/)

    // Carol cannot claim the same adopted partition while belle's keyring is present.
    await expect(
      createOwnerOnAdoptedPartition(dest, 'acme', { userId: 'carol', passphrase: 'carol-2026', transferKey }),
    ).rejects.toThrow(/different owner/)
  })

  it('still supports the standard passphrase arm unchanged', async () => {
    const { dest, transferKey } = await extractAndAdopt()
    const result = await createOwnerOnAdoptedPartition(dest, 'acme', {
      userId: 'belle', passphrase: 'belle-2026', transferKey,
    })
    expect(result).toEqual({ vaultName: 'acme', userId: 'belle' })
    expect(await dest.get('acme', '_meta', 'sealed-passphrase')).toBeNull() // no sealing in standard mode
  })
})
