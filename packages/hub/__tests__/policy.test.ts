/**
 * Policy gate engine + presets + storage round-trip — issue #9.
 *
 * Covers:
 *   - PERSONAL_POLICY / STRICT_POLICY presets load and round-trip
 *   - checkGate denies on insufficient tier, missing factor, stale proof
 *   - app:* gate works end-to-end
 *   - mergePolicy preserves non-overridden gates
 *   - _meta/policy persistence via memoryStore
 */
import { describe, it, expect } from 'vitest'
import {
  PERSONAL_POLICY,
  STRICT_POLICY,
  mergePolicy,
  checkGate,
  describeGate,
  PolicyDeniedError,
  loadVaultPolicy,
  saveVaultPolicy,
} from '../src/with-party/policy/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

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
    async loadAll(c) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      const comp = store.get(c) ?? new Map()
      for (const [col, recs] of comp) {
        out[col] = Object.fromEntries(recs)
      }
      return out
    },
    async saveAll(c: string, data: Record<string, Record<string, EncryptedEnvelope>>) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [col, recs] of Object.entries(data)) {
        comp.set(col, new Map(Object.entries(recs)))
      }
      store.set(c, comp)
    },
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

describe('policy presets', () => {
  it('PERSONAL_POLICY enables recover-passphrase by default', () => {
    expect(PERSONAL_POLICY.gates['recover-passphrase']?.enabled).toBe(true)
  })

  it('STRICT_POLICY raises minWords to 8', () => {
    expect(STRICT_POLICY.passphrase?.minWords).toBe(8)
  })

  it('STRICT_POLICY demands TWO factors for export-plaintext', () => {
    const gate = STRICT_POLICY.gates['export-plaintext']
    expect(gate?.factors?.[0]?.count).toBe(2)
  })
})

describe('checkGate', () => {
  it('allows under PERSONAL_POLICY when factors are presented', async () => {
    await expect(
      checkGate(PERSONAL_POLICY, 'rotate-passphrase', {
        activeTier: 1,
        factors: [{ kind: 'totp' }],
      }),
    ).resolves.toBeUndefined()
  })

  it('denies (missing-factor) when no factor is presented', async () => {
    try {
      await checkGate(PERSONAL_POLICY, 'rotate-passphrase', {
        activeTier: 1,
        factors: [],
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError)
      if (err instanceof PolicyDeniedError) {
        expect(err.reason).toBe('missing-factor')
        expect(err.gate).toBe('rotate-passphrase')
      }
    }
  })

  it('denies (stale-proof) when proof is older than freshnessMs', async () => {
    const stalePolicy = mergePolicy(PERSONAL_POLICY, {
      gates: {
        'export-plaintext': {
          minTier: 1,
          factors: [{ anyOf: ['totp'], freshnessMs: 60_000 }],
        },
      },
    })
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    try {
      await checkGate(stalePolicy, 'export-plaintext', {
        activeTier: 1,
        factors: [{ kind: 'totp', mintedAt: tenMinutesAgo }],
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError)
      if (err instanceof PolicyDeniedError) {
        expect(err.reason).toBe('stale-proof')
      }
    }
  })

  it('denies (insufficient-tier) when tier is below minTier', async () => {
    try {
      await checkGate(PERSONAL_POLICY, 'rotate-passphrase', {
        activeTier: 3,
        factors: [{ kind: 'totp' }],
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError)
      if (err instanceof PolicyDeniedError) {
        expect(err.reason).toBe('insufficient-tier')
      }
    }
  })

  it('disabled gate (view-user-auth in PERSONAL_POLICY) denies', async () => {
    try {
      await checkGate(PERSONAL_POLICY, 'view-user-auth', { activeTier: 1 })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError)
      if (err instanceof PolicyDeniedError) {
        expect(err.reason).toBe('disabled')
      }
    }
  })

  it('app:* gate without policy is treated as no-op', async () => {
    await expect(
      checkGate(PERSONAL_POLICY, 'app:approve-large-payment', { activeTier: 2 }),
    ).resolves.toBeUndefined()
  })

  it('app:* gate WITH a policy enforces minTier', async () => {
    const policy = mergePolicy(PERSONAL_POLICY, {
      gates: {
        'app:approve-large-payment': { minTier: 1, factors: [{ anyOf: ['totp'] }] },
      },
    })
    await expect(
      checkGate(policy, 'app:approve-large-payment', {
        activeTier: 1,
        factors: [{ kind: 'totp' }],
      }),
    ).resolves.toBeUndefined()

    await expect(
      checkGate(policy, 'app:approve-large-payment', { activeTier: 1, factors: [] }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  it('warn.sharedDevice = "block" denies on shared device', async () => {
    const policy = mergePolicy(PERSONAL_POLICY, {
      gates: {
        'export-bundle': {
          minTier: 1,
          warn: { sharedDevice: 'block' },
        },
      },
    })
    try {
      await checkGate(policy, 'export-bundle', {
        activeTier: 1,
        sharedDevice: true,
      })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyDeniedError)
      if (err instanceof PolicyDeniedError) {
        expect(err.reason).toBe('shared-device-blocked')
      }
    }

    // Same call without sharedDevice flag passes
    await expect(
      checkGate(policy, 'export-bundle', { activeTier: 1 }),
    ).resolves.toBeUndefined()
  })
})

describe('describeGate', () => {
  it('returns ok: true on success', async () => {
    const verdict = await describeGate(PERSONAL_POLICY, 'enroll-user', {
      activeTier: 1,
    })
    expect(verdict.ok).toBe(true)
  })

  it('returns ok: false on denial without throwing', async () => {
    const verdict = await describeGate(PERSONAL_POLICY, 'rotate-passphrase', {
      activeTier: 1,
      factors: [],
    })
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe('missing-factor')
      expect(verdict.required.factors?.[0]?.anyOf).toContain('totp')
    }
  })
})

describe('mergePolicy', () => {
  it('preserves unrelated gates when overriding one', () => {
    const merged = mergePolicy(PERSONAL_POLICY, {
      gates: {
        'rotate-passphrase': { minTier: 1, factors: [{ anyOf: ['totp'] }] },
      },
    })
    // Override took effect
    expect(merged.gates['rotate-passphrase']?.factors?.[0]?.anyOf).toEqual(['totp'])
    // Other gates intact
    expect(merged.gates['export-plaintext']).toEqual(PERSONAL_POLICY.gates['export-plaintext'])
  })

  it('passes through the passphrase block', () => {
    const merged = mergePolicy(PERSONAL_POLICY, {
      passphrase: { minWords: 10 },
    })
    expect(merged.passphrase?.minWords).toBe(10)
  })
})

describe('_meta/policy round-trip', () => {
  it('persists and reloads PERSONAL_POLICY through a NoydbStore', async () => {
    const store = inlineMemory()
    await saveVaultPolicy(store, 'acme', PERSONAL_POLICY)
    const loaded = await loadVaultPolicy(store, 'acme')
    expect(loaded).toEqual(PERSONAL_POLICY)
  })

  it('returns undefined when no policy is on disk', async () => {
    const store = inlineMemory()
    const loaded = await loadVaultPolicy(store, 'never-saved')
    expect(loaded).toBeUndefined()
  })

  it('tolerates a corrupted policy document', async () => {
    const store = inlineMemory()
    await store.put('acme', '_meta', 'policy', {
      _noydb: 1,
      _v: 1,
      _ts: new Date().toISOString(),
      _iv: '',
      _data: '{not json',
    })
    const loaded = await loadVaultPolicy(store, 'acme')
    expect(loaded).toBeUndefined()
  })
})
