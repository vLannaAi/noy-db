/**
 * Integration test — @noy-db/at-macos-keychain as a drop-in
 * SealingKeyProvider for a managed-mode vault.
 *
 * Uses an injected memory-backed KeychainEntry so it runs on every
 * platform without provoking real Keychain prompts. Mirrors the
 * pattern from packages/at-env/__tests__/at-env.test.ts's
 * integration suite.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import type { KeychainEntry } from '../src/index.js'
import { macosKeychainSealingProvider } from '../src/index.js'

function memoryEntry(): KeychainEntry {
  let stored: string | null = null
  return {
    getPassword: () => stored,
    setPassword: (v: string) => { stored = v },
    deletePassword: () => { const had = stored !== null; stored = null; return had },
  }
}

describe('@noy-db/at-macos-keychain — integration with @noy-db/hub managed-passphrase', () => {
  it('round-trips a managed-mode vault end-to-end (no user passphrase typed)', async () => {
    // Shared "Keychain" entry persists across simulated process restarts.
    const sharedEntry = memoryEntry()
    const store = memory()

    // First open — hub mints + seals via at-macos-keychain, derives KEK.
    const db1 = await createNoydb({
      store,
      user: 'alice',
      passphraseMode: 'managed',
      sealingKey: macosKeychainSealingProvider({
        service: 'com.acme.app',
        account: 'alice@acme.example',
        entry: sharedEntry,
      }),
    })
    const vault1 = await db1.openVault('demo')
    await vault1.collection<{ id: string; note: string }>('notes').put('n1', {
      id: 'n1',
      note: 'managed-mode write via at-macos-keychain',
    })
    db1.close()

    // Second open — fresh provider, same shared Keychain entry. Unseal works.
    const db2 = await createNoydb({
      store,
      user: 'alice',
      passphraseMode: 'managed',
      sealingKey: macosKeychainSealingProvider({
        service: 'com.acme.app',
        account: 'alice@acme.example',
        entry: sharedEntry,
      }),
    })
    const vault2 = await db2.openVault('demo')
    const note = await vault2.collection<{ id: string; note: string }>('notes').get('n1')
    expect(note).toEqual({ id: 'n1', note: 'managed-mode write via at-macos-keychain' })
    db2.close()
  })

  it('a different (service, account) creates an isolated vault that cannot read the first', async () => {
    const store = memory()

    // Vault sealed under (com.acme.app, alice) — independent Keychain entry.
    const db1 = await createNoydb({
      store,
      user: 'alice',
      passphraseMode: 'managed',
      sealingKey: macosKeychainSealingProvider({
        service: 'com.acme.app',
        account: 'alice',
        entry: memoryEntry(),
      }),
    })
    const vault1 = await db1.openVault('demo')
    await vault1.collection<{ id: string; note: string }>('notes').put('n1', {
      id: 'n1', note: 'alice-only',
    })
    db1.close()

    // Try to open the SAME vault store under a different provider id.
    // Different account → different pid → hub's resolveManagedSecret
    // rejects the mismatch when openVault triggers it.
    const db2 = await createNoydb({
      store,
      user: 'alice',
      passphraseMode: 'managed',
      sealingKey: macosKeychainSealingProvider({
        service: 'com.acme.app',
        account: 'bob', // different!
        entry: memoryEntry(),
      }),
    })
    await expect(db2.openVault('demo')).rejects.toThrow(/sealed under provider id|provider/i)
    db2.close()
  })

  it('persists across simulated restarts — the vault opens with a brand new provider instance', async () => {
    const sharedEntry = memoryEntry()
    const store = memory()

    const db1 = await createNoydb({
      store,
      user: 'alice',
      passphraseMode: 'managed',
      sealingKey: macosKeychainSealingProvider({
        service: 'com.example.persist',
        account: 'persist-test',
        entry: sharedEntry,
      }),
    })
    const v1 = await db1.openVault('persist')
    await v1.collection<{ id: string; v: number }>('items').put('i1', { id: 'i1', v: 42 })
    db1.close()

    // Verify the Keychain "entry" has a stored key now — this is the
    // first-use generate-on-seal path having fired.
    expect(sharedEntry.getPassword()).not.toBeNull()

    // Restart — fresh provider, same entry.
    const db2 = await createNoydb({
      store,
      user: 'alice',
      passphraseMode: 'managed',
      sealingKey: macosKeychainSealingProvider({
        service: 'com.example.persist',
        account: 'persist-test',
        entry: sharedEntry,
      }),
    })
    const v2 = await db2.openVault('persist')
    const item = await v2.collection<{ id: string; v: number }>('items').get('i1')
    expect(item).toEqual({ id: 'i1', v: 42 })
    db2.close()
  })
})
