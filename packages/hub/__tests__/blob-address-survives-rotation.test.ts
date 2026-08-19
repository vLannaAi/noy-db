/**
 * #1126 — the blob content address survives a key rotation.
 *
 * The eTag is an HMAC over the plaintext. It used to be keyed by the `_blob`
 * DEK — the very key `rotateKeys` replaces — so after any rotation
 * `HMAC(live DEK, plaintext) !== storedETag` for every blob written before it,
 * permanently: `decryptResponse()` raised `TamperedError` on the presigned-URL
 * path forever, `verifyFlatETag` did the same on the flat-tier fallback, a
 * resumed rehome mis-mapped, and dedup split.
 *
 * It is now derived from `_blob_addr`, a vault-lifetime keyring slot rotation
 * refuses to touch — still domain-separated PER TIER, because the address is
 * meant to be tier-scoped and only the rotation coupling was wrong.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore, ValidationError } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { deriveBlobAddressKey, generateDEK, hmacSha256Hex } from '../src/kernel/enclave/index.js'
import { BLOB_ADDRESS_KEY_ID } from '../src/kernel/constants.js'
import type { NoydbStore } from '../src/kernel/types.js'

const VAULT = 'acme'
const SECRET = 'owner-pass-correct-horse-battery-staple'
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

async function seeded() {
  const store = memoryStore()
  const db = await createNoydb({
    teamStrategy: withTeam(), blobsStrategy: withBlobs(), store, user: 'owner', secret: SECRET,
  })
  const vault = await db.openVault(VAULT)
  const invoices = vault.collection<{ ref: string }>('invoices')
  await invoices.put('inv-1', { ref: 'A' })
  await invoices.blob('inv-1').put('readme.txt', bytes('hello blob'), { mimeType: 'text/plain' })
  return { store, db, vault, invoices }
}

describe('#1126 — a rotation preserves every blob address', () => {
  it('the stored eTag is UNCHANGED across a revocation', async () => {
    const { store, db, invoices } = await seeded()
    const before = (await invoices.blob('inv-1').blobInfo('readme.txt'))!.eTag

    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
    await db.revoke(VAULT, { userId: 'bob' })

    const after = (await invoices.blob('inv-1').blobInfo('readme.txt'))!.eTag
    expect(after).toBe(before)
    void store
  })

  it('the bytes still read back, and dedup still shares the address', async () => {
    const { db, vault, invoices } = await seeded()
    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
    await db.revoke(VAULT, { userId: 'bob' })

    expect(await invoices.blob('inv-1').get('readme.txt')).toEqual(bytes('hello blob'))

    // Identical bytes written AFTER the rotation must land on the SAME address —
    // the dedup split was one of the defect's quieter halves.
    await vault.collection<{ ref: string }>('invoices').put('inv-2', { ref: 'B' })
    await invoices.blob('inv-2').put('copy.txt', bytes('hello blob'))
    const a = (await invoices.blob('inv-1').blobInfo('readme.txt'))!.eTag
    const b = (await invoices.blob('inv-2').blobInfo('copy.txt'))!.eTag
    expect(b).toBe(a)
  })

  it('the addressing root is REFUSED by rotateKeys, by name', async () => {
    const { vault } = await seeded()
    const anyVault = vault as unknown as { keyring: unknown }
    const { rotateKeys } = await import('../src/with-party/team/keyring.js')
    const store = (vault as unknown as { adapter: NoydbStore }).adapter
    await expect(
      rotateKeys(store, VAULT, anyVault.keyring as never, { collections: [BLOB_ADDRESS_KEY_ID] }),
    ).rejects.toThrow(ValidationError)
  })

  it('a revocation does not silently rotate it either — the scope strips it', async () => {
    const { store, db } = await seeded()
    const rootBefore = JSON.parse((await store.get(VAULT, '_keyring', 'owner') as { _data: string })._data)
      .deks[BLOB_ADDRESS_KEY_ID] as string
    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
    await db.revoke(VAULT, { userId: 'bob' })
    const rootAfter = JSON.parse((await store.get(VAULT, '_keyring', 'owner') as { _data: string })._data)
      .deks[BLOB_ADDRESS_KEY_ID] as string
    expect(rootAfter).toBe(rootBefore)
  })
})

describe('#1126 — the address stays TIER-SCOPED', () => {
  it('the same bytes address differently at different tiers', async () => {
    const root = await generateDEK()
    const t0 = await deriveBlobAddressKey(root, 0)
    const t1 = await deriveBlobAddressKey(root, 1)
    const data = bytes('identical content')
    expect(await hmacSha256Hex(t0, data)).not.toBe(await hmacSha256Hex(t1, data))
  })

  it('derivation is deterministic — the same root and tier always give the same address', async () => {
    const root = await generateDEK()
    const data = bytes('identical content')
    const a = await hmacSha256Hex(await deriveBlobAddressKey(root, 2), data)
    const b = await hmacSha256Hex(await deriveBlobAddressKey(root, 2), data)
    expect(a).toBe(b)
  })

  it('a DIFFERENT root gives a different address — the key is doing the work', async () => {
    const data = bytes('identical content')
    const a = await hmacSha256Hex(await deriveBlobAddressKey(await generateDEK(), 0), data)
    const b = await hmacSha256Hex(await deriveBlobAddressKey(await generateDEK(), 0), data)
    expect(a).not.toBe(b)
  })

  it('an elevated blob keeps working across a rotation', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      teamStrategy: withTeam(), blobsStrategy: withBlobs(), tiersStrategy: withTiers(),
      store, user: 'owner', secret: SECRET,
    })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices', { tiers: [0, 1], perRecordKeys: true })
    await invoices.put('inv-1', { ref: 'A' })
    await invoices.blob('inv-1').put('secret.txt', bytes('elevated bytes'))
    await invoices.elevate('inv-1', 1)

    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
    await db.revoke(VAULT, { userId: 'bob' })

    const atTier = await invoices.blob('inv-1').atTier()
    expect(await atTier.get('secret.txt')).toEqual(bytes('elevated bytes'))
  })
})
