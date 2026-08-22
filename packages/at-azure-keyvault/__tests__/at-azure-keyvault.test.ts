import { describe, it, expect } from 'vitest'
import { atAzureKeyvault } from '../src/index.js'

function fakeCrypto() {
  return {
    encrypt: async ({ plaintext }: { algorithm: string; plaintext: Uint8Array }) => {
      const c = new Uint8Array(4 + plaintext.length)
      c.set([7, 7, 7, 7], 0)
      c.set(plaintext, 4)
      return { result: c, algorithm: 'RSA-OAEP-256' as const, keyID: 'fake-key' }
    },
    decrypt: async ({ ciphertext }: { algorithm: string; ciphertext: Uint8Array }) => ({
      result: (ciphertext as Uint8Array).subarray(4),
      algorithm: 'RSA-OAEP-256' as const,
      keyID: 'fake-key',
    }),
  }
}

describe('atAzureKeyvault', () => {
  it('round-trips a secret via injected client', async () => {
    const keyId = 'https://my-vault.vault.azure.net/keys/noydb-sealing/abc123'
    const p = atAzureKeyvault({ keyId, cryptographyClient: fakeCrypto() as any })
    const phrase = new TextEncoder().encode('hunter2-master')
    const sealed = await p.seal(phrase)
    expect(sealed).not.toEqual(phrase)
    expect(await p.unseal(sealed)).toEqual(phrase)
    expect(p.id).toBe(`azure-kv:${keyId}`)
  })

  it('unseal throws on a Key Vault failure', async () => {
    const client = {
      encrypt: async () => { throw new Error('Forbidden') },
      decrypt: async () => { throw new Error('Forbidden') },
    }
    const p = atAzureKeyvault({ keyId: 'k', cryptographyClient: client as any })
    await expect(p.unseal(new Uint8Array(8))).rejects.toThrow()
  })

  it('seal throws when Key Vault encrypt returns no result', async () => {
    const client = {
      encrypt: async () => ({}) as any,
      decrypt: async () => ({}) as any,
    }
    const p = atAzureKeyvault({ keyId: 'k', cryptographyClient: client as any })
    await expect(p.seal(new Uint8Array([1, 2, 3]))).rejects.toThrow(/no result/)
  })

  it('unseal throws when Key Vault decrypt returns no result', async () => {
    const client = {
      encrypt: async () => ({}) as any,
      decrypt: async () => ({}) as any,
    }
    const p = atAzureKeyvault({ keyId: 'k', cryptographyClient: client as any })
    await expect(p.unseal(new Uint8Array([1, 2, 3]))).rejects.toThrow(/no result/)
  })
})

describe('@noy-db/at-azure-keyvault — integration with @noy-db/hub managed-secret mode', () => {
  it('round-trips a managed-mode vault end-to-end using fake Key Vault client', async () => {
    const { createNoydb } = await import('@noy-db/hub')
    const { toMemory } = await import('@noy-db/to-memory')
    const { shamirRecoveryProvider } = await import('@noy-db/on-shamir')

    const store = toMemory()
    const keyId = 'https://my-vault.vault.azure.net/keys/noydb-sealing/abc123'
    // One shared fake client — deterministic prefix-tag cipher is stateless,
    // so the same instance can seal in db1 and unseal in db2.
    const sharedFake = fakeCrypto()

    // First open — hub mints + seals via at-azure-keyvault, derives KEK, and
    // atomically enrolls the strong recovery required for managed-mode vaults.
    const db1 = await createNoydb({
      store, user: 'alice',
      secretMode: 'managed',
      sealingKey: atAzureKeyvault({ keyId, cryptographyClient: sharedFake as any }),
      shamirRecovery: shamirRecoveryProvider(),
    })
    const { vault: vault1 } = await db1.team.openVaultAndEnrollRecovery('demo', {
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
    })
    await vault1.collection<{ id: string; note: string }>('notes').put('n1', {
      id: 'n1', note: 'managed-mode write via at-azure-keyvault',
    })
    db1.close()

    // Second open — fresh db instance, SAME fake client, SAME store.
    // unseal must reconstruct the secret so the vault decrypts correctly.
    const db2 = await createNoydb({
      store, user: 'alice',
      secretMode: 'managed',
      sealingKey: atAzureKeyvault({ keyId, cryptographyClient: sharedFake as any }),
      shamirRecovery: shamirRecoveryProvider(),
    })
    const vault2 = await db2.openVault('demo')
    const note = await vault2.collection<{ id: string; note: string }>('notes').get('n1')
    expect(new Uint8Array(Buffer.from(JSON.stringify(note)))).toEqual(
      new Uint8Array(Buffer.from(JSON.stringify({ id: 'n1', note: 'managed-mode write via at-azure-keyvault' })))
    )
    expect(note).toEqual({ id: 'n1', note: 'managed-mode write via at-azure-keyvault' })
    db2.close()
    // 30s timeout (#564): two full managed-mode opens (600K-PBKDF2 × several)
    // sit near the 5s vitest default when parallel suites compete for CPU.
  }, 30_000)
})

const RUN_REAL = !!process.env.NOYDB_TEST_AZURE_KEY_ID
describe.skipIf(!RUN_REAL)('atAzureKeyvault (real Azure Key Vault)', () => {
  it('round-trips against real Azure Key Vault', async () => {
    const p = atAzureKeyvault({ keyId: process.env.NOYDB_TEST_AZURE_KEY_ID! })
    const phrase = new TextEncoder().encode('real-key-test')
    expect(await p.unseal(await p.seal(phrase))).toEqual(phrase)
  })
})
