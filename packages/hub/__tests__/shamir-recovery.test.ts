/**
 * Shamir recovery profile dispatch (#196 slice 1).
 *
 * End-to-end tests for the three Shamir-flavored APIs:
 *   - db.team.enrollRecovery({ profile: 'shamir', k, n })
 *   - db.team.recoverSecret({ profile: 'shamir', shares })
 *   - db.team.rotateRecovery({ profile: 'shamir', k, n })
 *
 * The architectural pattern mirrors paper-recovery (mint a wrapped
 * DEK blob; the unlock material — recovery secret here, code there —
 * is the only path back). The contract changes are spelled out in
 * design-history/2026-05-23-shamir-recovery-dispatch.md §4.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb, type Noydb } from '../src/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import { shamirRecoveryProvider } from '@noy-db/on-shamir'

function inlineMemory(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let comp = data.get(v); if (!comp) { comp = new Map(); data.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    async get(v, c, id) { return gc(v, c).get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { gc(v, c).delete(id) },
    async list(v, c) { return [...gc(v, c).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
  }
}

const STRONG_OLD = 'correct horse battery staple printer toaster'
const STRONG_NEW = 'glasses cabinet bicycle umbrella thunder velvet'
const STRONG_NEW_2 = 'cathedral ravens whispering autumn velvet quilt'

async function freshDb(): Promise<Noydb> {
  const db = await createNoydb({
    store: inlineMemory(),
    user: 'alice',
    secret: STRONG_OLD,
    shamirRecovery: shamirRecoveryProvider(),
  })
  await db.openVault('acme')
  return db
}

describe('Shamir recovery enrollment (#196 slice 1)', () => {
  let db: Noydb
  beforeEach(async () => { db = await freshDb() })

  it('returns exactly n share strings and a stable entryId', async () => {
    const result = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3 })
    expect(result.shares).toBeDefined()
    expect(result.shares!.length).toBe(3)
    expect(result.entryId).toBeTypeOf('string')
    expect(result.entryId.length).toBeGreaterThan(0)
    for (const s of result.shares!) {
      expect(s).toBeTypeOf('string')
      expect(s.length).toBeGreaterThan(0)
    }
  })

  it('produces base32-shaped share strings (canonical wire format)', async () => {
    const { shares } = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3 })
    for (const s of shares!) {
      // Per on-shamir share-format: 'SHAMIR_S<x>_K<k>N<n>__<base32-groups>'
      expect(s).toMatch(/^SHAMIR_S\d+_K2N3__[A-Z2-7\-]+$/)
    }
  })

  it('accepts a caller-supplied label and entryId', async () => {
    const result = await db.team.enrollRecovery('acme', {
      profile: 'shamir',
      k: 2,
      n: 3,
      label: 'board escrow',
      entryId: 'board',
    })
    expect(result.entryId).toBe('board')
  })

  it('rejects k < 2', async () => {
    await expect(
      db.team.enrollRecovery('acme', { profile: 'shamir', k: 1, n: 3 }),
    ).rejects.toThrow(/k.*>=\s*2|k must/i)
  })

  it('rejects n < k', async () => {
    await expect(
      db.team.enrollRecovery('acme', { profile: 'shamir', k: 3, n: 2 }),
    ).rejects.toThrow(/k\s*<=\s*n|k <= n/i)
  })

  it('rejects n > 255', async () => {
    await expect(
      db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 256 }),
    ).rejects.toThrow(/255|n must/i)
  })
})

describe('Shamir recovery — recoverSecret round-trip', () => {
  let db: Noydb
  let shares: string[]
  let entryId: string

  beforeEach(async () => {
    db = await freshDb()
    const result = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3 })
    shares = [...result.shares!]
    entryId = result.entryId
  })

  it('recovers with shares 1+2 (any K of N)', async () => {
    await db.team.recoverSecret('acme', {
      newSecret: STRONG_NEW,
      recoveryProof: {
        profile: 'shamir',
        payload: { shares: [shares[0]!, shares[1]!] },
      },
    })
    // Verify the new secret actually unlocks the vault.
    const db2 = await createNoydb({ store: (db as any).options.store, user: 'alice', secret: STRONG_NEW })
    const keyring = await db2.team.getKeyring('acme')
    expect(keyring.userId).toBe('alice')
  })

  it('recovers with shares 1+3 (different combination)', async () => {
    await db.team.recoverSecret('acme', {
      newSecret: STRONG_NEW,
      recoveryProof: {
        profile: 'shamir',
        payload: { shares: [shares[0]!, shares[2]!] },
      },
    })
    const db2 = await createNoydb({ store: (db as any).options.store, user: 'alice', secret: STRONG_NEW })
    const keyring = await db2.team.getKeyring('acme')
    expect(keyring.userId).toBe('alice')
  })

  it('recovers with shares 2+3', async () => {
    await db.team.recoverSecret('acme', {
      newSecret: STRONG_NEW,
      recoveryProof: {
        profile: 'shamir',
        payload: { shares: [shares[1]!, shares[2]!] },
      },
    })
    const db2 = await createNoydb({ store: (db as any).options.store, user: 'alice', secret: STRONG_NEW })
    expect(keyring => keyring.userId === 'alice').toBeTruthy()
    expect((await db2.team.getKeyring('acme')).userId).toBe('alice')
  })

  it('recovers with all 3 shares (above threshold is fine)', async () => {
    await db.team.recoverSecret('acme', {
      newSecret: STRONG_NEW,
      recoveryProof: {
        profile: 'shamir',
        payload: { shares },
      },
    })
    const db2 = await createNoydb({ store: (db as any).options.store, user: 'alice', secret: STRONG_NEW })
    expect((await db2.team.getKeyring('acme')).userId).toBe('alice')
  })

  it('rejects below-threshold (1 share for 2-of-3)', async () => {
    await expect(
      db.team.recoverSecret('acme', {
        newSecret: STRONG_NEW,
        recoveryProof: {
          profile: 'shamir',
          payload: { shares: [shares[0]!] },
        },
      }),
    ).rejects.toThrow(/threshold|insufficient|need.*shares|2/i)
  })

  it('rejects empty shares array', async () => {
    await expect(
      db.team.recoverSecret('acme', {
        newSecret: STRONG_NEW,
        recoveryProof: { profile: 'shamir', payload: { shares: [] } },
      }),
    ).rejects.toThrow()
  })

  it('rejects malformed share strings (non-base32 garbage)', async () => {
    await expect(
      db.team.recoverSecret('acme', {
        newSecret: STRONG_NEW,
        recoveryProof: {
          profile: 'shamir',
          payload: { shares: ['!!!not-a-share!!!', '@@@nope@@@'] },
        },
      }),
    ).rejects.toThrow()
  })

  it('does NOT burn shares — same shares unlock again after a future enrollment', async () => {
    // First recovery succeeds with the original shares.
    await db.team.recoverSecret('acme', {
      newSecret: STRONG_NEW,
      recoveryProof: {
        profile: 'shamir',
        payload: { shares: [shares[0]!, shares[1]!] },
      },
    })
    // The Shamir entry is preserved (unlike paper-burn). Re-open
    // under the new secret, then the same shares can recover again.
    const db2 = await createNoydb({ store: (db as any).options.store, user: 'alice', secret: STRONG_NEW, shamirRecovery: shamirRecoveryProvider() })
    await db2.openVault('acme')
    await db2.team.recoverSecret('acme', {
      newSecret: STRONG_NEW_2,
      recoveryProof: {
        profile: 'shamir',
        payload: { shares: [shares[0]!, shares[2]!] },
      },
    })
    const db3 = await createNoydb({ store: (db as any).options.store, user: 'alice', secret: STRONG_NEW_2 })
    expect((await db3.team.getKeyring('acme')).userId).toBe('alice')

    // The unused entryId is still in scope and still valid.
    expect(entryId.length).toBeGreaterThan(0)
  })
})

describe('Shamir recovery — multiple coexisting entries', () => {
  let db: Noydb
  let storeRef: NoydbStore

  beforeEach(async () => {
    db = await freshDb()
    storeRef = (db as any).options.store
  })

  it('allows two Shamir entries to coexist', async () => {
    const a = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3, entryId: 'board' })
    const b = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 2, entryId: 'spouse' })
    expect(a.entryId).toBe('board')
    expect(b.entryId).toBe('spouse')
    expect(a.shares!.length).toBe(3)
    expect(b.shares!.length).toBe(2)
  })

  it('disambiguates via explicit entryId in the recovery proof', async () => {
    const a = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3, entryId: 'board' })
    await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 2, entryId: 'spouse' })

    await db.team.recoverSecret('acme', {
      newSecret: STRONG_NEW,
      recoveryProof: {
        profile: 'shamir',
        payload: { entryId: 'board', shares: [a.shares![0]!, a.shares![1]!] },
      },
    })
    const db2 = await createNoydb({ store: storeRef, user: 'alice', secret: STRONG_NEW })
    expect((await db2.team.getKeyring('acme')).userId).toBe('alice')
  })

  it('iterates entries when no entryId provided (first that combines wins)', async () => {
    const a = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3, entryId: 'board' })
    await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 2, entryId: 'spouse' })

    // Provide board's shares; no entryId. Should find the board entry by trial.
    await db.team.recoverSecret('acme', {
      newSecret: STRONG_NEW,
      recoveryProof: {
        profile: 'shamir',
        payload: { shares: [a.shares![0]!, a.shares![1]!] },
      },
    })
    const db2 = await createNoydb({ store: storeRef, user: 'alice', secret: STRONG_NEW })
    expect((await db2.team.getKeyring('acme')).userId).toBe('alice')
  })

  it('rejects when entryId points at non-existent entry', async () => {
    const a = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3, entryId: 'board' })
    await expect(
      db.team.recoverSecret('acme', {
        newSecret: STRONG_NEW,
        recoveryProof: {
          // entryId pointing at something that doesn't exist; shares
          // are real (well-formed) so the failure must come from the
          // entryId check, not share decoding.
          profile: 'shamir',
          payload: { entryId: 'nonexistent', shares: [a.shares![0]!, a.shares![1]!] },
        },
      }),
    ).rejects.toThrow(/no.*entry|entryId|not.*found/i)
  })

  it('rejects a mixed-bag of shares from two different entries (per-entry contract, #211)', async () => {
    // Enroll two separate Shamir entries, each 2-of-3.
    const a = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3, entryId: 'board' })
    const b = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3, entryId: 'spouse' })

    // Mixed bag: one share from entry A + one share from entry B, no entryId.
    // AES-GCM auth-tag will reject for every candidate entry — fails closed.
    await expect(
      db.team.recoverSecret('acme', {
        newSecret: STRONG_NEW,
        recoveryProof: {
          profile: 'shamir',
          payload: { shares: [a.shares![0]!, b.shares![0]!] },
        },
      }),
    ).rejects.toThrow()

    // Supplying a same-entry pair for entry A (no entryId) DOES recover —
    // the contract is "group shares per entry," not "shamir is broken."
    await db.team.recoverSecret('acme', {
      newSecret: STRONG_NEW,
      recoveryProof: {
        profile: 'shamir',
        payload: { shares: [a.shares![0]!, a.shares![1]!] },
      },
    })
    const db2 = await createNoydb({ store: storeRef, user: 'alice', secret: STRONG_NEW, shamirRecovery: shamirRecoveryProvider() })
    expect((await db2.team.getKeyring('acme')).userId).toBe('alice')
  })
})

describe('Shamir recovery — rotateRecovery', () => {
  let db: Noydb
  let storeRef: NoydbStore

  beforeEach(async () => {
    db = await freshDb()
    storeRef = (db as any).options.store
  })

  it('replaces an existing entry; old shares no longer combine, new shares do', async () => {
    const a = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3 })
    const oldShares = [...a.shares!]
    const oldEntryId = a.entryId

    const rotated = await db.team.rotateRecovery('acme', { profile: 'shamir', k: 2, n: 3, entryId: oldEntryId })
    expect(rotated.newShares).toBeDefined()
    expect(rotated.newShares!.length).toBe(3)
    expect(rotated.entryId).toBe(oldEntryId)

    // Old shares no longer recover (they wrap a different recovery secret).
    await expect(
      db.team.recoverSecret('acme', {
        newSecret: STRONG_NEW,
        recoveryProof: { profile: 'shamir', payload: { shares: [oldShares[0]!, oldShares[1]!] } },
      }),
    ).rejects.toThrow()

    // New shares do recover.
    await db.team.recoverSecret('acme', {
      newSecret: STRONG_NEW,
      recoveryProof: {
        profile: 'shamir',
        payload: { shares: [rotated.newShares![0]!, rotated.newShares![1]!] },
      },
    })
    const db2 = await createNoydb({ store: storeRef, user: 'alice', secret: STRONG_NEW })
    expect((await db2.team.getKeyring('acme')).userId).toBe('alice')
  })

  it('rejects rotation when entryId is ambiguous (multiple entries, no entryId given)', async () => {
    await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3, entryId: 'board' })
    await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 2, entryId: 'spouse' })
    await expect(
      db.team.rotateRecovery('acme', { profile: 'shamir', k: 2, n: 3 }),
    ).rejects.toThrow(/ambiguous|entryId|multiple/i)
  })

  it('rejects rotation when no Shamir entry exists', async () => {
    await expect(
      db.team.rotateRecovery('acme', { profile: 'shamir', k: 2, n: 3 }),
    ).rejects.toThrow(/no.*shamir.*enrol|no recovery|enroll/i)
  })
})

describe('Shamir recovery — error reporting at error class level', () => {
  it('RecoveryProfileNotImplementedError no longer thrown for "shamir"', async () => {
    const db = await freshDb()
    // The previous behavior was: enrollRecovery({ profile: 'shamir' }) →
    // throws RecoveryProfileNotImplementedError. After this slice, it
    // should succeed.
    await expect(
      db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3 }),
    ).resolves.toBeDefined()
  })
})

describe('Shamir recovery — no-provider guard', () => {
  it('shamir enroll throws a clear error when no provider is configured', async () => {
    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: STRONG_OLD,
      // intentionally NO shamirRecovery
    })
    await db.openVault('acme')
    await expect(
      db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3 }),
    ).rejects.toThrow(/requires a NoydbShamir/)
  })
})
