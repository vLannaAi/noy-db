/**
 * Offline → online simulation (#927).
 *
 * A REAL `Noydb` instance with a local store AND a sync store
 * (`sync: remote, syncStrategy: withSync()`), exercised through the
 * documented offline-first lifecycle — no hub internals mocked, all
 * observation at the store boundary:
 *
 *  1. offline: writes land in the LOCAL store only — the remote sees
 *     zero bytes until an explicit `db.push()`, and `db.syncStatus()`
 *     counts the un-pushed records as dirty;
 *  2. going online: `db.push(vault)` transfers the envelopes and clears
 *     the dirty counter — and what crosses the wire is the exact local
 *     ciphertext, byte for byte (sync never re-serialises plaintext);
 *  3. a second device (own empty local store, same remote) pulls the
 *     pushed records and reads them back decrypted.
 *
 * Keyring note: the sync engine replicates data envelopes, NOT
 * `_keyring` — provisioning a second device's keyring is a transfer /
 * grant concern outside sync's scope. The harness provisions device B
 * by copying the wrapped-keyring envelope at the store boundary (the
 * moral equivalent of a bundle transfer); B then unwraps it with the
 * same user id + secret.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../../../packages/hub/src/index.js'
import { withSync } from '../../../packages/hub/src/with-sync/index.js'
import { toMemory } from '../../../packages/to-memory/src/index.js'
import type { Noydb } from '../../../packages/hub/src/index.js'
import type { NoydbStore } from '../../../packages/hub/src/kernel/types.js'

const SECRET = 'simulation-offline-online-secret-2026'
const VAULT = 'acme'
const USER = 'owner'

interface Invoice extends Record<string, unknown> { customer: string; amount: number }

async function openDevice(local: NoydbStore, remote: NoydbStore): Promise<Noydb> {
  const db = await createNoydb({
    store: local,
    sync: remote,
    user: USER,
    secret: SECRET,
    syncStrategy: withSync(),
  })
  await db.openVault(VAULT)
  return db
}

describe('simulation: offline-first writes, explicit push, second-device pull', () => {
  let localA: NoydbStore
  let localB: NoydbStore
  let remote: NoydbStore
  let deviceA: Noydb

  beforeEach(async () => {
    localA = toMemory()
    localB = toMemory()
    remote = toMemory()
    deviceA = await openDevice(localA, remote)
  })

  it('writes made offline stay local-only: the remote store receives nothing before push', async () => {
    const invoices = deviceA.vault(VAULT).collection<Invoice>('invoices')
    await invoices.put('inv-001', { customer: 'alpha', amount: 5000 })
    await invoices.put('inv-002', { customer: 'beta', amount: 750 })

    // Local store has both envelopes...
    expect(await localA.get(VAULT, 'invoices', 'inv-001')).not.toBeNull()
    expect(await localA.get(VAULT, 'invoices', 'inv-002')).not.toBeNull()
    // ...the remote has seen NOTHING — offline-first means no implicit sync.
    expect(await remote.get(VAULT, 'invoices', 'inv-001')).toBeNull()
    expect(await remote.get(VAULT, 'invoices', 'inv-002')).toBeNull()
    expect(await remote.list(VAULT, 'invoices')).toEqual([])
    // The un-pushed writes are tracked as dirty.
    expect(deviceA.syncStatus(VAULT).dirty).toBe(2)
    expect(deviceA.syncStatus(VAULT).lastPush).toBeNull()
  })

  it('an explicit push lands the local ciphertext on the remote byte-for-byte and clears dirty', async () => {
    await deviceA.vault(VAULT).collection<Invoice>('invoices').put('inv-001', { customer: 'alpha', amount: 5000 })

    const result = await deviceA.push(VAULT)
    expect(result.pushed).toBe(1)
    expect(result.conflicts).toHaveLength(0)
    expect(deviceA.syncStatus(VAULT).dirty).toBe(0)
    expect(deviceA.syncStatus(VAULT).lastPush).not.toBeNull()

    // The remote copy is the exact local envelope — same IV, same
    // ciphertext — and it IS ciphertext (not parseable as JSON).
    const localEnv = (await localA.get(VAULT, 'invoices', 'inv-001'))!
    const remoteEnv = (await remote.get(VAULT, 'invoices', 'inv-001'))!
    expect(remoteEnv._iv).toBe(localEnv._iv)
    expect(remoteEnv._data).toBe(localEnv._data)
    expect(localEnv._iv.length).toBeGreaterThan(0)
    expect(() => JSON.parse(remoteEnv._data)).toThrow()
  })

  it('a second device with its own local store pulls the pushed records and decrypts them', async () => {
    await deviceA.vault(VAULT).collection<Invoice>('invoices').put('inv-001', { customer: 'alpha', amount: 5000 })
    await deviceA.vault(VAULT).collection<Invoice>('invoices').put('inv-002', { customer: 'beta', amount: 750 })
    await deviceA.push(VAULT)

    // Provision device B's keyring at the store boundary (see header note)
    // BEFORE opening the vault — openVault snapshots the keyring, and an
    // empty local store would mint a fresh (useless) one.
    const keyringEnv = (await localA.get(VAULT, '_keyring', USER))!
    expect(keyringEnv).not.toBeNull()
    await localB.put(VAULT, '_keyring', USER, keyringEnv)

    const deviceB = await openDevice(localB, remote)
    const pulled = await deviceB.pull(VAULT)
    expect(pulled.pulled).toBe(2)

    const invoices = deviceB.vault(VAULT).collection<Invoice>('invoices')
    expect(await invoices.get('inv-001')).toEqual({ customer: 'alpha', amount: 5000 })
    expect(await invoices.get('inv-002')).toEqual({ customer: 'beta', amount: 750 })
  })
})
