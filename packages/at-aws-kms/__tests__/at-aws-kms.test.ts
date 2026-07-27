import { describe, it, expect, vi } from 'vitest'
import { awsKmsSealingProvider, awsKmsRecipientSealer } from '../src/index.js'

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
  it('round-trips a secret via injected client', async () => {
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

describe('@noy-db/at-aws-kms — integration with @noy-db/hub managed-secret mode', () => {
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
      secretMode: 'managed',
      sealingKey: awsKmsSealingProvider({ keyId, client: sharedFake as any }),
      shamirRecovery: shamirRecoveryProvider(),
    })
    const { vault: vault1 } = await db1.team.openVaultAndEnrollRecovery('demo', {
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
    })
    await vault1.collection<{ id: string; note: string }>('notes').put('n1', {
      id: 'n1', note: 'managed-mode write via at-aws-kms',
    })
    db1.close()

    // Second open — fresh db instance, SAME fake client, SAME store.
    // unseal must reconstruct the secret so the vault decrypts correctly.
    const db2 = await createNoydb({
      store, user: 'alice',
      secretMode: 'managed',
      sealingKey: awsKmsSealingProvider({ keyId, client: sharedFake as any }),
      shamirRecovery: shamirRecoveryProvider(),
    })
    const vault2 = await db2.openVault('demo')
    const note = await vault2.collection<{ id: string; note: string }>('notes').get('n1')
    expect(note).toEqual({ id: 'n1', note: 'managed-mode write via at-aws-kms' })
    db2.close()
    // 30s timeout (#564): two full managed-mode opens (600K-PBKDF2 × several)
    // sit near the 5s vitest default when parallel suites compete for CPU.
  }, 30_000)
})

const RUN_REAL = !!process.env.NOYDB_TEST_AWS_KMS_KEY_ID
describe.skipIf(!RUN_REAL)('awsKmsSealingProvider (real KMS)', () => {
  it('round-trips against real KMS', async () => {
    const p = awsKmsSealingProvider({ keyId: process.env.NOYDB_TEST_AWS_KMS_KEY_ID! })
    const phrase = new TextEncoder().encode('real-key-test')
    expect(await p.unseal(await p.seal(phrase))).toEqual(phrase)
  })
})

// ─── awsKmsRecipientSealer (asymmetric RSA KMS key) ────────────────────────

/**
 * Fake KMS client backed by a real local RSA-2048 keypair. Answers
 * `GetPublicKey` with the keypair's DER SPKI and `Decrypt` (RSAES_OAEP_SHA_256)
 * by doing a local WebCrypto RSA-OAEP-SHA256 decrypt of the CiphertextBlob —
 * exactly what real KMS does for an asymmetric ENCRYPT_DECRYPT key.
 */
async function fakeAsymmetricKmsClient(opts?: { keyUsage?: string; keySpec?: string }) {
  const keypair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt'],
  )
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keypair.publicKey))
  const send = vi.fn(async (cmd: any) => {
    const name = cmd.constructor.name
    if (name === 'GetPublicKeyCommand') {
      return {
        KeyUsage: opts?.keyUsage ?? 'ENCRYPT_DECRYPT',
        KeySpec: opts?.keySpec ?? 'RSA_2048',
        PublicKey: spki,
      }
    }
    if (name === 'DecryptCommand') {
      expect(cmd.input.EncryptionAlgorithm).toBe('RSAES_OAEP_SHA_256')
      const wrapped: Uint8Array = cmd.input.CiphertextBlob
      const cek = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, keypair.privateKey, wrapped as BufferSource))
      return { Plaintext: cek }
    }
    throw new Error('unexpected command ' + name)
  })
  return { client: { send }, send, keypair, spki }
}

