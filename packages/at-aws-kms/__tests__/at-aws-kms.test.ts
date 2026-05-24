import { describe, it, expect, vi } from 'vitest'
import { awsKmsSealingProvider } from '../src/index.js'

function fakeKmsClient() {
  return {
    send: vi.fn(async (cmd: any) => {
      const name = cmd.constructor.name
      if (name === 'EncryptCommand') {
        const pt: Uint8Array = cmd.input.Plaintext
        const blob = new Uint8Array(4 + pt.length)
        blob.set([1, 2, 3, 4], 0); blob.set(pt, 4)
        return { CiphertextBlob: blob }
      }
      if (name === 'DecryptCommand') {
        const blob: Uint8Array = cmd.input.CiphertextBlob
        return { Plaintext: blob.subarray(4) }
      }
      throw new Error('unexpected command ' + name)
    }),
  }
}

describe('awsKmsSealingProvider', () => {
  it('round-trips a passphrase via injected client', async () => {
    const p = awsKmsSealingProvider({ keyId: 'arn:aws:kms:us-east-1:1:key/abc', client: fakeKmsClient() as any })
    const phrase = new TextEncoder().encode('hunter2-master')
    const sealed = await p.seal(phrase)
    expect(sealed).not.toEqual(phrase)
    expect(await p.unseal(sealed)).toEqual(phrase)
    expect(p.id).toBe('aws-kms:arn:aws:kms:us-east-1:1:key/abc')
  })

  it('unseal throws on a KMS failure', async () => {
    const client = { send: vi.fn(async () => { throw new Error('AccessDenied') }) }
    const p = awsKmsSealingProvider({ keyId: 'k', client: client as any })
    await expect(p.unseal(new Uint8Array(8))).rejects.toThrow()
  })

  it('seal throws when KMS Encrypt returns no CiphertextBlob', async () => {
    const client = { send: vi.fn(async () => ({})) }
    const p = awsKmsSealingProvider({ keyId: 'k', client: client as any })
    await expect(p.seal(new Uint8Array([1, 2, 3]))).rejects.toThrow(/no CiphertextBlob/)
  })

  it('unseal throws when KMS Decrypt returns no Plaintext', async () => {
    const client = { send: vi.fn(async () => ({})) }
    const p = awsKmsSealingProvider({ keyId: 'k', client: client as any })
    await expect(p.unseal(new Uint8Array([1, 2, 3]))).rejects.toThrow(/no Plaintext/)
  })
})

describe('@noy-db/at-aws-kms — integration with @noy-db/hub managed-passphrase mode', () => {
  it('round-trips a managed-mode vault end-to-end using fake KMS client', async () => {
    const { createNoydb } = await import('@noy-db/hub')
    const { memory } = await import('@noy-db/to-memory')
    const { shamirRecoveryProvider } = await import('@noy-db/on-shamir')

    const store = memory()
    const keyId = 'arn:aws:kms:us-east-1:1:key/abc'
    // One shared fake client — deterministic prefix-tag cipher is stateless,
    // so the same instance can seal in db1 and unseal in db2.
    const sharedFake = fakeKmsClient()

    // First open — hub mints + seals via at-aws-kms, derives KEK, and
    // atomically enrolls the strong recovery required for managed-mode vaults.
    const db1 = await createNoydb({
      store, user: 'alice',
      passphraseMode: 'managed',
      sealingKey: awsKmsSealingProvider({ keyId, client: sharedFake as any }),
      shamirRecovery: shamirRecoveryProvider(),
    })
    const { vault: vault1 } = await db1.openVaultAndEnrollRecovery('demo', {
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
    })
    await vault1.collection<{ id: string; note: string }>('notes').put('n1', {
      id: 'n1', note: 'managed-mode write via at-aws-kms',
    })
    db1.close()

    // Second open — fresh db instance, SAME fake client, SAME store.
    // unseal must reconstruct the passphrase so the vault decrypts correctly.
    const db2 = await createNoydb({
      store, user: 'alice',
      passphraseMode: 'managed',
      sealingKey: awsKmsSealingProvider({ keyId, client: sharedFake as any }),
      shamirRecovery: shamirRecoveryProvider(),
    })
    const vault2 = await db2.openVault('demo')
    const note = await vault2.collection<{ id: string; note: string }>('notes').get('n1')
    expect(note).toEqual({ id: 'n1', note: 'managed-mode write via at-aws-kms' })
    db2.close()
  })
})

const RUN_REAL = !!process.env.NOYDB_TEST_AWS_KMS_KEY_ID
describe.skipIf(!RUN_REAL)('awsKmsSealingProvider (real KMS)', () => {
  it('round-trips against real KMS', async () => {
    const p = awsKmsSealingProvider({ keyId: process.env.NOYDB_TEST_AWS_KMS_KEY_ID! })
    const phrase = new TextEncoder().encode('real-key-test')
    expect(await p.unseal(await p.seal(phrase))).toEqual(phrase)
  })
})
