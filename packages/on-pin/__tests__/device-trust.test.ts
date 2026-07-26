/**
 * Tests for the device-trust unlock mode (@noy-db/on-pin).
 *
 * Covers:
 *   - enroll + resume round-trip (identity + functional DEKs, no factor)
 *   - non-extractable invariant (key.extractable === false, export
 *     refused, structured-clone persistence path preserves both)
 *   - resume yields the capped session tier (default 3, below
 *     passphrase; hub checkGate denies tier-1 gates under it)
 *   - enrollment refuses a keyring with no DEKs (no unlocked session)
 *   - revocation: local clear kills it; keyring-side DEK rotation
 *     invalidates the cached DEKs (stale DEK fails AES-GCM auth)
 *   - eviction simulation: storage cleared → typed fail-closed error
 *     naming the re-enroll path
 *   - policy gate: owner forbids / tier-bounds enrollment via
 *     `app:device-trust`; unconfigured gate allows
 */

import { describe, it, expect } from 'vitest'
import type { UnlockedKeyring, VaultPolicy } from '@noy-db/hub'
import { checkGate, PolicyDeniedError } from '@noy-db/hub'
import {
  enrollDeviceTrust,
  resumeDeviceTrust,
  clearDeviceTrust,
  isDeviceTrustEnrolled,
  DEVICE_TRUST_GATE,
  DEVICE_TRUST_DEFAULT_RESUME_TIER,
  DeviceTrustNotFoundError,
  DeviceTrustEnrollmentError,
  DeviceTrustInvalidError,
  DeviceTrustStorageError,
  type DeviceTrustStore,
  type DeviceTrustResumeTier,
} from '../src/index.js'

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * In-memory DeviceTrustStore that structured-clones on BOTH set and
 * get — the same round-trip IndexedDB performs. This is what makes the
 * "persist the CryptoKey OBJECT via structured clone" path real in
 * tests: a non-extractable key must survive the clone still
 * non-extractable and still usable.
 */
function memoryStore(): DeviceTrustStore & { clear(): void; dump(key: string): unknown } {
  const map = new Map<string, unknown>()
  return {
    async get(key) {
      const value = map.get(key)
      return value === undefined ? undefined : structuredClone(value)
    },
    async set(key, value) {
      map.set(key, structuredClone(value))
    },
    async delete(key) {
      map.delete(key)
    },
    clear() {
      map.clear()
    },
    dump(key: string) {
      return map.get(key)
    },
  }
}

async function makeTestKeyring(): Promise<UnlockedKeyring> {
  const dek1 = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — required for session-resume wrapping
    ['encrypt', 'decrypt'],
  )
  const dek2 = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  return {
    userId: 'alice',
    displayName: 'Alice',
    role: 'owner',
    permissions: { invoices: 'rw', clients: 'rw' },
    deks: new Map([
      ['invoices', dek1],
      ['clients', dek2],
    ]),
    kek: null, // simulate post-unlock state
    salt: new Uint8Array(32).fill(7),
  }
}

async function encryptWithDek(dek: CryptoKey, plaintext: string): Promise<{ iv: Uint8Array; ct: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dek,
    new TextEncoder().encode(plaintext),
  )
  return { iv, ct }
}

async function decryptWithDek(dek: CryptoKey, blob: { iv: Uint8Array; ct: ArrayBuffer }): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.iv }, dek, blob.ct)
  return new TextDecoder().decode(plain)
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('enrollDeviceTrust + resumeDeviceTrust — happy path', () => {
  it('resumes with no factor at all and returns an equivalent keyring', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    await enrollDeviceTrust(keyring, { vault: 'main', store })

    const { keyring: resumed } = await resumeDeviceTrust('main', { store })
    expect(resumed.userId).toBe('alice')
    expect(resumed.displayName).toBe('Alice')
    expect(resumed.role).toBe('owner')
    expect(resumed.permissions).toEqual({ invoices: 'rw', clients: 'rw' })
    expect(resumed.deks.size).toBe(2)
    // KEK is deliberately null on resumed keyrings (session-resume law).
    expect(resumed.kek).toBeNull()
  })

  it('resumed DEKs actually decrypt data encrypted by the originals', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    const blob = await encryptWithDek(keyring.deks.get('invoices')!, 'hello, device')

    await enrollDeviceTrust(keyring, { vault: 'main', store })
    const { keyring: resumed } = await resumeDeviceTrust('main', { store })

    await expect(decryptWithDek(resumed.deks.get('invoices')!, blob)).resolves.toBe('hello, device')
  })

  it('records enrollment state and reports isDeviceTrustEnrolled', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()

    expect(await isDeviceTrustEnrolled('main', { store })).toBe(false)
    const state = await enrollDeviceTrust(keyring, { vault: 'main', store })
    expect(state._noydb_device_trust).toBe(1)
    expect(state.vault).toBe('main')
    expect(Date.parse(state.enrolledAt)).not.toBeNaN()
    expect(await isDeviceTrustEnrolled('main', { store })).toBe(true)
    // Records are per-vault.
    expect(await isDeviceTrustEnrolled('other', { store })).toBe(false)
  })
})

