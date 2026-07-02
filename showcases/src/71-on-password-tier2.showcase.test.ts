// @vitest-environment node
//
// Node's Web Crypto (`node:crypto`) is the spec implementation; happy-
// dom (the showcase suite default) ships a partial polyfill whose
// `subtle.exportKey('raw', dek)` rejects with `InvalidAccessException:
// key is not extractable` even when `extractable: true` was set at
// generation. The hub's `mintWrappedDeksBlob` exports each DEK
// (`subtle.exportKey('raw', dek)`) — a fully-spec WebCrypto runtime is
// the right fixture for this showcase. Other showcases keep happy-dom
// because they exercise DOM-bound surfaces (Vue / Pinia / React).
//
// Belt-and-braces: the `// @vitest-environment node` directive at top
// is the canonical override, but if a parent vitest config silently
// keeps happy-dom active (we have seen this with vitest 2.1 +
// environmentMatchGlobs ordering), the explicit globalThis.crypto
// rewire below restores the real Node Web Crypto unconditionally. The
// rewire is a no-op when node is already the active environment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import { webcrypto as nodeWebCrypto } from 'node:crypto'
if (
  typeof globalThis.crypto?.subtle?.constructor?.name === 'string' &&
  globalThis.crypto.subtle.constructor.name !== 'SubtleCrypto'
) {
  // happy-dom names its class differently; node's is `SubtleCrypto`.
  ;(globalThis as unknown as { crypto: Crypto }).crypto = nodeWebCrypto as unknown as Crypto
}

/**
 * Showcase 71 — on-password tier-2 capability matrix
 *
 * What you'll learn
 * ─────────────────
 * Tier-2 unlock through `@noy-db/on-password` produces an
 * `UnlockedKeyring` with `kek: null`. That keyring **can** read and
 * write records (the DEKs were unwrapped from the password slot) and
 * **can** mutate the user-envelope (own-only). It **cannot** perform
 * any tier-1 operation: enrolling/removing authenticator slots,
 * rotating the master phrase, peer-recovering another user, granting
 * or revoking — every one of those gates demands `minTier: 1`, and a
 * tier-2 session denies with `PolicyDeniedError`.
 *
 * Why it matters
 * ──────────────
 * The capability matrix is the load-bearing security contract of
 * tier-2 unlock. It is structurally invisible to crypto round-trip
 * tests (those only exercise wrap/unwrap) and to the OIDC + WebAuthn
 * showcases (those test bridging or PRF release, not the post-unlock
 * gate behaviour). A regression that silently allowed
 * `enrollAuthenticator` against a `kek: null` keyring would corrupt
 * the new slot's wrap-DEKs payload (`keyring.deks` is fine,
 * `keyring.kek` is null — the slot lookup-time wrap would point at
 * the right DEKs but the wrap-KEK variant would write a meaningless
 * blob), and would not surface in unit tests. This showcase pins the
 * matrix as executable spec.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 22-on-passphrase (tier-1 keyring shape).
 * - Showcase 30-on-pin (tier-3 quick-resume — the parallel pattern,
 *   PIN cannot run tier-1 ops either).
 *
 * What to read next
 * ─────────────────
 *   - showcase 31-on-threat (lockout state-machine — scenario 5 below
 *     uses it for the failed-password lockout test)
 *   - docs/services/auth-landscape.md (the "carries wrap-key
 *     material on its own" question that puts on-password in the
 *     same bucket as on-webauthn and excludes on-oidc)
 *   - docs/services/session-tiers.md → "Tier 2 — `on-password`"
 *
 * Spec mapping
 * ────────────
 * features.yaml → auths → on-password
 *
 * Out of scope
 * ────────────
 * - Real-provider testing: there is no provider for on-password —
 *   PBKDF2 + AES-GCM run identically everywhere. No Playwright, no
 *   Docker, no env gate.
 * - Cross-version slot compat: future work; pre-pre.8 wrap-KEK slots
 *   are tested in `packages/on-password/__tests__/on-password.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  createNoydb,
  PolicyDeniedError,
  ValidationError,
  type EncryptedEnvelope,
  type KeyringFile,
  type NoydbStore,
  type UnlockedKeyring,
} from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import {
  enrollPasswordAuthenticator,
  PasswordInvalidError,
  PasswordTooWeakError,
  verifyPasswordSlot,
} from '@noy-db/on-password'
import {
  initialLockoutState,
  isLocked,
  recordFailure,
  recordSuccess,
  type LockoutState,
} from '@noy-db/on-threat'

// ─── Test fixture ──────────────────────────────────────────────────────
// Constants reused across scenarios so failure messages name the same
// values the harness wrote. The phrase satisfies the default
// PassphrasePolicy (lowercase words, ≥6 words). The password
// deliberately does NOT — uppercase + digit + symbol exercises
// scenario 4 (password-policy ≠ phrase-policy).

const VAULT = 'showcase-71-vault'
const USER = 'alice'
const PHRASE = 'correct horse battery staple printer toaster'
const PASSWORD = 'Tier2-Password-2026!'
const PASSWORD_SLOT_ID = 'password'
const RECORD_ID = 'invoice-001'
const RECORD = { id: RECORD_ID, total: 12500, currency: 'THB' as const }

interface Invoice { id: string; total: number; currency: 'THB' | 'USD' }

/**
 * Spin up a fresh tier-1 vault, write a record, and enrol a password
 * slot. Returns the store + the password slot pulled from the
 * keyring file so each scenario can drive whichever cold-start path
 * it needs.
 *
 * The store is shared across scenarios via the returned reference;
 * each scenario closes its own `Noydb` handle but the underlying
 * `to-memory` map persists for the cold-start re-open.
 */
