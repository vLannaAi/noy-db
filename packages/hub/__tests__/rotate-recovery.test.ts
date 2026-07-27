/**
 * #121 — `db.team.rotateRecovery(vault, options, factors?)`.
 *
 * Deliberate paper-recovery-code regeneration. The user remembers their
 * secret but wants a fresh sheet (lost the printout, suspect compromise
 * of the off-site copy). Symmetric to the other tier-1-modifying actions:
 * gated, audit-trackable, ergonomic.
 *
 * Pinned behaviors:
 *   1. Returns `newCodes` of length matching the existing sheet by default.
 *   2. `count` override produces exactly that many codes.
 *   3. Replaces the sheet (not appends) — old codes invalidated.
 *   4. Newly minted codes round-trip through `db.recoverSecret`.
 *   5. `codeGenerator` hook overrides the default ULID format.
 *   6. The new `rotate-recovery` gate is enforced — PERSONAL allows
 *      minTier: 1; STRICT requires an off-device factor.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import {
  generateULID,
  mintPaperRecoveryEntry,
  loadPaperRecoveryEntries,
  type PaperRecoveryEntry,
} from '../src/index.js'
import { STRICT_POLICY } from '../src/with-party/policy/presets.js'
import { PolicyDeniedError } from '../src/kernel/errors.js'

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

const ALICE_PHRASE = 'correct horse battery staple printer toaster'

async function enrollCodes(db: Noydb, vault: string, count: number, prefix = 'CODE'): Promise<string[]> {
  const keyring = await db.team.getKeyring(vault)
  const codes: string[] = []
  const entries: PaperRecoveryEntry[] = []
  for (let i = 0; i < count; i++) {
    const code = `${prefix}${i.toString().padStart(3, '0')}AAAAAAA`.toUpperCase()
    codes.push(code)
    entries.push(await mintPaperRecoveryEntry(keyring.deks, code, `${prefix}-${i}`))
  }
  await db.team.enrollRecovery(vault, { profile: 'paper', entries })
  return codes
}

describe('db.rotateRecovery (#121)', () => {
  it('returns new codes of length matching the existing sheet by default', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    await enrollCodes(db, 'acme', 6)

    const result = await db.team.rotateRecovery('acme', { profile: 'paper' })
    expect(result.newCodes).toHaveLength(6)
    const post = await loadPaperRecoveryEntries(store, 'acme')
    expect(post).toHaveLength(6)
  }, 120_000)

  it('count override produces exactly that many codes', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    await enrollCodes(db, 'acme', 8)

    const result = await db.team.rotateRecovery('acme', { profile: 'paper', count: 12 })
    expect(result.newCodes).toHaveLength(12)
    const post = await loadPaperRecoveryEntries(store, 'acme')
    expect(post).toHaveLength(12)
  }, 120_000)

  it('replaces (not appends): old codes invalidated, new codes recover', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    const oldCodes = await enrollCodes(db, 'acme', 4)

    const result = await db.team.rotateRecovery('acme', { profile: 'paper' })
    // Old codes no longer match any persisted entry — recovery with one should fail.
    await expect(
      db.team.recoverSecret('acme', {
        newSecret: 'fresh secret after rotation today morning glass tower',
        recoveryProof: { profile: 'paper', payload: { code: oldCodes[0]! } },
      }),
    ).rejects.toThrow()

    // A new code DOES recover.
    const recovered = await db.team.recoverSecret('acme', {
      newSecret: 'fresh secret after rotation today morning glass tower',
      recoveryProof: { profile: 'paper', payload: { code: result.newCodes![0]! } },
    })
    expect(recovered).toBeDefined()
  }, 180_000)

  it('codeGenerator hook overrides the default ULID format', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    await enrollCodes(db, 'acme', 3)

    let counter = 0
    const result = await db.team.rotateRecovery('acme', {
      profile: 'paper',
      codeGenerator: () => `CUSTOM-CODE-${counter++}`,
    })
    expect(result.newCodes).toEqual(['CUSTOM-CODE-0', 'CUSTOM-CODE-1', 'CUSTOM-CODE-2'])
  }, 120_000)

  it('PERSONAL policy (default): tier-1 caller can rotate without factors', async () => {
    const store = inlineMemory()
    const db = await createNoydb({ store, user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    await enrollCodes(db, 'acme', 4)

    // Default PERSONAL_POLICY — rotate-recovery: { minTier: 1 }
    const result = await db.team.rotateRecovery('acme', { profile: 'paper' })
    expect(result.newCodes).toHaveLength(4)
  }, 120_000)

  it('STRICT policy: rejects rotation without an off-device factor', async () => {
    const store = inlineMemory()
    const db = await createNoydb({
      store, user: 'alice', secret: ALICE_PHRASE,
      policy: STRICT_POLICY,
    })
    await db.openVault('acme')
    await enrollCodes(db, 'acme', 4)

    await expect(
      db.team.rotateRecovery('acme', { profile: 'paper' }),
    ).rejects.toThrow(PolicyDeniedError)
  }, 120_000)

  it('rejects non-paper profiles (other profiles arrive with #10)', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    await enrollCodes(db, 'acme', 3)

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.team.rotateRecovery('acme', { profile: 'shamir' as any }),
    ).rejects.toThrow(/RecoveryProfileNotImplementedError|profile/i)
  }, 120_000)

  it('refuses to rotate when no paper sheet has been enrolled', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: ALICE_PHRASE })
    await db.openVault('acme')
    // NO enrollRecovery call — there is nothing to rotate.

    await expect(
      db.team.rotateRecovery('acme', { profile: 'paper' }),
    ).rejects.toThrow(/no recovery codes|nothing to rotate|not enrolled/i)
  }, 60_000)

  // Suppress unused import warning when generateULID isn't referenced
  void generateULID
})
