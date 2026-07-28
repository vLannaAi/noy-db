import { describe, it, expect } from 'vitest'
import { gcpKmsSealingProvider } from '../src/index.js'

function fakeKms() {
  return {
    encrypt: async (req: { name?: string | null; plaintext?: Uint8Array | string | null }) => {
      const pt = req.plaintext as Uint8Array
      const c = new Uint8Array(4 + pt.length)
      c.set([9, 9, 9, 9], 0)
      c.set(pt, 4)
      return [{ ciphertext: c }] as [{ ciphertext: Uint8Array }, undefined, undefined]
    },
    decrypt: async (req: { name?: string | null; ciphertext?: Uint8Array | string | null }) => {
      const ct = req.ciphertext as Uint8Array
      return [{ plaintext: ct.subarray(4) }] as [{ plaintext: Uint8Array }, undefined, undefined]
    },
  }
}

describe('gcpKmsSealingProvider', () => {
  it('round-trips a secret via injected client', async () => {
    const keyName = 'projects/my-project/locations/global/keyRings/ring/cryptoKeys/key'
    const p = gcpKmsSealingProvider({ keyName, client: fakeKms() as any })
    const phrase = new TextEncoder().encode('hunter2-master')
    const sealed = await p.seal(phrase)
    expect(sealed).not.toEqual(phrase)
    expect(await p.unseal(sealed)).toEqual(phrase)
    expect(p.id).toBe(`gcp-kms:${keyName}`)
  })

  it('unseal throws on a KMS failure', async () => {
    const client = {
      encrypt: async () => { throw new Error('PermissionDenied') },
      decrypt: async () => { throw new Error('PermissionDenied') },
    }
    const p = gcpKmsSealingProvider({ keyName: 'k', client: client as any })
    await expect(p.unseal(new Uint8Array(8))).rejects.toThrow()
  })

  it('seal throws when KMS encrypt returns no ciphertext', async () => {
    const client = {
      encrypt: async () => [{}] as [Record<string, never>, undefined, undefined],
      decrypt: async () => [{}] as [Record<string, never>, undefined, undefined],
    }
    const p = gcpKmsSealingProvider({ keyName: 'k', client: client as any })
    await expect(p.seal(new Uint8Array([1, 2, 3]))).rejects.toThrow(/no ciphertext/)
  })

  it('unseal throws when KMS decrypt returns no plaintext', async () => {
    const client = {
      encrypt: async () => [{}] as [Record<string, never>, undefined, undefined],
      decrypt: async () => [{}] as [Record<string, never>, undefined, undefined],
    }
    const p = gcpKmsSealingProvider({ keyName: 'k', client: client as any })
    await expect(p.unseal(new Uint8Array([1, 2, 3]))).rejects.toThrow(/no plaintext/)
  })

  it('handles base64-string responses from GCP (real-REST shape)', async () => {
    const toB64 = (u: Uint8Array) => Buffer.from(u).toString('base64')
    const stringFake = {
      encrypt: async (req: any) => {
        const pt: Uint8Array = req.plaintext
        const c = new Uint8Array(4 + pt.length); c.set([9, 9, 9, 9], 0); c.set(pt, 4)
        return [{ ciphertext: toB64(c) }]            // <-- base64 STRING, not Uint8Array
      },
      decrypt: async (req: any) => {
        // req.ciphertext is a Uint8Array (what seal returned, normalized); strip prefix, return as base64 string
        const blob: Uint8Array = req.ciphertext
        return [{ plaintext: toB64(blob.subarray(4)) }]   // <-- base64 STRING
      },
    }
    const p = gcpKmsSealingProvider({ keyName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k', client: stringFake as any })
    const phrase = new TextEncoder().encode('hunter2-string-path')
    const sealed = await p.seal(phrase)
    expect(sealed).toBeInstanceOf(Uint8Array)
    expect(new Uint8Array(await p.unseal(sealed))).toEqual(phrase)
  })
})

describe('@noy-db/at-gcp-kms — integration with @noy-db/hub managed-secret mode', () => {
  it('round-trips a managed-mode vault end-to-end using fake KMS client', async () => {
    const { createNoydb } = await import('@noy-db/hub')
    const { toMemory } = await import('@noy-db/to-memory')
    const { shamirRecoveryProvider } = await import('@noy-db/on-shamir')

    const store = toMemory()
    const keyName = 'projects/my-project/locations/global/keyRings/ring/cryptoKeys/key'
    // One shared fake client — deterministic prefix-tag cipher is stateless,
    // so the same instance can seal in db1 and unseal in db2.
    const sharedFake = fakeKms()

    // First open — hub mints + seals via at-gcp-kms, derives KEK, and
    // atomically enrolls the strong recovery required for managed-mode vaults.
    const db1 = await createNoydb({
      store, user: 'alice',
      secretMode: 'managed',
      sealingKey: gcpKmsSealingProvider({ keyName, client: sharedFake as any }),
      shamirRecovery: shamirRecoveryProvider(),
    })
    const { vault: vault1 } = await db1.team.openVaultAndEnrollRecovery('demo', {
      recovery: [{ profile: 'shamir', k: 2, n: 3 }],
    })
    await vault1.collection<{ id: string; note: string }>('notes').put('n1', {
      id: 'n1', note: 'managed-mode write via at-gcp-kms',
    })
    db1.close()

    // Second open — fresh db instance, SAME fake client, SAME store.
    // unseal must reconstruct the secret so the vault decrypts correctly.
    const db2 = await createNoydb({
      store, user: 'alice',
      secretMode: 'managed',
      sealingKey: gcpKmsSealingProvider({ keyName, client: sharedFake as any }),
      shamirRecovery: shamirRecoveryProvider(),
    })
    const vault2 = await db2.openVault('demo')
    const note = await vault2.collection<{ id: string; note: string }>('notes').get('n1')
    expect(note).toEqual({ id: 'n1', note: 'managed-mode write via at-gcp-kms' })
    db2.close()
    // 30s timeout (#564): two full managed-mode opens (600K-PBKDF2 × several)
    // sit near the 5s vitest default when parallel suites compete for CPU.
  }, 30_000)
})

const RUN_REAL = !!process.env.NOYDB_TEST_GCP_KMS_KEY_NAME
describe.skipIf(!RUN_REAL)('gcpKmsSealingProvider (real GCP KMS)', () => {
  it('round-trips against real GCP KMS', async () => {
    const p = gcpKmsSealingProvider({ keyName: process.env.NOYDB_TEST_GCP_KMS_KEY_NAME! })
    const phrase = new TextEncoder().encode('real-key-test')
    expect(await p.unseal(await p.seal(phrase))).toEqual(phrase)
  })
})