describe('non-extractable invariant', () => {
  it('persists a non-extractable CryptoKey object whose bits cannot be exported', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    await enrollDeviceTrust(keyring, { vault: 'main', store })

    const record = store.dump('noydb:device-trust:main') as { key: CryptoKey }
    expect(record.key).toBeInstanceOf(CryptoKey)
    expect(record.key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', record.key)).rejects.toThrow()
  })

  it('the key survives the structured-clone persistence path still non-extractable and still usable', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    await enrollDeviceTrust(keyring, { vault: 'main', store })

    // memoryStore structured-clones on set AND get — the same
    // round-trip IndexedDB performs. Two hops from the original.
    const cloned = (await store.get('noydb:device-trust:main')) as { key: CryptoKey }
    expect(cloned.key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', cloned.key)).rejects.toThrow()

    // Usable: resume (which goes through store.get → clone) works.
    const { keyring: resumed } = await resumeDeviceTrust('main', { store })
    expect(resumed.deks.size).toBe(2)
  })
})

describe('tier cap', () => {
  it('resume yields the default capped tier — 3, below the passphrase tier', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    const state = await enrollDeviceTrust(keyring, { vault: 'main', store })
    expect(state.resumeTier).toBe(DEVICE_TRUST_DEFAULT_RESUME_TIER)
    expect(state.resumeTier).toBe(3)

    const { resumeTier } = await resumeDeviceTrust('main', { store })
    expect(resumeTier).toBe(3)
  })

  it('sensitive gated operations still require a real factor under the capped tier', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    await enrollDeviceTrust(keyring, { vault: 'main', store })
    const { resumeTier } = await resumeDeviceTrust('main', { store })

    // A tier-1-floor gate (e.g. rotate-passphrase) denies a device-trust session.
    const policy: VaultPolicy = { gates: { 'rotate-passphrase': { minTier: 1 } } }
    await expect(
      checkGate(policy, 'rotate-passphrase', { activeTier: resumeTier }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  it('honors a configured resumeTier of 2', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    await enrollDeviceTrust(keyring, { vault: 'main', store, resumeTier: 2 })
    const { resumeTier } = await resumeDeviceTrust('main', { store })
    expect(resumeTier).toBe(2)
  })

  it('refuses to claim the passphrase tier', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    await expect(
      enrollDeviceTrust(keyring, { vault: 'main', store, resumeTier: 1 as unknown as DeviceTrustResumeTier }),
    ).rejects.toBeInstanceOf(DeviceTrustEnrollmentError)
  })
})

describe('enrollment requires an already-unlocked session', () => {
  it('refuses a keyring with no DEKs', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    const cold: UnlockedKeyring = { ...keyring, deks: new Map() }
    await expect(enrollDeviceTrust(cold, { vault: 'main', store })).rejects.toBeInstanceOf(
      DeviceTrustEnrollmentError,
    )
    expect(await isDeviceTrustEnrolled('main', { store })).toBe(false)
  })
})