describe('awsKmsRecipientSealer', () => {
  it('round-trips: publishRecipientHint → sealForRecipient → unseal (seal makes NO KMS call)', async () => {
    const { client, send } = await fakeAsymmetricKmsClient()
    const sealer = awsKmsRecipientSealer({ keyId: 'arn:aws:kms:us-east-1:1:key/rsa', client: client as any })
    expect(sealer.id).toBe('aws-kms-recipient:arn:aws:kms:us-east-1:1:key/rsa')

    const hint = await sealer.publishRecipientHint()
    expect(hint.v).toBe(1)
    expect(hint.alg).toBe('rsa-oaep-sha256')
    expect(hint.pid).toBe(sealer.id)
    expect(hint.material['publicKeyPem']).toMatch(/^-----BEGIN PUBLIC KEY-----/)

    const callsAfterPublish = send.mock.calls.length // 1 (GetPublicKey)
    const plaintext = new TextEncoder().encode('seal-me-to-kms')
    const sealed = await sealer.sealForRecipient(plaintext, hint)
    // No KMS call on the seal path.
    expect(send.mock.calls.length).toBe(callsAfterPublish)

    const opened = await sealer.unseal(sealed)
    expect(opened).toEqual(plaintext)
    // unseal issued exactly one DecryptCommand.
    expect(send.mock.calls.some(([c]: any[]) => c.constructor.name === 'DecryptCommand')).toBe(true)
  })

  it('cross-sealer: MemoryRecipientSealer-sealed blob (to the KMS hint key) unseals via the KMS path', async () => {
    const { MemoryRecipientSealer } = await import('@noy-db/hub')
    const { client } = await fakeAsymmetricKmsClient()
    const sealer = awsKmsRecipientSealer({ keyId: 'k-rsa', client: client as any })
    const hint = await sealer.publishRecipientHint()

    const memSender = new MemoryRecipientSealer({ id: 'mem-sender' })
    const plaintext = new TextEncoder().encode('wire-format-identity')
    const sealed = await memSender.sealForRecipient(plaintext, hint)

    expect(await sealer.unseal(sealed)).toEqual(plaintext)
  })

  it('cross-sealer: at-aws-kms-sealed blob (to a Memory recipient key) unseals via MemoryRecipientSealer', async () => {
    const { MemoryRecipientSealer } = await import('@noy-db/hub')
    const { client } = await fakeAsymmetricKmsClient()
    const sealer = awsKmsRecipientSealer({ keyId: 'k-rsa', client: client as any })

    const memRecipient = new MemoryRecipientSealer({ id: 'mem-recipient' })
    const memHint = await memRecipient.publishRecipientHint()
    const plaintext = new TextEncoder().encode('reverse-interop')
    const sealed = await sealer.sealForRecipient(plaintext, memHint)

    expect(await memRecipient.unseal(sealed)).toEqual(plaintext)
  })

  it('sealForRecipient throws on a wrong hint.alg', async () => {
    const { client } = await fakeAsymmetricKmsClient()
    const sealer = awsKmsRecipientSealer({ keyId: 'k', client: client as any })
    const hint = await sealer.publishRecipientHint()
    await expect(sealer.sealForRecipient(new Uint8Array([1]), { ...hint, alg: 'aes-gcm' as any }))
      .rejects.toThrow(/unsupported hint.alg/)
  })

  it('sealForRecipient throws on a wrong hint.v', async () => {
    const { client } = await fakeAsymmetricKmsClient()
    const sealer = awsKmsRecipientSealer({ keyId: 'k', client: client as any })
    const hint = await sealer.publishRecipientHint()
    await expect(sealer.sealForRecipient(new Uint8Array([1]), { ...hint, v: 2 as any }))
      .rejects.toThrow(/unsupported hint.v/)
  })

  it('publishRecipientHint throws when the key is not ENCRYPT_DECRYPT', async () => {
    const { client } = await fakeAsymmetricKmsClient({ keyUsage: 'SIGN_VERIFY' })
    const sealer = awsKmsRecipientSealer({ keyId: 'k-sign', client: client as any })
    await expect(sealer.publishRecipientHint()).rejects.toThrow(/ENCRYPT_DECRYPT/)
  })

  it('publishRecipientHint throws when the key is not an RSA key spec', async () => {
    const { client } = await fakeAsymmetricKmsClient({ keySpec: 'ECC_NIST_P256' })
    const sealer = awsKmsRecipientSealer({ keyId: 'k-ecc', client: client as any })
    await expect(sealer.publishRecipientHint()).rejects.toThrow(/RSA key/)
  })
})

const RUN_REAL_RSA = !!process.env.NOYDB_TEST_KMS_RSA_KEY_ID
describe.skipIf(!RUN_REAL_RSA)('awsKmsRecipientSealer (real KMS asymmetric RSA key)', () => {
  it('real GetPublicKey + local seal + real Decrypt round-trip', async () => {
    const sealer = awsKmsRecipientSealer({ keyId: process.env.NOYDB_TEST_KMS_RSA_KEY_ID! })
    const hint = await sealer.publishRecipientHint()
    const plaintext = new TextEncoder().encode('real-rsa-recipient-test')
    const sealed = await sealer.sealForRecipient(plaintext, hint)
    expect(await sealer.unseal(sealed)).toEqual(plaintext)
  })
})
