# session-tiers

> **Three-tier authentication, multi-slot keyring, policy gates.**
>
> **Status:** design (locked 2026-05-04). Implementation pending.
> **Cluster:** auth
> **Cross-cuts:** every `@noy-db/on-*` package, `@noy-db/hub` core (KEK derivation, keyring layout, session module).
> **Tracking:** [issue #7](https://github.com/vLannaAi/noy-db/issues/7) (phrase strength validator).

## Overview

noy-db's authentication is structured as a **three-tier privilege ladder**. Each tier is bounded above by the next; only the tier above can reset the tier below. Sensitive operations (rotate the passphrase, enroll a new authenticator, export plaintext, grant a user, …) are guarded by a developer-configurable **policy gate DSL** that declares which tier and which extra factors a given action requires.

The model exists to satisfy three competing constraints at once:

1. **Zero-knowledge.** The admin must never know the user's passphrase. The user controls the root secret.
2. **Ergonomic daily use.** Users do not type the master passphrase every time they open the vault. Daily login goes through tier 2; quick resume after idle goes through tier 3.
3. **Robust failure modes.** Lost device, lost passkey, forgotten passphrase, coerced user — each has a recovery path that does not collapse the security model.

The `@noy-db/on-*` family already provides the cryptographic primitives. This document specifies how they compose into a coherent session lifecycle and how a developer configures it.

## The three tiers

| Tier | Name | Role | Lifetime | Storage of the factor |
|---|---|---|---|---|
| **1** | **Passphrase** (root) | Master key — derives the KEK via PBKDF2. **Factory-fixed in `@noy-db/hub` core**, no `on-passphrase` package. | Years; touched only at enrollment, recovery, and tier-1-gated actions. | User's head (default) or `SealingKeyProvider` (managed mode). |
| **2** | **Authenticate** | Daily login — replaces passphrase entry. **Multi-slot** (LUKS pattern): any one enrolled method unlocks. | Days/weeks (configurable). On expiry → re-authenticate. | `on-webauthn` / `on-oidc` / `on-password` slots in the keyring file. |
| **3** | **Unlock** | Quick-resume after idle. Idle-timeout configurable per app. | Minutes (e.g. 15 min). On expiry → fall back to tier 2. | `on-pin` (the canonical tier-3 primitive). |

A privileged auxiliary layer sits alongside the ladder:

| Auxiliary | Name | Role |
|---|---|---|
| **2FA factors** | `on-totp`, `on-email-otp`, `on-recovery`, `on-shamir` (and roaming `on-webauthn`) | Off-device proofs required by policy gates for sensitive actions. Not session tiers — fresh proofs per gated action. |
| **Threat overlay** | `on-threat` | Lockout, duress, honeypot. Policy-independent overlay on tier 1/2 attempts. |

## Tier 1 — Passphrase (factory-fixed core)

The passphrase is the only secret the user genuinely owns. It derives the KEK via PBKDF2-SHA256 with 600,000 iterations (CLAUDE.md invariant). Tier 1 is **never** configured by the developer at the crypto layer — KDF, wrap algorithm (AES-KW), envelope format, salt size, and IV size are all repository invariants. The hub does not export iteration-count or algorithm options.

### Phrase format

Passphrases are **phrases**: multiple simple words, easy to remember, structurally constrained so a weak choice cannot silently collapse the security floor.

| Rule | Default | Strict policy |
|---|---|---|
| Pattern | `/^[a-z]+( [a-z]+){5,}$/` | `/^[a-z]+( [a-z]+){7,}$/` |
| Lowercase letters and single spaces only | ✓ | ✓ |
| No punctuation, symbols, digits | ✓ | ✓ |
| No leading or trailing whitespace | ✓ | ✓ |
| No repeated spaces | ✓ | ✓ |
| Minimum word count | 6 (~77 bits) | 8 (~103 bits) |
| Minimum word length | 3 characters | 3 characters |
| Repeated adjacent words rejected | ✓ | ✓ |

Examples:

```
✅ "correct horse battery staple printer toaster"
✅ "glasses cabinet bicycle umbrella thunder velvet"
❌ "abc"                                              (single word, too short)
❌ "Correct horse battery staple printer toaster"    (uppercase)
❌ "correct  horse battery staple printer toaster"   (double space)
❌ "correct horse battery staple printer the the"    (repeated adjacent)
❌ "correct horse battery staple printer"            (5 words; default needs 6)
❌ "correct horse battery staple printer toaster!"   (punctuation)
```

The 7,776-word EFF wordlist contributes ~12.9 bits of entropy per word; six words clear the 75-bit threshold commonly cited as adequate for cryptographic secrets, eight words clear 100 bits.

### Strength validation

The hub ships a `validatePassphrase()` helper and runs it **default-on** at every passphrase ingress (`createOwnerKeyring`, `grant`, `rotatePassphrase`). Override is explicit:

```ts
import { validatePassphrase } from '@noy-db/hub'

validatePassphrase("correct horse battery staple printer toaster")
// → { ok: true, words: 6 }

validatePassphrase("abc")
// → { ok: false, reason: 'too-few-words', minimum: 6, got: 1 }

createOwnerKeyring(store, vault, userId, "abc")
// → throws WeakPassphraseError

createOwnerKeyring(store, vault, userId, "abc", { allowWeakPassphrase: true })
// → accepted (test fixtures, CLI scripts)
```

Tracked at [issue #7](https://github.com/vLannaAi/noy-db/issues/7).

### Passphrase string handling (developer responsibility)

The cryptographic risk is in the hub. The **handling discipline** is in the developer's code:

- Do not write the passphrase to logs, telemetry, error reports, or analytics events.
- Do not persist it in `localStorage`, cookies, browser session storage, or any in-process cache that outlives the unlock operation.
- Do not pre-fill it from clipboard or autocomplete. Use `<input type="password" autocomplete="new-password">` for enrollment forms.
- The hub provides a typed brand: `type Passphrase = string & { readonly __brand: 'passphrase' }` to discourage accidental serialization.

## Tier 2 — Authenticate (multi-slot)

A user enrolls one or more **authenticate slots** during their first session. Each slot independently wraps the same KEK under a method-specific key. Adding or removing a slot is a constant-time keyring write — no DEK re-keying.

### Keyring file extension

```ts
interface KeyringFile {
  // existing tier-1 fields (user_id, role, permissions, salt, deks, granted_by, ...)

  // NEW — tier-2 slots; any one unlocks the same KEK
  authenticators?: KeyringAuthenticator[]

  // NEW — per-keyring policy override (forward-compat, see Storage location)
  policy?: VaultPolicy
}

interface KeyringAuthenticator {
  id: string                                // 'webauthn-yubikey-blue', 'oidc-google', 'password-daily'
  method: 'webauthn' | 'oidc' | 'password'
  enrolled_at: string                        // ISO 8601
  enrolled_via_tier: 1 | 2                   // tier-1 enrolls a fresh slot; tier-2 may add a sibling per policy
  wrapped_kek: string                        // base64 — KEK wrapped under method-derived key
  meta: Record<string, unknown>              // method-specific (cred id, issuer/sub, salt)
}
```

### Available tier-2 methods

| Method | Package | Factor | Notes |
|---|---|---|---|
| `webauthn` | [`@noy-db/on-webauthn`](../packages/on-webauthn) | device (platform passkey) or possession (roaming key) | PRF extension preferred. Distinguish platform vs roaming via `requireSingleDevice` / `BE` flag. |
| `oidc` | [`@noy-db/on-oidc`](../packages/on-oidc) | possession (provider session) + knowledge (split-key passphrase half) | Half the KEK lives on the device, half is fetched from the OIDC provider's key connector on successful federated login. |
| `password` | `@noy-db/on-password` (TBD — design-only) | knowledge (separate from tier-1 phrase) | Tier-2 daily password — distinct secret from the tier-1 phrase. PBKDF2-derived wrapping key in its own slot. Pair with `on-email-otp` or `on-totp` for the SaaS UX. |

`on-password` is interpreted as **tier-2 daily password as separate secret** (locked 2026-05-04). It is not a rebrand of the tier-1 phrase. Users have two distinct credentials: a rarely-typed master phrase (tier 1) and a daily password (tier 2). Failure-mode mitigation: enforce different minimum strength rules (tier 1 = phrase format; tier 2 = ≥12 chars or a developer-defined regex).

### API

```ts
// Enroll a new tier-2 slot. Requires a tier-1 unlock or a tier-2 unlock matching policy gate `enroll-authenticator`.
await db.enrollAuthenticator(unlockedKeyring, {
  id: 'webauthn-yubikey-blue',
  method: 'webauthn',
  enrollment: webauthnEnrollment,            // produced by on-webauthn during user gesture
})

// Remove a tier-2 slot. Gated by `remove-authenticator`.
await db.removeAuthenticator(unlockedKeyring, 'webauthn-yubikey-blue', { factorProofs: [...] })

// Unlock via any enrolled slot.
const unlocked = await db.unlockViaAuthenticator(slotId, methodSpecificProof)
```

## Tier 3 — Unlock (quick-resume)

The canonical tier-3 primitive is `@noy-db/on-pin`. Its README states the contract: *"PIN never replaces the passphrase; only resumes an already-unlocked session."* The PIN derives a wrapping key over already-cached DEKs; on idle expiry, the cache is wiped and tier 2 must be re-presented.

```ts
await db.enrollUnlock(unlockedKeyring, {
  method: 'pin',
  pin: '1234',                                // user-chosen, dev-validated minimum length
  idleMs: 15 * 60 * 1000,                     // per-app configurable
})

await db.unlockViaPin('1234')                 // succeeds only within idleMs window
```

The idle timeout is a per-application choice — a high-touch retail kiosk might use 5 minutes, a single-user tablet 30 minutes. Tier 3 is **never** safe on shared workstations; the cached DEKs persist on the device for the duration of the idle window.

## Policy gates DSL

Sensitive operations are gated by a typed policy object. The developer supplies a `VaultPolicy` at vault creation; the hub merges it onto a built-in preset.

### `VaultPolicy` shape

```ts
interface VaultPolicy {
  passphrase?: PassphraseStrengthPolicy
  gates: Partial<Record<GateName, GatePolicy>>
}

interface PassphraseStrengthPolicy {
  minWords?: number                            // default 6, strict 8
  minWordLength?: number                       // default 3
  rejectRepeatedAdjacent?: boolean             // default true
}

interface GatePolicy {
  minTier: 1 | 2 | 3                           // session tier required
  factors?: ReadonlyArray<FactorRequirement>   // extra fresh proofs at action time
  warn?: WarningRules                          // soft signals, never block
  enabled?: boolean                            // false disables the action entirely (managed mode)
}

interface FactorRequirement {
  anyOf: ReadonlyArray<FactorKind>
  count?: number                               // default 1
  freshnessMs?: number                         // default 5 minutes
}

type FactorKind = 'totp' | 'email-otp' | 'recovery' | 'shamir' | 'webauthn-roaming'

interface WarningRules {
  sharedDevice?: 'warn' | 'block'              // platform-passkey + tier-1 op
  weakAuthenticator?: 'warn' | 'block'         // password tier-2 alone for sensitive op
}
```

### Built-in gates

| Gate name | Purpose | Default policy (`PERSONAL_POLICY`) | Strict policy |
|---|---|---|---|
| `rotate-passphrase` | User remembers old, sets new | `minTier: 1`, factor: `[totp \| email-otp \| recovery]` | `count: 2` factors |
| `recover-passphrase` | User forgot, supplies recovery | varies by recovery profile | varies |
| `enroll-authenticator` | Add a tier-2 slot | `minTier: 1` | `minTier: 1`, factor: `[totp \| email-otp]` |
| `remove-authenticator` | Remove a tier-2 slot | `minTier: 1` | `minTier: 1`, factor: `[totp \| email-otp]` |
| `rotate-unlock` | Change tier-3 method | `minTier: 2` | `minTier: 1` |
| `enroll-user` | Grant a new keyring | `minTier: 1` | `minTier: 1`, factor: `[totp \| email-otp]` |
| `revoke-user` | Revoke a keyring | `minTier: 1` | `minTier: 1`, factor: `[totp \| email-otp]` |
| `export-bundle` | Encrypted `.noydb` bundle | `minTier: 1` | `minTier: 1`, factor: `[totp \| email-otp]`, `warn: { sharedDevice: 'block' }` |
| `export-plaintext` | CSV/XLSX/JSON export | `minTier: 1`, factor: `[totp \| email-otp]` | `count: 2` factors, `warn: { sharedDevice: 'block' }` |

App-defined gates use the `app:*` namespace (e.g. `app:approve-large-payment`) and reuse the same engine.

### Presets

```ts
import { createNoydb, PERSONAL_POLICY, STRICT_POLICY } from '@noy-db/hub'

// Default — single-user / SMB
const db = await createNoydb({ store, getKeyring, policy: PERSONAL_POLICY })

// Strict — regulated / shared-workstation
const db = await createNoydb({ store, getKeyring, policy: STRICT_POLICY })

// Custom override on top of a preset
const db = await createNoydb({
  store,
  getKeyring,
  policy: {
    ...PERSONAL_POLICY,
    gates: {
      ...PERSONAL_POLICY.gates,
      'rotate-passphrase': { minTier: 1, factors: [{ anyOf: ['totp', 'shamir'] }] },
      'app:approve-large-payment': { minTier: 2, factors: [{ anyOf: ['totp'] }] },
    },
  },
})
```

Unspecified gates inherit from the preset — overriding `rotate-passphrase` does not wipe out rules on `export-bundle`.

### `checkGate()` API

```ts
import { PolicyDeniedError } from '@noy-db/hub'

try {
  await db.checkGate('app:approve-large-payment', {
    factors: [{ kind: 'totp', code: '123456' }],
  })
  await invoices.put(payment)
} catch (err) {
  if (err instanceof PolicyDeniedError) {
    // err.gate, err.reason ('insufficient-tier' | 'missing-factor' | 'stale-proof' | 'disabled'), err.required
  }
}
```

### Storage location (A-now-with-C-on-disk-format)

Locked 2026-05-04: **v1.0 stores one policy document per vault** (Option A). The keyring schema reserves a per-keyring `policy?: VaultPolicy` field for forward-compatible Option C, but the merge logic is not in v1.0.

| Layer | v1.0 behavior | Forward compatibility |
|---|---|---|
| Vault `_meta/policy` | Single source of truth. Set by owner at vault creation. Encrypted under a system DEK every keyring holds. | Continues as the *floor*. |
| Keyring `policy?` field | Reserved field — written by `grant()` if developer specifies `policyOverride`, but the merge engine ignores it in v1.0. | Activated in a later release as a *strengthening-only* override (a per-keyring policy can add factors or raise `minTier`, never weaken). |

Adding the merge engine later is a behavior change, not a format change. Existing vaults will not need migration when Option C ships.

## Tier-1 change flows

### Rotate passphrase (user remembers old)

```ts
await db.rotatePassphrase({
  oldPassphrase: 'correct horse battery staple printer toaster',
  newPassphrase: 'glasses cabinet bicycle umbrella thunder velvet',
  factorProofs: [{ kind: 'totp', code: '123456' }],
})
```

The hub:

1. Validates `newPassphrase` against `policy.passphrase`.
2. Re-derives the old KEK from `oldPassphrase` + the keyring salt.
3. Verifies `factorProofs` against `policy.gates['rotate-passphrase'].factors`.
4. Generates a fresh salt + KEK from `newPassphrase`.
5. Rewraps every DEK under the new KEK and persists.
6. **Does not invalidate other slots** — tier-2 authenticators continue to wrap the same KEK reference and remain valid.

Workaround for weaker policies (dev / test / single-user CLI):

```ts
const policy = {
  ...PERSONAL_POLICY,
  gates: {
    ...PERSONAL_POLICY.gates,
    'rotate-passphrase': {
      minTier: 1,
      factors: [],
      warn: { weakAuthenticator: 'warn' },
    },
  },
}
```

### Recover forgotten passphrase

The user does not know the old passphrase. The vault must have at least one **recovery profile** enrolled at vault creation; otherwise `recover-passphrase` is `enabled: false` and recovery is impossible.

#### Recovery profiles

| Profile | Mechanism | Pros | Cons | When to enable |
|---|---|---|---|---|
| **A. Paper** | `on-recovery` codes — single-use, PBKDF2-derived wrapping key. User types one code → reset passphrase. | Simplest. No external dependencies. Works offline. | Paper compromise = vault compromise. Easy to lose. Single point of failure. | Personal vaults, SMB. Default for `PERSONAL_POLICY`. |
| **B. Threshold** | `on-shamir` K-of-N shares held by trustees. K humans cooperate → reconstruct KEK → reset. | Survives loss of N-K shares. No single party can recover alone. | Requires K humans available (death/illness/unreachable). High setup friction. | Executive vaults, multi-party custody. |
| **C. Multi-channel 2-of-3** | At enrollment: email-OTP wrapping-key + device-PIN wrapping-key + paper recovery code. Recovery requires **any 2 of 3**. | Resilient to losing any one channel. Familiar UX. | Three enrollments at signup. Email channel is the soft underbelly. | Default for `STRICT_POLICY`. |
| **D. Admin-mediated** | Vault admin issues a magic-link via `team/magic-link-grant`; user clicks + supplies one factor (e.g. TOTP) → reset. | Centralized control. Good for multi-tenant SaaS. Preserves zero-knowledge (admin authorizes a *reset*, never sees the data key). | Admin dependency. Requires careful audit-logging of admin recovery actions. | SaaS deployments, client portals. |

#### API

```ts
await db.recoverPassphrase({
  newPassphrase: 'glasses cabinet bicycle umbrella thunder velvet',
  recoveryProof: {
    profile: 'paper',                          // | 'shamir' | 'multi-channel' | 'admin-mediated'
    payload: { code: 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ12' },
  },
})
```

The hub dispatches to the corresponding `on-*` package, reconstructs the KEK from the recovery payload, generates a fresh salt + new KEK from `newPassphrase`, rewraps every DEK, and persists. **All recovery codes / shares used during the operation are burned**; the user is encouraged to re-enroll a fresh recovery profile in the same session.

#### Mandatory enrollment

The hub enforces at vault creation:

```ts
await createNoydb({
  store,
  // ... other options
  recovery: [
    { profile: 'paper', codes: 10 },           // generate 10 recovery codes
    // optionally:
    // { profile: 'shamir', k: 2, n: 3, trustees: [...] },
  ],
})
```

If `recovery` is omitted and `policy.gates['recover-passphrase'].enabled` is not explicitly `false`, the hub throws `RecoveryNotEnrolledError` with guidance.

## Managed-passphrase mode (rubber-hose-resistant)

Selected at vault creation:

```ts
await createNoydb({
  store,
  passphraseMode: 'managed',
  sealingKey: macOSKeychainProvider({ service: 'com.example.app', account: userId }),
  recovery: [
    { profile: 'multi-channel', email: 'user@example.com', pin: true, paperCodes: 10 },
  ],
})
```

### Mechanics

- Hub generates a 256-bit random passphrase via `crypto.getRandomValues` at enrollment.
- The passphrase is encrypted under the developer-provided **`SealingKeyProvider`** and stored at `_meta/sealed-passphrase`.
- The user **never sees**, **never types** the passphrase. The string never enters any UI surface.
- `policy.gates['rotate-passphrase'].enabled = false` is enforced — managed-mode vaults cannot rotate the passphrase. Recovery generates a fresh passphrase under a fresh sealing key.
- **Recovery is mandatory.** Vault creation rejects managed mode without at least one strong recovery profile (B or C).

### `SealingKeyProvider` interface

```ts
interface SealingKeyProvider {
  /** Returns a key handle the hub uses to seal/unseal the passphrase. */
  readonly id: string

  /** Wrap the random passphrase under the sealing key. Called once at enrollment. */
  seal(passphrase: Uint8Array): Promise<Uint8Array>

  /** Unwrap the sealed passphrase. Called on every unlock. */
  unseal(sealed: Uint8Array): Promise<Uint8Array>
}
```

Concrete providers live outside the hub:
- macOS Keychain via `Security.framework`
- Windows Credential Manager via `wincred`
- Linux libsecret via `secret-service`
- Browser-extension auto-fill (developer-implemented)
- AWS KMS / Cloud HSM for server-side managed-mode SaaS

### Threat model

The rubber-hose attack — coercing a user to reveal what they know — collapses, because the user has no secret to give up. The attack surface moves to:

1. Compromising the sealing-key store (technical attack on the OS keyring or KMS).
2. Compromising enough recovery factors to reach the recovery threshold (technical attack on email + device, or on K-of-N trustees).

Neither is coercive. The trade-off is a hard dependency on the sealing-key store; if it is wiped, recovery is the only path back in.

## Threat model summary

| Attack | Default user-mode mitigation | Managed-mode mitigation |
|---|---|---|
| Brute-force passphrase | PBKDF2 600k iterations + phrase format (≥77 bits) | Random 256 bits — infeasible |
| Stolen device with platform passkey (tier 2) | Tier-1 changes require off-device 2FA factor | Same; passphrase rotation disabled entirely |
| Stolen device with cached tier-3 PIN | Idle timeout wipes cache | Same |
| Coerced user (rubber-hose) | Duress-passphrase wipe via `on-threat` (preserves plausible deniability) | User has no secret to reveal — attack surface moves to technical channels |
| Lost passkey only | Unlock via another tier-2 slot, or recovery profile | Same |
| Forgotten passphrase | Recovery profile (A / B / C / D) | Same — but recovery is mandatory in managed mode |
| Compromised admin | Cannot read user data (zero-knowledge); cannot rotate user passphrase; can issue magic-link recovery (admin-mediated profile only) | Same |
| Provider compromise (`on-oidc`) | Server holds only one half of the split-key | Same |
| Email account compromise | Email-OTP factor compromised; multi-channel 2-of-3 still survives | Same |
| Forged keyring file (tampered ciphertext) | Authenticated AES-GCM rejects modified envelopes | Same |

## Implementation status

| Capability | Status |
|---|---|
| Tier-1 passphrase + KEK derivation | ✅ in `@noy-db/hub/src/crypto.ts` |
| `team/magic-link-grant.ts` (passphrase-less first-contact + recovery profile D) | ✅ shipped in `0.1.0-pre.4` |
| Tier-2 single-slot via `getKeyring` callback (issue #5) | ✅ shipped in `0.1.0-pre.4` |
| Multi-slot `authenticators[]` keyring extension | ❌ design only |
| `packages/hub/src/policy/` module + gate engine + `checkGate()` | ❌ design only |
| `rotatePassphrase` / `recoverPassphrase` APIs | ❌ design only |
| `enrollAuthenticator` / `removeAuthenticator` / `enrollUnlock` APIs | ❌ design only |
| Phrase strength validator (default-on with override) | 🟡 [issue #7](https://github.com/vLannaAi/noy-db/issues/7) |
| Managed-passphrase mode + `SealingKeyProvider` | ❌ design only — post-1.0 candidate |
| `@noy-db/on-password` package (tier-2 daily password) | ❌ design only |
| Per-keyring policy override merge engine (Option C) | ❌ deferred — on-disk format ready, runtime not |

## Forward compatibility

- **On-disk format already supports Option C.** Adding the merge engine later does not require a vault-format migration.
- **Authenticator slots are append-only across hub versions.** A future `method` value (e.g. `'biometric-secure-element'`) does not break older clients — they will skip slots whose method they cannot handle.
- **Policy gates are forward-compatible by name.** Older clients ignore unknown gate names; newer clients enforce them. Custom `app:*` gates are namespaced to avoid future built-in collisions.
- **Recovery profiles are pluggable.** Adding profile E (e.g. hardware-token recovery) does not break A–D enrollments.

## References

- [`docs/packages/on-auth.md`](../packages/on-auth.md) — auth catalog (factor table, package summaries)
- [`CLAUDE.md`](../../CLAUDE.md) → "Authentication / Session Tiers" — repository-level reference
- [`SPEC.md`](../../SPEC.md) — primary spec (key hierarchy, encryption invariants)
- [issue #7](https://github.com/vLannaAi/noy-db/issues/7) — phrase strength validator
- Per-package READMEs: [`on-webauthn`](../../packages/on-webauthn), [`on-oidc`](../../packages/on-oidc), [`on-pin`](../../packages/on-pin), [`on-totp`](../../packages/on-totp), [`on-email-otp`](../../packages/on-email-otp), [`on-recovery`](../../packages/on-recovery), [`on-shamir`](../../packages/on-shamir), [`on-magic-link`](../../packages/on-magic-link), [`on-threat`](../../packages/on-threat)
