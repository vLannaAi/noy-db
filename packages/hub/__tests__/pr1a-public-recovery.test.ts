/**
 * PR1a — public-API exposure for paper recovery + db.getKeyring.
 *
 * Covers:
 *   - issue #28: db.team.getKeyring(vault) is reachable from outside the hub
 *     and returns the live UnlockedKeyring (same shape on-* packages
 *     expect — .deks Map, .kek CryptoKey, .role).
 *   - issue #39: mintPaperRecoveryEntry + unwrapDeksFromPaperEntry are
 *     re-exported from @noy-db/hub and produce entries that survive
 *     the full db.enrollRecovery → db.recoverPassphrase round-trip.
 *
 * The test imports from '../src/index.js' (the barrel) — not from
 * 'team/recovery.js' — so it pins the public-surface contract that
 * pre.8 ships. Removing either export would break this test.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import {
  createNoydb,
  type Noydb,
  mintPaperRecoveryEntry,
  unwrapDeksFromPaperEntry,
  type PaperRecoveryEntry,
} from '../src/index.js'

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
    async get(c: string, col: string, id: string) { return gc(c, col).get(id) },
    async put(c: string, col: string, id: string, env: EncryptedEnvelope) { gc(c, col).set(id, env) },
    async delete(c: string, col: string, id: string) { gc(c, col).delete(id) },
    async list(c: string, col: string) { return [...gc(c, col).keys()] },
    async loadAll() { return {} },
    async saveAll() {},
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
  } as unknown as NoydbStore
}

const STRONG_OLD = 'correct horse battery staple printer toaster'
const STRONG_NEW = 'glasses cabinet bicycle umbrella thunder velvet'

describe('PR1a public surface', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: STRONG_OLD,
    })
    await db.openVault('acme')
  })

  describe('db.getKeyring (#28)', () => {
    it('returns the live UnlockedKeyring with non-empty DEK map', async () => {
      const keyring = await db.team.getKeyring('acme')
      expect(keyring.userId).toBe('alice')
      expect(keyring.role).toBe('owner')
      expect(keyring.deks.size).toBeGreaterThan(0)
      expect(keyring.kek).toBeInstanceOf(CryptoKey)
    })

    it('returns equal-but-distinct snapshots on repeated calls (defensive copy, #88)', async () => {
      // Pre-#88 this test asserted Object.is identity (`a === b`). Post-#88
      // the contract changed: db.team.getKeyring() returns a defensive copy so
      // consumers can't corrupt the cache via .deks.set/.delete or
      // .permissions['k'] = ... mutations. Two calls now return distinct
      // outer objects with equal content; the underlying CryptoKey handles
      // are still shared (intentional — opaque references).
      const a = await db.team.getKeyring('acme')
      const b = await db.team.getKeyring('acme')
      expect(a).not.toBe(b)
      expect(a.deks).not.toBe(b.deks) // fresh Map per snapshot
      expect(a.userId).toBe(b.userId)
      expect(a.role).toBe(b.role)
      expect([...a.deks.keys()].sort()).toEqual([...b.deks.keys()].sort())
      // Underlying CryptoKey handles are shared (the cache and both
      // snapshots reference the same key — encrypt/decrypt all flow
      // through it).
      for (const coll of a.deks.keys()) {
        expect(a.deks.get(coll)).toBe(b.deks.get(coll))
      }
    })
  })

  describe('mintPaperRecoveryEntry / unwrapDeksFromPaperEntry (#39)', () => {
    it('mints an entry whose DEKs round-trip via the public unwrap helper', async () => {
      const keyring = await db.team.getKeyring('acme')
      const code = 'TESTCODE-PR1A-001'

      const entry = await mintPaperRecoveryEntry(keyring.deks, code, 'code-001')
      expect(entry.codeId).toBe('code-001')
      expect(entry.salt).toMatch(/^[A-Za-z0-9+/=]+$/)
      expect(entry.iv).toMatch(/^[A-Za-z0-9+/=]+$/)
      expect(entry.wrappedDeks).toMatch(/^[A-Za-z0-9+/=]+$/)

      const recovered = await unwrapDeksFromPaperEntry(entry, code)
      expect(recovered.size).toBe(keyring.deks.size)
      for (const collName of keyring.deks.keys()) {
        expect(recovered.has(collName)).toBe(true)
      }
    })

    it('round-trips through db.enrollRecovery + db.recoverPassphrase', async () => {
      const keyring = await db.team.getKeyring('acme')
      // Codes must be already-normalized (uppercase, no separators) so they
      // round-trip through recoverPassphrase's normalizePaperCode step.
      const codes = ['CODEAAA001', 'CODEBBB002', 'CODECCC003']
      const entries: PaperRecoveryEntry[] = await Promise.all(
        codes.map((c, i) => mintPaperRecoveryEntry(keyring.deks, c, `code-${i}`)),
      )

      await db.team.enrollRecovery('acme', { profile: 'paper', entries })

      // Use one code to recover under a new phrase.
      await db.team.recoverPassphrase('acme', {
        newPassphrase: STRONG_NEW,
        recoveryProof: { profile: 'paper', payload: { code: codes[0]! } },
      })

      // After recovery, a fresh client with the new phrase can open the vault.
      const reopen = await createNoydb({
        store: (db as unknown as { options: { store: NoydbStore } }).options.store,
        user: 'alice',
        secret: STRONG_NEW,
      })
      const reopenKeyring = await reopen.team.getKeyring('acme')
      expect(reopenKeyring.userId).toBe('alice')
      expect(reopenKeyring.deks.size).toBe(keyring.deks.size)
    }, 60_000)
  })
})
