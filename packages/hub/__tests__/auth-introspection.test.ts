/**
 * Authentication introspection — issue #13.
 *
 * Critical negative test: the per-user introspection MUST NOT expose
 * secrets even when a contrived keyring file plants fake "secret"
 * fields in places the renderer might otherwise touch.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, KeyringFile } from '../src/kernel/types.js'
import { NOYDB_KEYRING_VERSION } from '../src/kernel/types.js'
import {
  describeAuthConfig,
  diagramAuthConfig,
  describeUserAuth,
} from '../src/with-party/auth-introspection/index.js'
import {
  saveVaultPolicy,
  PERSONAL_POLICY,
} from '../src/policy/index.js'

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
    async get(c, col, id) { return gc(c, col).get(id) },
    async put(c, col, id, env) { gc(c, col).set(id, env) },
    async delete(c, col, id) { gc(c, col).delete(id) },
    async list(c, col) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

async function writeKeyring(store: NoydbStore, vault: string, file: KeyringFile): Promise<void> {
  const env: EncryptedEnvelope = {
    _noydb: 1,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify(file),
  }
  await store.put(vault, '_keyring', file.user_id, env)
}

describe('describeAuthConfig', () => {
  it('returns a vault-wide English summary', async () => {
    const store = inlineMemory()
    await saveVaultPolicy(store, 'acme', PERSONAL_POLICY)
    const summary = await describeAuthConfig(store, 'acme')
    expect(summary).toContain('Vault "acme"')
    expect(summary).toContain('Tier 1 — Passphrase')
    expect(summary).toContain('Tier 2 — Authenticate')
    expect(summary).toContain('Tier 3 — Unlock')
    expect(summary).toContain('rotate-passphrase')
    expect(summary).toContain('Recovery profiles enrolled: none')
  })

  it('falls back to defaults when no policy is on disk', async () => {
    const store = inlineMemory()
    const summary = await describeAuthConfig(store, 'acme')
    expect(summary).toContain('Vault "acme"')
    expect(summary).toContain('Tier 1 — Passphrase')
  })
})

describe('diagramAuthConfig', () => {
  it('emits valid Mermaid flowchart source', async () => {
    const store = inlineMemory()
    await saveVaultPolicy(store, 'acme', PERSONAL_POLICY)
    const mmd = await diagramAuthConfig(store, 'acme')
    expect(mmd.startsWith('flowchart TB')).toBe(true)
    expect(mmd).toContain('vault["Vault: acme"]')
    expect(mmd).toContain('tier1')
    expect(mmd).toContain('tier2')
    expect(mmd).toContain('tier3')
    expect(mmd).toContain('rotate_passphrase')
  })
})

describe('describeUserAuth — sanitization', () => {
  it('renders an empty string for unknown users (existence non-leak)', async () => {
    const store = inlineMemory()
    const summary = await describeUserAuth(store, 'acme', 'ghost')
    expect(summary).toBe('')
  })

  it('renders only allowlisted slot fields', async () => {
    const store = inlineMemory()
    await writeKeyring(store, 'acme', {
      _noydb_keyring: NOYDB_KEYRING_VERSION,
      user_id: 'alice',
      display_name: 'Alice',
      role: 'owner',
      permissions: {},
      deks: {},
      salt: 'salt-base64',
      created_at: '2026-04-15T00:00:00.000Z',
      granted_by: 'alice',
      authenticators: [
        {
          id: 'webauthn-yubikey-blue',
          method: 'webauthn',
          enrolled_at: '2026-04-15T00:00:00.000Z',
          enrolled_via_tier: 1,
          wrapped_kek: 'WRAPPED-KEK-CIPHERTEXT-MUST-NEVER-APPEAR-IN-OUTPUT',
          meta: {
            credId: 'CRED-ID-MUST-NEVER-APPEAR',
            password: 'PASSWORD-MUST-NEVER-APPEAR',
            secretToken: 'TOKEN-MUST-NEVER-APPEAR',
          },
        },
      ],
    })

    const summary = await describeUserAuth(store, 'acme', 'alice')

    // Positive: shows the allowlisted fields
    expect(summary).toContain('alice')
    expect(summary).toContain('webauthn')
    expect(summary).toContain('webauthn-yubikey-blue')

    // Negative: NEVER shows secrets — blanket regex over forbidden tokens
    const forbidden = [
      'WRAPPED-KEK-CIPHERTEXT',
      'CRED-ID-MUST-NEVER-APPEAR',
      'PASSWORD-MUST-NEVER-APPEAR',
      'TOKEN-MUST-NEVER-APPEAR',
      'salt-base64',
    ]
    for (const token of forbidden) {
      expect(summary).not.toContain(token)
    }
  })

  it('renders empty enrollment list cleanly', async () => {
    const store = inlineMemory()
    await writeKeyring(store, 'acme', {
      _noydb_keyring: NOYDB_KEYRING_VERSION,
      user_id: 'bob',
      display_name: 'Bob',
      role: 'viewer',
      permissions: {},
      deks: {},
      salt: 'salt-base64',
      created_at: '2026-04-20T00:00:00.000Z',
      granted_by: 'alice',
    })
    const summary = await describeUserAuth(store, 'acme', 'bob')
    expect(summary).toContain('bob')
    expect(summary).toContain('(none enrolled)')
  })
})
