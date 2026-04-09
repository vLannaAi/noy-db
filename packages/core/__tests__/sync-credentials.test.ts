/**
 * Tests for v0.7 #110 — _sync_credentials reserved collection
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  putCredential,
  getCredential,
  deleteCredential,
  listCredentials,
  credentialStatus,
  SYNC_CREDENTIALS_COLLECTION,
} from '../src/sync-credentials.js'
import { PermissionDeniedError } from '../src/errors.js'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '../src/types.js'
import type { UnlockedKeyring } from '../src/keyring.js'
import { createOwnerKeyring, grant } from '../src/keyring.js'
import { ConflictError } from '../src/errors.js'

// ─── Inline memory adapter ─────────────────────────────────────────────────

function memory(): NoydbAdapter {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c): Promise<CompartmentSnapshot> {
      const comp = store.get(c); const s: CompartmentSnapshot = {}
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
      for (const [n, recs] of Object.entries(data)) {
        const coll = getCollection(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

// ─── Test setup ────────────────────────────────────────────────────────────

const COMPARTMENT = 'test-compartment'

let adapter: NoydbAdapter
let ownerKeyring: UnlockedKeyring

beforeEach(async () => {
  adapter = memory()
  ownerKeyring = await createOwnerKeyring(adapter, COMPARTMENT, 'owner', 'secret-owner-pw')
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('_sync_credentials (#110)', () => {
  const gdriveToken = {
    adapterId: 'google-drive',
    tokenType: 'Bearer',
    accessToken: 'ya29.access-token',
    refreshToken: 'refresh-token-123',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scopes: 'https://www.googleapis.com/auth/drive.file',
  }

  // ── putCredential / getCredential ────────────────────────────────────────

  it('stores and retrieves a credential', async () => {
    await putCredential(adapter, COMPARTMENT, ownerKeyring, gdriveToken)
    const got = await getCredential(adapter, COMPARTMENT, ownerKeyring, 'google-drive')
    expect(got).toMatchObject(gdriveToken)
  })

  it('returns null for a missing adapterId', async () => {
    const got = await getCredential(adapter, COMPARTMENT, ownerKeyring, 'nonexistent')
    expect(got).toBeNull()
  })

  it('overwrites an existing credential', async () => {
    await putCredential(adapter, COMPARTMENT, ownerKeyring, gdriveToken)
    const updated = { ...gdriveToken, accessToken: 'ya29.new-access-token' }
    await putCredential(adapter, COMPARTMENT, ownerKeyring, updated)

    const got = await getCredential(adapter, COMPARTMENT, ownerKeyring, 'google-drive')
    expect(got?.accessToken).toBe('ya29.new-access-token')
  })

  it('stores credential bytes opaquely (adapter only sees ciphertext)', async () => {
    await putCredential(adapter, COMPARTMENT, ownerKeyring, gdriveToken)
    // Peek directly at the adapter's store — it must NOT contain the access token
    const raw = await adapter.get(COMPARTMENT, SYNC_CREDENTIALS_COLLECTION, 'google-drive')
    expect(raw).toBeTruthy()
    expect(raw!._data).not.toContain('ya29.access-token')
    expect(raw!._data).not.toContain('refresh-token-123')
  })

  it('stores multiple adapters independently', async () => {
    await putCredential(adapter, COMPARTMENT, ownerKeyring, gdriveToken)
    await putCredential(adapter, COMPARTMENT, ownerKeyring, {
      adapterId: 'dropbox',
      tokenType: 'Bearer',
      accessToken: 'sl.dropbox-token',
    })

    const drive = await getCredential(adapter, COMPARTMENT, ownerKeyring, 'google-drive')
    const dropbox = await getCredential(adapter, COMPARTMENT, ownerKeyring, 'dropbox')
    expect(drive?.accessToken).toBe('ya29.access-token')
    expect(dropbox?.accessToken).toBe('sl.dropbox-token')
  })

  // ── deleteCredential ─────────────────────────────────────────────────────

  it('deletes a credential', async () => {
    await putCredential(adapter, COMPARTMENT, ownerKeyring, gdriveToken)
    await deleteCredential(adapter, COMPARTMENT, ownerKeyring, 'google-drive')
    const got = await getCredential(adapter, COMPARTMENT, ownerKeyring, 'google-drive')
    expect(got).toBeNull()
  })

  it('deleteCredential is a no-op for nonexistent adapterId', async () => {
    await expect(
      deleteCredential(adapter, COMPARTMENT, ownerKeyring, 'nonexistent'),
    ).resolves.not.toThrow()
  })

  // ── listCredentials ──────────────────────────────────────────────────────

  it('lists adapter IDs without exposing credential payloads', async () => {
    await putCredential(adapter, COMPARTMENT, ownerKeyring, gdriveToken)
    await putCredential(adapter, COMPARTMENT, ownerKeyring, {
      adapterId: 'dropbox',
      tokenType: 'Bearer',
      accessToken: 'sl.dropbox-token',
    })
    const ids = await listCredentials(adapter, COMPARTMENT, ownerKeyring)
    expect(ids.sort()).toEqual(['dropbox', 'google-drive'])
  })

  it('returns an empty list when no credentials are stored', async () => {
    const ids = await listCredentials(adapter, COMPARTMENT, ownerKeyring)
    expect(ids).toEqual([])
  })

  // ── credentialStatus ─────────────────────────────────────────────────────

  it('credentialStatus returns { exists: false } for a missing adapterId', async () => {
    const status = await credentialStatus(adapter, COMPARTMENT, ownerKeyring, 'nonexistent')
    expect(status.exists).toBe(false)
  })

  it('credentialStatus returns { exists: true, expired: false } for a fresh token', async () => {
    await putCredential(adapter, COMPARTMENT, ownerKeyring, gdriveToken)
    const status = await credentialStatus(adapter, COMPARTMENT, ownerKeyring, 'google-drive')
    expect(status).toEqual({ exists: true, expired: false })
  })

  it('credentialStatus returns { exists: true, expired: true } for an expired token', async () => {
    const expired = {
      ...gdriveToken,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }
    await putCredential(adapter, COMPARTMENT, ownerKeyring, expired)
    const status = await credentialStatus(adapter, COMPARTMENT, ownerKeyring, 'google-drive')
    expect(status).toEqual({ exists: true, expired: true })
  })

  it('credentialStatus returns { exists: true, expired: false } for a token without expiresAt', async () => {
    const noExpiry = { adapterId: 's3-prod', tokenType: 'ApiKey', accessToken: 'AKID...' }
    await putCredential(adapter, COMPARTMENT, ownerKeyring, noExpiry)
    const status = await credentialStatus(adapter, COMPARTMENT, ownerKeyring, 's3-prod')
    expect(status).toEqual({ exists: true, expired: false })
  })

  // ── ACL enforcement ──────────────────────────────────────────────────────

  it('throws PermissionDeniedError for viewer role', async () => {
    // Grant a viewer
    await grant(adapter, COMPARTMENT, ownerKeyring, {
      userId: 'viewer1',
      displayName: 'Viewer One',
      role: 'viewer',
      passphrase: 'viewer-pw',
    })
    const { loadKeyring } = await import('../src/keyring.js')
    const viewerKeyring = await loadKeyring(adapter, COMPARTMENT, 'viewer1', 'viewer-pw')

    await expect(
      putCredential(adapter, COMPARTMENT, viewerKeyring, gdriveToken),
    ).rejects.toThrow(PermissionDeniedError)
    await expect(
      getCredential(adapter, COMPARTMENT, viewerKeyring, 'google-drive'),
    ).rejects.toThrow(PermissionDeniedError)
    await expect(
      listCredentials(adapter, COMPARTMENT, viewerKeyring),
    ).rejects.toThrow(PermissionDeniedError)
  })

  it('throws PermissionDeniedError for operator role', async () => {
    await grant(adapter, COMPARTMENT, ownerKeyring, {
      userId: 'op1',
      displayName: 'Operator',
      role: 'operator',
      passphrase: 'op-pw',
      permissions: { invoices: 'rw' },
    })
    const { loadKeyring } = await import('../src/keyring.js')
    const opKeyring = await loadKeyring(adapter, COMPARTMENT, 'op1', 'op-pw')

    await expect(
      getCredential(adapter, COMPARTMENT, opKeyring, 'google-drive'),
    ).rejects.toThrow(PermissionDeniedError)
  })

  it('allows admin role to read and write credentials', async () => {
    await grant(adapter, COMPARTMENT, ownerKeyring, {
      userId: 'admin1',
      displayName: 'Admin',
      role: 'admin',
      passphrase: 'admin-pw',
    })
    const { loadKeyring } = await import('../src/keyring.js')
    const adminKeyring = await loadKeyring(adapter, COMPARTMENT, 'admin1', 'admin-pw')

    await putCredential(adapter, COMPARTMENT, adminKeyring, gdriveToken)
    const got = await getCredential(adapter, COMPARTMENT, adminKeyring, 'google-drive')
    expect(got?.accessToken).toBe('ya29.access-token')
  })
})
