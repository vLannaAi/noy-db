/**
 * Managed-mode mandatory strong-recovery enforcement (#195).
 *
 * Three behaviors under test:
 *
 *   1. `passphraseMode: 'managed'` requires at least one STRONG
 *      recovery profile enrolled (Shamir today). Otherwise openVault
 *      throws ManagedRecoveryNotEnrolledError. Paper alone is not
 *      strong under managed mode.
 *
 *   2. `db.team.openVaultAndEnrollRecovery(vault, { recovery: [...] })`
 *      bootstraps a managed-mode vault and enrolls strong recovery
 *      atomically. Returns the vault handle plus show-once
 *      enrollment results (Shamir shares).
 *
 *   3. `db.team.recoverManagedPassphrase(vault, { recoveryProof })` mints
 *      a fresh sealed passphrase, replaces _meta/sealed-passphrase,
 *      and rewraps DEKs under the new KEK.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, SealingKeyProvider } from '../src/index.js'
import {
  createNoydb,
  MemorySealingKeyProvider,
  loadSealedPassphrase,
} from '../src/index.js'
import { ConflictError, ValidationError } from '../src/kernel/errors.js'
import { ManagedRecoveryNotEnrolledError } from '../src/kernel/errors.js'
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

function freshProvider(id: string): SealingKeyProvider {
  return new MemorySealingKeyProvider({ id })
}

const ALICE = 'alice'

describe('#195 — managed-mode strong-recovery enforcement', () => {
  describe('openVault rejection', () => {
    it('throws ManagedRecoveryNotEnrolledError when no strong recovery is enrolled', async () => {
      const db = await createNoydb({
        store: inlineMemory(),
        user: ALICE,
        passphraseMode: 'managed',
        sealingKey: freshProvider('test-1'),
      })
      await expect(db.openVault('acme')).rejects.toBeInstanceOf(ManagedRecoveryNotEnrolledError)
    })

    it('error message names the vault and suggests the bootstrap path', async () => {
      const db = await createNoydb({
        store: inlineMemory(),
        user: ALICE,
        passphraseMode: 'managed',
        sealingKey: freshProvider('test-2'),
      })
      try {
        await db.openVault('acme')
        expect.fail('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(ManagedRecoveryNotEnrolledError)
        const msg = (err as Error).message
        expect(msg).toContain('"acme"')
        expect(msg).toMatch(/openVaultAndEnrollRecovery|enrollRecovery/)
        expect(msg).toMatch(/shamir/i)
      }
    })

    it('standard-mode vaults are unaffected', async () => {
      const db = await createNoydb({
        store: inlineMemory(),
        user: ALICE,
        secret: 'correct horse battery staple printer toaster',
      })
      // No recovery enrolled, no requireRecovery — passes.
      await expect(db.openVault('acme')).resolves.toBeDefined()
    })
  })

  describe('openVaultAndEnrollRecovery', () => {
    it('bootstraps a managed-mode vault with Shamir and returns shares', async () => {
      const db = await createNoydb({
        store: inlineMemory(),
        user: ALICE,
        passphraseMode: 'managed',
        sealingKey: freshProvider('test-3'),
        shamirRecovery: shamirRecoveryProvider(),
      })

      const result = await db.team.openVaultAndEnrollRecovery('acme', {
        recovery: [{ profile: 'shamir', k: 2, n: 3 }],
      })

      expect(result.vault).toBeDefined()
      expect(result.recoveryEnrollments).toHaveLength(1)
      expect(result.recoveryEnrollments[0]!.shares).toHaveLength(3)
      expect(result.recoveryEnrollments[0]!.entryId).toBeDefined()
    })

    it('subsequent openVault calls succeed after atomic enrollment', async () => {
      const store = inlineMemory()
      const provider = freshProvider('test-4')

      const db1 = await createNoydb({
        store, user: ALICE,
        passphraseMode: 'managed', sealingKey: provider,
        shamirRecovery: shamirRecoveryProvider(),
      })
      await db1.team.openVaultAndEnrollRecovery('acme', {
        recovery: [{ profile: 'shamir', k: 2, n: 3 }],
      })

      // Same store, fresh Noydb instance — openVault should pass the
      // strong-recovery check without invoking the bootstrap path.
      const db2 = await createNoydb({
        store, user: ALICE,
        passphraseMode: 'managed', sealingKey: provider,
      })
      await expect(db2.openVault('acme')).resolves.toBeDefined()
    })

    it('rejects empty recovery array', async () => {
      const db = await createNoydb({
        store: inlineMemory(),
        user: ALICE,
        passphraseMode: 'managed',
        sealingKey: freshProvider('test-5'),
      })
      await expect(
        db.team.openVaultAndEnrollRecovery('acme', { recovery: [] }),
      ).rejects.toThrow(/at least one recovery/i)
    })

    it('rejects paper-only recovery under managed mode', async () => {
      const db = await createNoydb({
        store: inlineMemory(),
        user: ALICE,
        passphraseMode: 'managed',
        sealingKey: freshProvider('test-6'),
      })
      await expect(
        db.team.openVaultAndEnrollRecovery('acme', {
          recovery: [{ profile: 'paper', entries: [] }],
        }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('accepts mixed paper + shamir (shamir satisfies the strong requirement)', async () => {
      const db = await createNoydb({
        store: inlineMemory(),
        user: ALICE,
        passphraseMode: 'managed',
        sealingKey: freshProvider('test-7'),
        shamirRecovery: shamirRecoveryProvider(),
      })
      // Empty paper entries array — the paper profile is allowed
      // alongside shamir; the shamir profile is the one carrying the
      // "strong" requirement.
      const result = await db.team.openVaultAndEnrollRecovery('acme', {
        recovery: [
          { profile: 'shamir', k: 2, n: 3 },
          { profile: 'paper', entries: [] },
        ],
      })
      expect(result.recoveryEnrollments).toHaveLength(2)
    })

    it('two-step manual bootstrap works too (enrollRecovery before second openVault)', async () => {
      const db = await createNoydb({
        store: inlineMemory(),
        user: ALICE,
        passphraseMode: 'managed',
        sealingKey: freshProvider('test-8'),
        shamirRecovery: shamirRecoveryProvider(),
      })
      // First openVault throws (no strong recovery).
      await expect(db.openVault('acme')).rejects.toBeInstanceOf(ManagedRecoveryNotEnrolledError)
      // But enrollRecovery on the same vault works (it uses
      // getKeyringInternal directly, bypassing the policy bootstrap).
      const enrollResult = await db.team.enrollRecovery('acme', { profile: 'shamir', k: 2, n: 3 })
      expect(enrollResult.shares).toHaveLength(3)
      // Now openVault succeeds.
      await expect(db.openVault('acme')).resolves.toBeDefined()
    })
  })

  describe('recoverManagedPassphrase', () => {
    it('rejects when not in managed mode', async () => {
      const db = await createNoydb({
        store: inlineMemory(),
        user: ALICE,
        secret: 'correct horse battery staple printer toaster',
      })
      await db.openVault('acme')
      await expect(
        db.team.recoverManagedPassphrase('acme', {
          recoveryProof: { profile: 'shamir', payload: { shares: [] } },
        }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('mints fresh sealed passphrase and overwrites _meta/sealed-passphrase', async () => {
      const store = inlineMemory()
      const provider = freshProvider('test-9')
      const db = await createNoydb({
        store, user: ALICE,
        passphraseMode: 'managed', sealingKey: provider,
        shamirRecovery: shamirRecoveryProvider(),
      })
      const enroll = await db.team.openVaultAndEnrollRecovery('acme', {
        recovery: [{ profile: 'shamir', k: 2, n: 3 }],
      })
      const shares = enroll.recoveryEnrollments[0]!.shares!

      // Snapshot the pre-recovery sealed envelope.
      const beforeEnvelope = await loadSealedPassphrase(store, 'acme')
      expect(beforeEnvelope).toBeDefined()

      // Run managed recovery using the Shamir shares.
      await db.team.recoverManagedPassphrase('acme', {
        recoveryProof: {
          profile: 'shamir',
          payload: { shares: [shares[0]!, shares[1]!] },
        },
      })

      // The sealed envelope should be different — fresh random sealed.
      const afterEnvelope = await loadSealedPassphrase(store, 'acme')
      expect(afterEnvelope).toBeDefined()
      expect(afterEnvelope!.providerId).toBe(provider.id)
      expect(Array.from(afterEnvelope!.sealed)).not.toEqual(Array.from(beforeEnvelope!.sealed))
    })

    it('vault opens after managed recovery and accepts new writes (round-trip mechanics)', async () => {
      // NOTE: like paper-recovery (see rotate-recover.ts:521), the
      // current recovery flow restores only DEKs that existed AT
      // ENROLLMENT TIME. Data written between enrollment and recovery
      // on collections whose DEKs weren't yet minted at enrollment
      // would be unreadable. This is an architectural limitation
      // shared with paper recovery; tracked separately. This test
      // validates the round-trip MECHANICS (sealed-passphrase
      // replacement + keyring rewrap + openVault under fresh
      // envelope), not data-survival across collection-creation
      // boundaries.
      const store = inlineMemory()
      const provider = freshProvider('test-10')

      const db = await createNoydb({
        store, user: ALICE,
        passphraseMode: 'managed', sealingKey: provider,
        shamirRecovery: shamirRecoveryProvider(),
      })
      const enroll = await db.team.openVaultAndEnrollRecovery('acme', {
        recovery: [{ profile: 'shamir', k: 2, n: 3 }],
      })
      const shares = enroll.recoveryEnrollments[0]!.shares!
      db.close()

      // Reopen, run recovery.
      const db2 = await createNoydb({
        store, user: ALICE,
        passphraseMode: 'managed', sealingKey: provider,
        shamirRecovery: shamirRecoveryProvider(),
      })
      await db2.team.recoverManagedPassphrase('acme', {
        recoveryProof: {
          profile: 'shamir',
          payload: { shares: [shares[0]!, shares[1]!] },
        },
      })

      // Reopen vault under fresh sealed-passphrase, write and read
      // back — confirms the new KEK + DEK stack is fully functional.
      const v2 = await db2.openVault('acme')
      await v2.collection<{ id: string; note: string }>('notes').put('post', {
        id: 'post', note: 'written after recovery',
      })
      const note = await v2.collection<{ id: string; note: string }>('notes').get('post')
      expect(note).toEqual({ id: 'post', note: 'written after recovery' })
    })

    it('strong-recovery is preserved across recovery — shares still work for next recovery', async () => {
      const store = inlineMemory()
      const provider = freshProvider('test-11')

      const db = await createNoydb({
        store, user: ALICE,
        passphraseMode: 'managed', sealingKey: provider,
        shamirRecovery: shamirRecoveryProvider(),
      })
      const enroll = await db.team.openVaultAndEnrollRecovery('acme', {
        recovery: [{ profile: 'shamir', k: 2, n: 3 }],
      })
      const shares = enroll.recoveryEnrollments[0]!.shares!

      // Recover once.
      await db.team.recoverManagedPassphrase('acme', {
        recoveryProof: {
          profile: 'shamir',
          payload: { shares: [shares[0]!, shares[1]!] },
        },
      })

      // The Shamir entry should still exist on disk — shares are
      // reusable for future recoveries (per #196 spec §3.3).
      // Recovery a second time with a different K-of-N combination.
      await db.team.recoverManagedPassphrase('acme', {
        recoveryProof: {
          profile: 'shamir',
          payload: { shares: [shares[0]!, shares[2]!] },
        },
      })

      // Vault still opens after two recoveries.
      const v = await db.openVault('acme')
      expect(v).toBeDefined()
    })
  })
})
