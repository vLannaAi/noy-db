/**
 * Security regression — secret-bearing reserved collections must be
 * unreadable by granted (sub-admin) principals.
 *
 * Before the fix, two independent seams combined into a plaintext leak of the
 * vault's sync transport credentials:
 *
 *   1. `vault.collection('_sync_credentials')` returned a working handle — the
 *      generic public read path had no guard for secret-bearing reserved names
 *      (only `_dict_*`, `_sequences`, `_links_*` were rejected), so it decrypted
 *      with whatever DEK the caller's keyring held, bypassing the owner/admin
 *      gate on the dedicated `getCredential` API.
 *
 *   2. `grant()` propagated EVERY `_`-prefixed DEK to EVERY new keyring
 *      regardless of role, so a freshly-granted operator/client received the
 *      `_sync_credentials` DEK.
 *
 * Combined: a granted operator could read the firm's plaintext OAuth tokens.
 */

import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { ReservedCollectionNameError } from '../src/kernel/errors.js'
import { withTeam } from '../src/with-party/team/index.js'
import {
  createOwnerKeyring,
  grant,
  loadKeyring,
  ensureCollectionDEK,
} from '../src/with-party/team/keyring.js'
import { putCredential, getCredential } from '../src/with-party/team/sync-credentials.js'
import {
  SYNC_CREDENTIALS_COLLECTION,
  BROKER_COLLECTION,
} from '../src/with-party/team/reserved-secret-collections.js'
import { LEDGER_COLLECTION } from '../src/with-commit/history/ledger/constants.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'inline-memory',
    async get(c, col, id) { return gc(c, col).get(id) ?? null },
    async put(c, col, id, env) { gc(c, col).set(id, env) },
    async delete(c, col, id) { gc(c, col).delete(id) },
    async list(c, col) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

const COMP = 'acme'
const OWNER_SECRET = 'owner secret long enough to be safe'
const OP_SECRET = 'operator secret long enough to be safe'
const ADMIN_SECRET = 'admin secret long enough to be safe'

const GDRIVE = {
  adapterId: 'google-drive',
  tokenType: 'Bearer',
  accessToken: 'ya29.SUPER-SECRET-access-token',
  refreshToken: 'refresh-token-XYZ',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  scopes: 'https://www.googleapis.com/auth/drive.file',
}

describe('reserved secret-collections — Layer 1: vault.collection() guard', () => {
  it('rejects vault.collection("_sync_credentials") — even for the owner', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: OWNER_SECRET })
    const vault = await db.openVault(COMP)
    expect(() => vault.collection(SYNC_CREDENTIALS_COLLECTION)).toThrow(ReservedCollectionNameError)
  })

  it('reserves vault.collection("_broker") ahead of the broker (#479)', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: OWNER_SECRET })
    const vault = await db.openVault(COMP)
    expect(() => vault.collection(BROKER_COLLECTION)).toThrow(ReservedCollectionNameError)
  })

  it('still allows ordinary data collections', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: OWNER_SECRET })
    const vault = await db.openVault(COMP)
    expect(() => vault.collection('invoices')).not.toThrow()
  })
})