describe('revocation', () => {
  it('clearDeviceTrust deletes the record — resume fails closed', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    await enrollDeviceTrust(keyring, { vault: 'main', store })

    await clearDeviceTrust('main', { store })
    expect(await isDeviceTrustEnrolled('main', { store })).toBe(false)
    await expect(resumeDeviceTrust('main', { store })).rejects.toBeInstanceOf(
      DeviceTrustNotFoundError,
    )
    // Idempotent.
    await expect(clearDeviceTrust('main', { store })).resolves.toBeUndefined()
  })

  it('keyring-side DEK rotation invalidates the cached blob — stale DEKs fail AES-GCM auth', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    await enrollDeviceTrust(keyring, { vault: 'main', store })

    // Simulate the vault's rotate ceremony: a NEW DEK is minted for the
    // collection and new records are encrypted under it.
    const rotatedDek = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    const freshRecord = await encryptWithDek(rotatedDek, 'post-rotation record')

    // The device-trust blob still resumes (it is a local cache), but the
    // stale DEK it yields cannot decrypt anything written after the
    // rotation — the wrapped-DEKs cache is cryptographically dead.
    const { keyring: resumed } = await resumeDeviceTrust('main', { store })
    await expect(
      decryptWithDek(resumed.deks.get('invoices')!, freshRecord),
    ).rejects.toThrow()

    // Re-enrolling from the fresh (rotated) session overwrites the record.
    const rotatedKeyring: UnlockedKeyring = {
      ...keyring,
      deks: new Map([['invoices', rotatedDek]]),
    }
    await enrollDeviceTrust(rotatedKeyring, { vault: 'main', store })
    const { keyring: reResumed } = await resumeDeviceTrust('main', { store })
    await expect(
      decryptWithDek(reResumed.deks.get('invoices')!, freshRecord),
    ).resolves.toBe('post-rotation record')
  })
})

describe('eviction tolerance — fail closed, never a lockout', () => {
  it('storage cleared → DeviceTrustNotFoundError naming the re-enroll path', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    await enrollDeviceTrust(keyring, { vault: 'main', store })

    // Simulate browser data clear / iOS ITP eviction.
    store.clear()

    const failure = await resumeDeviceTrust('main', { store }).then(
      () => null,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(DeviceTrustNotFoundError)
    const error = failure as DeviceTrustNotFoundError
    expect(error.code).toBe('DEVICE_TRUST_NOT_FOUND')
    // The error must direct the user to the real-factor unlock +
    // re-enrollment path — eviction disables the mode, never the vault.
    expect(error.message).toContain('real factor')
    expect(error.message).toContain('enrollDeviceTrust')
  })

  it('a corrupt record fails closed with DeviceTrustInvalidError', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    const state = await enrollDeviceTrust(keyring, { vault: 'main', store })

    // Tamper: replace the wrapped blob with garbage (key survives).
    const record = store.dump('noydb:device-trust:main') as { key: CryptoKey }
    await store.set('noydb:device-trust:main', {
      key: record.key,
      state: { ...state, wrappedKeyring: btoa('garbage') },
    })
    await expect(resumeDeviceTrust('main', { store })).rejects.toBeInstanceOf(
      DeviceTrustInvalidError,
    )
  })

  it('no store and no indexedDB → typed DeviceTrustStorageError', async () => {
    const keyring = await makeTestKeyring()
    if (typeof indexedDB === 'undefined') {
      await expect(enrollDeviceTrust(keyring, { vault: 'main' })).rejects.toBeInstanceOf(
        DeviceTrustStorageError,
      )
    } else {
      // Environment provides IndexedDB — the default store engages
      // instead; nothing to assert here.
      expect(true).toBe(true)
    }
  })
})

describe('policy gate — app:device-trust', () => {
  it('owner forbids the mode → enrollment refused with PolicyDeniedError', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    const policy: VaultPolicy = {
      gates: { [DEVICE_TRUST_GATE]: { minTier: 3, enabled: false } },
    }
    await expect(
      enrollDeviceTrust(keyring, { vault: 'main', store, policy }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
    expect(await isDeviceTrustEnrolled('main', { store })).toBe(false)
  })

  it('owner tier-bounds enrollment → a weaker session cannot enroll', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    // Only a full-passphrase (tier-1) session may enroll device-trust.
    const policy: VaultPolicy = {
      gates: { [DEVICE_TRUST_GATE]: { minTier: 1 } },
    }
    // A PIN-resumed (tier-3) session is refused…
    await expect(
      enrollDeviceTrust(keyring, { vault: 'main', store, policy, activeTier: 3 }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
    // …a tier-1 session passes.
    await expect(
      enrollDeviceTrust(keyring, { vault: 'main', store, policy, activeTier: 1 }),
    ).resolves.toBeDefined()
  })

  it('unconfigured gate allows (opt-in default), as does omitting the policy', async () => {
    const store = memoryStore()
    const keyring = await makeTestKeyring()
    // Policy present but gate unconfigured — app:* gates default-allow.
    const policy: VaultPolicy = { gates: {} }
    await expect(
      enrollDeviceTrust(keyring, { vault: 'a', store, policy }),
    ).resolves.toBeDefined()
    // No policy passed at all.
    await expect(
      enrollDeviceTrust(keyring, { vault: 'b', store }),
    ).resolves.toBeDefined()
  })
})