async function setupTier1WithPasswordSlot(): Promise<{
  store: NoydbStore
  /** Slot extracted from `_keyring/<USER>.authenticators[]` after enroll. */
  passwordSlot: KeyringFile['authenticators'] extends infer A
    ? A extends ReadonlyArray<infer S>
      ? S
      : never
    : never
}> {
  const store = memory()
  const db = await createNoydb({ store, user: USER, secret: PHRASE })
  const vault = await db.openVault(VAULT)

  await vault.collection<Invoice>('invoices').put(RECORD_ID, RECORD)

  const liveKeyring = await db.getKeyring(VAULT)
  const slotOptions = await enrollPasswordAuthenticator(liveKeyring, {
    id: PASSWORD_SLOT_ID,
    password: PASSWORD,
    minLength: 12,
  })
  await db.enrollAuthenticator(VAULT, slotOptions)

  // Read the slot back from disk — `db.enrollAuthenticator` persisted
  // it into `_keyring/<USER>.authenticators[]` under the wrap-DEKs
  // schema. Pulling it via the store mirrors what a cold-start
  // verifier does (no live `Noydb` available).
  const env = await store.get(VAULT, '_keyring', USER)
  if (!env) throw new Error('setupTier1WithPasswordSlot: keyring envelope missing after enroll')
  const file = JSON.parse(env._data) as KeyringFile
  const slot = (file.authenticators ?? []).find((a) => a.id === PASSWORD_SLOT_ID)
  if (!slot) throw new Error(`setupTier1WithPasswordSlot: slot "${PASSWORD_SLOT_ID}" not found after enroll`)

  db.close()
  return { store, passwordSlot: slot }
}

/**
 * Produce a tier-2 `Noydb` handle whose `activeTier` is 2 (set by
 * `unlockViaAuthenticator`). Cold-start through `createNoydb({
 * getKeyring })` would also yield a `kek: null` keyring but does NOT
 * currently set `activeTier` — see scenario 1's note. This helper is
 * the API path the capability matrix is documented against.
 */
async function openAtTier2(
  store: NoydbStore,
  slot: Awaited<ReturnType<typeof setupTier1WithPasswordSlot>>['passwordSlot'],
  password: string = PASSWORD,
): Promise<{ db: Awaited<ReturnType<typeof createNoydb>>; keyring: UnlockedKeyring }> {
  // Open with the tier-1 phrase to unwrap the keyring, then **switch**
  // to tier-2 via the slot. After `unlockViaAuthenticator` the cached
  // keyring + activeTier reflect the password unlock.
  const db = await createNoydb({ store, user: USER, secret: PHRASE })
  await db.openVault(VAULT)
  const keyring = await db.unlockViaAuthenticator(VAULT, PASSWORD_SLOT_ID, async (s) =>
    verifyPasswordSlot(s, password, { store, vault: VAULT, userId: USER }),
  )
  return { db, keyring }
}

// ─── Showcase ──────────────────────────────────────────────────────────