describe('reserved secret-collections — Layer 2: grant DEK propagation', () => {
  it('does NOT propagate the _sync_credentials DEK to a granted operator', async () => {
    const store = inlineMemory()
    const owner = await createOwnerKeyring(store, COMP, { userId: 'owner', secret: OWNER_SECRET })
    // Owner creates a credential → owner keyring now holds the _sync_credentials DEK.
    await putCredential(store, COMP, owner, GDRIVE)
    expect(owner.deks.has(SYNC_CREDENTIALS_COLLECTION)).toBe(true)

    await grant(store, COMP, owner, {
      userId: 'op1',
      displayName: 'Operator',
      role: 'operator',
      secret: OP_SECRET,
      permissions: { invoices: 'rw' },
    })
    const op = await loadKeyring(store, COMP, { userId: 'op1', secret: OP_SECRET })
    expect(op.deks.has(SYNC_CREDENTIALS_COLLECTION)).toBe(false)
  })

  it('does NOT propagate a secret-bearing DEK to a granted client/viewer either', async () => {
    const store = inlineMemory()
    const owner = await createOwnerKeyring(store, COMP, { userId: 'owner', secret: OWNER_SECRET })
    await putCredential(store, COMP, owner, GDRIVE)

    await grant(store, COMP, owner, {
      userId: 'v1', displayName: 'Viewer', role: 'viewer', secret: OP_SECRET,
    })
    const viewer = await loadKeyring(store, COMP, { userId: 'v1', secret: OP_SECRET })
    expect(viewer.deks.has(SYNC_CREDENTIALS_COLLECTION)).toBe(false)
  })

  it('does NOT leak the DEK even when the grantor names it explicitly in permissions', async () => {
    const store = inlineMemory()
    const owner = await createOwnerKeyring(store, COMP, { userId: 'owner', secret: OWNER_SECRET })
    await putCredential(store, COMP, owner, GDRIVE)

    await grant(store, COMP, owner, {
      userId: 'op1', displayName: 'Operator', role: 'operator', secret: OP_SECRET,
      // Deliberate escalation attempt: name the reserved secret collection.
      permissions: { invoices: 'rw', [SYNC_CREDENTIALS_COLLECTION]: 'rw' },
    })
    const op = await loadKeyring(store, COMP, { userId: 'op1', secret: OP_SECRET })
    expect(op.deks.has(SYNC_CREDENTIALS_COLLECTION)).toBe(false)
  })

  it('KEEPS propagating operational reserved DEKs (_ledger) to a granted operator', async () => {
    const store = inlineMemory()
    const owner = await createOwnerKeyring(store, COMP, { userId: 'owner', secret: OWNER_SECRET })
    // Materialise an operational reserved DEK on the owner keyring.
    const getDek = await ensureCollectionDEK(store, COMP, owner)
    await getDek(LEDGER_COLLECTION)
    expect(owner.deks.has(LEDGER_COLLECTION)).toBe(true)

    await grant(store, COMP, owner, {
      userId: 'op1', displayName: 'Operator', role: 'operator', secret: OP_SECRET,
      permissions: { invoices: 'rw' },
    })
    const op = await loadKeyring(store, COMP, { userId: 'op1', secret: OP_SECRET })
    expect(op.deks.has(LEDGER_COLLECTION)).toBe(true)
  })

  it('STILL propagates the _sync_credentials DEK to a granted ADMIN (legit flow preserved)', async () => {
    const store = inlineMemory()
    const owner = await createOwnerKeyring(store, COMP, { userId: 'owner', secret: OWNER_SECRET })
    await putCredential(store, COMP, owner, GDRIVE)

    await grant(store, COMP, owner, {
      userId: 'admin1', displayName: 'Admin', role: 'admin', secret: ADMIN_SECRET,
    })
    const admin = await loadKeyring(store, COMP, { userId: 'admin1', secret: ADMIN_SECRET })
    expect(admin.deks.has(SYNC_CREDENTIALS_COLLECTION)).toBe(true)
    // And the admin can read the owner's existing credential through the gated API.
    const got = await getCredential(store, COMP, admin, 'google-drive')
    expect(got?.accessToken).toBe(GDRIVE.accessToken)
  })
})

describe('reserved secret-collections — end-to-end exploit is closed', () => {
  it('a granted operator can neither open the handle nor hold the DEK', async () => {
    const store = inlineMemory()

    // Owner enrols a credential.
    const ownerDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: OWNER_SECRET })
    await ownerDb.openVault(COMP)
    const ownerKeyring = await ownerDb.team.getKeyring(COMP)
    await putCredential(store, COMP, ownerKeyring, GDRIVE)

    // Re-open owner so the live keyring reloads the persisted _sync_credentials DEK,
    // then grant an operator (this is where propagation would have leaked the DEK).
    const ownerDb2 = await createNoydb({ teamStrategy: withTeam(), store, user: 'owner', secret: OWNER_SECRET })
    await ownerDb2.openVault(COMP)
    await ownerDb2.grant(COMP, {
      userId: 'op1', displayName: 'Operator', role: 'operator', secret: OP_SECRET,
      permissions: { invoices: 'rw' },
    })

    // Operator connects and tries the exploit.
    const opDb = await createNoydb({ teamStrategy: withTeam(), store, user: 'op1', secret: OP_SECRET })
    const opVault = await opDb.openVault(COMP)

    // Layer 1: public handle path is blocked.
    expect(() => opVault.collection(SYNC_CREDENTIALS_COLLECTION)).toThrow(ReservedCollectionNameError)

    // Layer 2: the DEK never reached the operator's keyring.
    const opKeyring = await opDb.team.getKeyring(COMP)
    expect(opKeyring.deks.has(SYNC_CREDENTIALS_COLLECTION)).toBe(false)
  })
})