describe('Showcase 71 — on-password tier-2 capability matrix', () => {
  let openDbs: Array<Awaited<ReturnType<typeof createNoydb>>> = []

  afterEach(() => {
    for (const db of openDbs) db.close()
    openDbs = []
  })

  // ─── Scenario 1 — cold-start tier-2 unlock ──────────────────────
  it('cold-starts with (vault, userId, password) and decrypts a known record', async () => {
    const { store, passwordSlot } = await setupTier1WithPasswordSlot()

    // Mirrors a realistic login form. The consumer holds (vault,
    // userId, password) at boot; no master phrase available, no
    // pre-existing keyring in memory. `verifyPasswordSlot` unwraps
    // the slot AND loads identity from `_keyring/<userId>` — exactly
    // the cold-start contract.
    const db = await createNoydb({
      store,
      user: USER,
      getKeyring: async (vault) =>
        verifyPasswordSlot(passwordSlot, PASSWORD, { store, vault, userId: USER }),
    })
    openDbs.push(db)

    const vault = await db.openVault(VAULT)
    const decrypted = await vault.collection<Invoice>('invoices').get(RECORD_ID)
    expect(decrypted).toEqual(RECORD)
  })

  // ─── Scenario 2 — capability matrix on kek:null ─────────────────
  describe('scenario 2 — capability matrix on a kek:null keyring (tier-2)', () => {
    it('✅ collection.get / put / query succeed', async () => {
      const { store, passwordSlot } = await setupTier1WithPasswordSlot()
      const { db } = await openAtTier2(store, passwordSlot)
      openDbs.push(db)

      const vault = await db.openVault(VAULT)
      const invoices = vault.collection<Invoice>('invoices')

      // Read — DEKs are unwrapped, decrypt works.
      expect(await invoices.get(RECORD_ID)).toEqual(RECORD)

      // Write — encryption needs a DEK, not the KEK. Tier-2 has DEKs.
      await invoices.put('invoice-002', { id: 'invoice-002', total: 9000, currency: 'USD' })
      expect(await invoices.get('invoice-002')).toEqual({
        id: 'invoice-002', total: 9000, currency: 'USD',
      })

      // Query — same DEK path.
      const all = await invoices.list()
      expect(all.map((r) => r.id).sort()).toEqual(['invoice-001', 'invoice-002'])
    })

    it('✅ vault.user.updateMe (own-only writes) succeeds — edit-own-profile gate is minTier:3', async () => {
      const { store, passwordSlot } = await setupTier1WithPasswordSlot()
      const { db } = await openAtTier2(store, passwordSlot)
      openDbs.push(db)

      const vault = await db.openVault(VAULT)
      // PERSONAL_POLICY's `edit-own-profile` is `minTier: 3` — tier-2
      // (activeTier=2) clears the gate because 2 ≤ 3 (lower-numbered
      // tiers are MORE privileged in this model).
      const written = await vault.user.updateMe<{ displayName: string }>({
        displayName: 'Alice (tier-2 session)',
      })
      expect(written.data.displayName).toBe('Alice (tier-2 session)')
    })

    it('❌ db.enrollAuthenticator rejects with PolicyDeniedError (insufficient tier)', async () => {
      const { store, passwordSlot } = await setupTier1WithPasswordSlot()
      const { db, keyring } = await openAtTier2(store, passwordSlot)
      openDbs.push(db)

      // Build a synthetic password slot to attempt enrolment of —
      // the input is structurally valid; the gate is what should
      // reject. `enrollPasswordAuthenticator` works against a
      // `kek: null` keyring because it wraps DEKs, not the KEK.
      const newSlot = await enrollPasswordAuthenticator(keyring, {
        id: 'password-secondary',
        password: 'Tier2-Other-Password-2026!',
        minLength: 12,
      })

      await expect(db.enrollAuthenticator(VAULT, newSlot)).rejects.toBeInstanceOf(
        PolicyDeniedError,
      )
    })

    it('❌ db.removeAuthenticator rejects with PolicyDeniedError', async () => {
      const { store, passwordSlot } = await setupTier1WithPasswordSlot()
      const { db } = await openAtTier2(store, passwordSlot)
      openDbs.push(db)

      // Idempotent removal of an unknown slot would normally succeed
      // as a no-op — but the gate fires first, before any keyring
      // mutation, so the no-op never happens.
      await expect(db.removeAuthenticator(VAULT, 'totally-not-a-real-slot')).rejects.toBeInstanceOf(
        PolicyDeniedError,
      )
    })

    it('❌ db.rotatePassphrase rejects with PolicyDeniedError', async () => {
      const { store, passwordSlot } = await setupTier1WithPasswordSlot()
      const { db } = await openAtTier2(store, passwordSlot)
      openDbs.push(db)

      await expect(
        db.rotatePassphrase(VAULT, {
          oldPassphrase: PHRASE,
          newPassphrase: 'rotated horse battery staple printer toaster',
        }),
      ).rejects.toBeInstanceOf(PolicyDeniedError)
    })

    it('❌ db.recoverUser (peer-recovery) rejects with PolicyDeniedError', async () => {
      const { store, passwordSlot } = await setupTier1WithPasswordSlot()
      const { db } = await openAtTier2(store, passwordSlot)
      openDbs.push(db)

      await expect(
        db.recoverUser(VAULT, {
          userId: 'someone-else',
          passphrase: 'temporary horse battery staple printer toaster',
        }),
      ).rejects.toBeInstanceOf(PolicyDeniedError)
    })

    it('❌ db.grant rejects with PolicyDeniedError (enroll-user gate is minTier:1)', async () => {
      const { store, passwordSlot } = await setupTier1WithPasswordSlot()
      const { db } = await openAtTier2(store, passwordSlot)
      openDbs.push(db)

      await expect(
        db.grant(VAULT, {
          userId: 'bob',
          displayName: 'Bob',
          passphrase: 'fresh horse battery staple printer toaster',
          role: 'viewer',
        }),
      ).rejects.toBeInstanceOf(PolicyDeniedError)
    })

    it('❌ db.revoke rejects with PolicyDeniedError (revoke-user gate is minTier:1)', async () => {
      const { store, passwordSlot } = await setupTier1WithPasswordSlot()
      const { db } = await openAtTier2(store, passwordSlot)
      openDbs.push(db)

      await expect(db.revoke(VAULT, { userId: 'bob' })).rejects.toBeInstanceOf(PolicyDeniedError)
    })
  })

  // ─── Scenario 3 — re-elevation flow ─────────────────────────────
  it('scenario 3 — re-elevate to tier-1 by re-entering the master phrase, retry succeeds', async () => {
    const { store, passwordSlot } = await setupTier1WithPasswordSlot()
    const { db: tier2Db } = await openAtTier2(store, passwordSlot)
    openDbs.push(tier2Db)

    // Tier-2 → grant denied.
    await expect(
      tier2Db.grant(VAULT, {
        userId: 'bob',
        displayName: 'Bob',
        passphrase: 'fresh horse battery staple printer toaster',
        role: 'viewer',
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError)

    // Realistic re-elevation UX: the user closes the tier-2 session
    // and re-opens with the master phrase. Hub's activeTier defaults
    // to 1 on a fresh `createNoydb({ secret })`, so the same call
    // succeeds.
    tier2Db.close()
    const tier1Db = await createNoydb({ store, user: USER, secret: PHRASE })
    openDbs.push(tier1Db)
    await tier1Db.openVault(VAULT)

    await expect(
      tier1Db.grant(VAULT, {
        userId: 'bob',
        displayName: 'Bob',
        passphrase: 'fresh horse battery staple printer toaster',
        role: 'viewer',
      }),
    ).resolves.not.toThrow()

    expect((await tier1Db.listUsers(VAULT)).map((u) => u.userId).sort()).toEqual(['alice', 'bob'])
  })

  // ─── Scenario 4 — password policy ≠ phrase policy ────────────────
  describe('scenario 4 — password validator is independent of phrase validator', () => {
    it('enrols a password with uppercase + digits + symbols (the phrase validator would reject)', async () => {
      const store = memory()
      const db = await createNoydb({ store, user: USER, secret: PHRASE })
      openDbs.push(db)
      await db.openVault(VAULT)

      const liveKeyring = await db.getKeyring(VAULT)
      // The default phrase format is `^[a-z]+( [a-z]+){5,}$` — no
      // uppercase, no digits, no symbols. This password fails ALL
      // three constraints. `enrollPasswordAuthenticator` accepts it
      // because the password validator is separate.
      const slot = await enrollPasswordAuthenticator(liveKeyring, {
        password: 'Tier2-P@ssw0rd-2026!',
        minLength: 12,
        pattern: /[A-Z]/, // and the consumer can layer extra requirements
      })
      await expect(db.enrollAuthenticator(VAULT, slot)).resolves.not.toThrow()
    })

    it('rejects a phrase that violates phrase format even when it would pass the password validator', async () => {
      const store = memory()
      // Same password value attempted as a phrase — passes "≥12
      // chars" but violates the phrase format (uppercase, digits,
      // symbols, no spaces, single token). Tier-1 createOwnerKeyring
      // is opt-in to the validator via `validatePassphrase: true`;
      // hub's `assertStrongPassphrase` is the always-on path. We
      // exercise the always-on rotate-passphrase path here — the
      // simpler and more load-bearing surface.
      const db = await createNoydb({ store, user: USER, secret: PHRASE })
      openDbs.push(db)
      await db.openVault(VAULT)

      await expect(
        db.rotatePassphrase(VAULT, {
          oldPassphrase: PHRASE,
          // Same string the password validator above accepted.
          newPassphrase: 'Tier2-P@ssw0rd-2026!',
        }),
      ).rejects.toThrow(/passphrase|phrase|word/i)
    })
  })

  // ─── Scenario 5 — failed-password lockout via on-threat ─────────
  it('scenario 5 — N wrong passwords trip the on-threat lockout, correct password unlocks after window', async () => {
    const { store, passwordSlot } = await setupTier1WithPasswordSlot()

    // The lockout is a pure state machine the consumer threads
    // around the unlock attempt. Hub does NOT integrate it
    // automatically — the showcase models the canonical wrapper.
    const lockout: LockoutState = initialLockoutState()
    const config = { threshold: 3, windowMs: 60_000, cooldownMs: 50 } as const

    async function attemptUnlock(password: string): Promise<{ ok: boolean }> {
      if (isLocked(lockout)) return { ok: false }
      try {
        await verifyPasswordSlot(passwordSlot, password, {
          store, vault: VAULT, userId: USER,
        })
        recordSuccess(lockout)
        return { ok: true }
      } catch (err) {
        if (err instanceof PasswordInvalidError) {
          recordFailure(lockout, config)
          return { ok: false }
        }
        throw err
      }
    }

    // 3 failures trip the threshold.
    expect(await attemptUnlock('wrong-1')).toEqual({ ok: false })
    expect(await attemptUnlock('wrong-2')).toEqual({ ok: false })
    expect(await attemptUnlock('wrong-3')).toEqual({ ok: false })
    expect(isLocked(lockout)).toBe(true)

    // While locked, even the correct password is short-circuited
    // — that's the wrapper's job, not the verifier's.
    expect(await attemptUnlock(PASSWORD)).toEqual({ ok: false })

    // Wait out the cooldown — `recordFailure` sets `lockedUntil`
    // that many ms in the future.
    await new Promise((r) => setTimeout(r, 60))
    expect(isLocked(lockout)).toBe(false)

    // After the cooldown the slot itself is unchanged — the correct
    // password unlocks normally.
    expect(await attemptUnlock(PASSWORD)).toEqual({ ok: true })
    expect(lockout.failures).toBe(0)
    // Strikes latch — the keyring REMEMBERS it was attacked even
    // after a successful unlock. Useful for SOC dashboards.
    expect(lockout.strikes).toBe(1)
  }, 10_000)

  // ─── Scenario 6 — username-binding regression ───────────────────
  it('scenario 6 — right password + wrong userId rejects with PasswordInvalidError', async () => {
    const { store, passwordSlot } = await setupTier1WithPasswordSlot()

    // `verifyPasswordSlot` cross-references the slot's wrap-DEKs blob
    // against the userId-keyed envelope. A user that has no keyring
    // at all (`bob` was never granted) lacks `_keyring/bob`, so the
    // verifier throws `PasswordInvalidError` rather than silently
    // returning a keyring whose DEKs do not match the loaded
    // identity.
    await expect(
      verifyPasswordSlot(passwordSlot, PASSWORD, {
        store, vault: VAULT, userId: 'ghost-user',
      }),
    ).rejects.toBeInstanceOf(PasswordInvalidError)
  })

  // ─── Sanity rails ───────────────────────────────────────────────
  it('rejects an obviously-too-weak password at enroll time (PasswordTooWeakError)', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: USER, secret: PHRASE })
    openDbs.push(db)
    await db.openVault(VAULT)
    const liveKeyring = await db.getKeyring(VAULT)

    await expect(
      enrollPasswordAuthenticator(liveKeyring, { password: 'short', minLength: 12 }),
    ).rejects.toBeInstanceOf(PasswordTooWeakError)
  })

  // Pin a defensive sanity check: the tier-1 hub options that scenarios
  // depend on are still available. If a future refactor renames or
  // moves them, this check fails loudly here rather than mid-scenario.
  it('hub exports the symbols the matrix relies on', () => {
    expect(typeof createNoydb).toBe('function')
    expect(typeof memory).toBe('function')
    expect(PolicyDeniedError.prototype).toBeDefined()
    expect(ValidationError.prototype).toBeDefined()
    // Touch the unused-import diagnostic if a future change drops one.
    expect(([] as unknown as EncryptedEnvelope[]).length).toBe(0)
  })
})
