# Issue #111 — feat(auth-webauthn): @noy-db/auth-webauthn — hardware-key keyring (WebAuthn + PRF + BE-flag guards)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-09
- **Milestone:** v0.7.0
- **Labels:** type: feature, type: security, area: core, epic

---

## Summary

New package: **`@noy-db/auth-webauthn`**. Single WebAuthn-based hardware-key keyring covering every form factor we care about — Touch ID, Face ID, Windows Hello, Android biometric, YubiKey, SoloKey, Titan, any FIDO2 device, any passkey-capable platform authenticator — all through one API, zero device-specific code, zero vendor SDKs.

**We are betting entirely on WebAuthn+PRF as the single hardware-credential abstraction.** No PKCS#11 adapter, no direct libfido2 binding, no smartcard middleware, no per-vendor packages. WebAuthn is the W3C union type over every hardware credential; shipping parallel code paths for each vendor would be duplicated work with no zero-knowledge benefit.

Starting point: `packages/core/src/biometric.ts` (~182 lines) — enrollment + unlock scaffolding already exists. This issue extracts it into a dedicated package, adds the two guards that make it cryptographically sound (PRF + BE-flag check), and wires it into the session primitive.

## Why WebAuthn-only

| Form factor | Interface | Notes |
|---|---|---|
| Touch ID / Face ID (macOS, iOS) | WebAuthn platform authenticator | Biometric-gated, device-bound |
| Windows Hello | WebAuthn platform authenticator | PIN/biometric-gated, device-bound |
| Android biometric | WebAuthn platform authenticator | Device-bound |
| YubiKey 5 / Bio, SoloKey, Feitian, Titan, Nitrokey | WebAuthn roaming authenticator (FIDO2/CTAP2) | PIN + touch, device-bound |
| iCloud / Google / 1Password passkeys | WebAuthn platform authenticator | **Synced** — see BE flag discussion below |

Every row goes through `navigator.credentials.create()` and `.get()`. The browser + OS handle vendor-specific protocols. We write zero device code.

**Explicitly not shipping:**

- PKCS#11 adapter (C library surface, no value over WebAuthn for consumer hardware, violates "zero crypto dependencies" invariant)
- Direct `libfido2` native binding (WebAuthn routes to the same CTAP2 protocol via the browser)
- OpenPGP card / PGP smartcard support (niche; consumers can bridge via their OS WebAuthn stack)
- Any per-vendor code path (`@noy-db/auth-yubikey`, etc.) — all are WebAuthn underneath

## The two guards that are non-negotiable

### Guard 1 — PRF extension is required

Plain WebAuthn assertion does not produce a deterministic secret. Every `navigator.credentials.get()` returns a fresh challenge and a fresh signature — you cannot derive the same wrapping key twice. Useful for authentication, useless for KEK wrapping.

The **PRF (Pseudo-Random Function) extension** fixes this. PRF lets the library pass a salt to the authenticator, and the authenticator returns `HMAC(credentialSecret, salt)` — a stable, credential-bound 32-byte secret that never leaves the device. Feed into HKDF, derive a wrapping key, wrap the KEK. This is the mechanism that makes hardware-key noy-db cryptographically work.

As of 2026, PRF support:

| Browser | Platform auth | Roaming auth |
|---|---|---|
| Chrome/Edge 132+ | ✅ | ✅ |
| Safari 18+ | ✅ | ✅ |
| Firefox 122+ | ✅ | ✅ |
| Older YubiKey (pre-5) | N/A | ❌ no hmac-secret |
| U2F-only keys (pre-FIDO2) | N/A | ❌ |

**Enrollment MUST request PRF and MUST reject credentials that don't return a PRF result.** A device that can't provide a deterministic secret is useless for KEK wrapping, no matter how strong its attestation is.

```ts
const credential = await navigator.credentials.create({
  publicKey: {
    // ... challenge, rp, user ...
    authenticatorSelection: {
      authenticatorAttachment: 'cross-platform',  // prefer roaming keys
      residentKey: 'required',
      userVerification: 'required',
    },
    extensions: {
      prf: { eval: { first: enrollmentSalt } },
      credProps: {},
    },
  },
})

const prfResult = credential.getClientExtensionResults().prf?.results?.first
if (!prfResult) {
  throw new PrfExtensionRequiredError(
    "This authenticator does not support the WebAuthn PRF extension. " +
    "Use a different authenticator or fall back to passphrase unlock."
  )
}
```

### Guard 2 — synced passkeys are rejected by default (BE flag check)

**This is the subtlety that makes the difference between "this works" and "this works AND preserves zero-knowledge."**

A passkey is just a WebAuthn credential whose private key is synced by the OS/password-manager backend — iCloud Keychain, Google Password Manager, 1Password, etc. From the user's perspective, passkeys are great: lose your phone, buy a new one, credential restored.

From noy-db's zero-knowledge perspective, this silently reintroduces a third party to the trust boundary:

> If the PRF secret can be recovered by restoring the passkey on a new device, then whoever controls that restore path (Apple, Google, the password manager vendor) can effectively recover the KEK wrap.

Apple can, with iCloud Keychain. Google can, with Google Password Manager. The user's trust boundary silently expanded from "my passphrase" to "my passphrase OR iCloud." That's not zero-knowledge anymore, and the API surface looks identical to a device-bound FIDO2 unlock.

The **BE (Backup Eligibility) flag** and **BS (Backup State) flag** in the authenticator data tell us whether a credential is backup-eligible at the protocol level. `BE=1` = "this credential can be synced" = passkey signature.

**Default enrollment policy: reject `BE=1` credentials.**

```ts
const authData = parseAuthenticatorData(credential.response.getAuthenticatorData())
const isBackupEligible = (authData.flags & 0b00001000) !== 0  // BE flag

if (isBackupEligible && !options.allowSynced) {
  throw new SyncedCredentialRejectedError(
    "This credential is backup-eligible (syncable). Using it would silently " +
    "place Apple/Google/your password manager inside the compartment's trust " +
    "boundary. Use a device-bound authenticator (YubiKey, SoloKey, or Touch ID " +
    "on a device with keychain sync disabled), or pass allowSynced: true to " +
    "opt in with reduced trust."
  )
}
```

An explicit `allowSynced: true` override is available, but:

- It is never the default.
- It marks the credential as `trustLevel: 'synced'` in the keyring record.
- The UI must surface the reduced trust level every time the credential is used.

The entire project exists because users did not want third parties in the trust boundary. Silently accepting synced passkeys would betray that premise.

## Package shape

```
packages/auth-webauthn/
├── src/
│   ├── index.ts          # public API: enroll, unlock, listCredentials, revoke
│   ├── enroll.ts         # create() + PRF + BE flag checks
│   ├── unlock.ts         # get() + PRF → HKDF → session wrap
│   ├── auth-data.ts      # parse authenticator flags (BE/BS/UP/UV)
│   └── errors.ts
├── package.json
└── README.md
```

No runtime dependencies beyond Web Crypto. Browser-only — hard-refuses to load in Node:

```ts
if (typeof window === 'undefined' || !window.PublicKeyCredential) {
  throw new Error(
    '@noy-db/auth-webauthn requires a browser environment. For Node/CLI ' +
    'hardware-key unlock, see @noy-db/auth-oskeychain (separate package).'
  )
}
```

## API

```ts
import { enrollWebAuthn, unlockWithWebAuthn } from '@noy-db/auth-webauthn'

// First-time enrollment — requires passphrase to unwrap the existing KEK,
// then re-wraps it with a WebAuthn-PRF-derived key.
await enrollWebAuthn(db, {
  compartment: 'acme',
  userId: 'vlanna',
  passphrase: 'correct horse battery staple',
  label: 'YubiKey 5C at desk',          // shown in UI later
  allowSynced: false,                    // default
})

// Subsequent sessions — no passphrase needed.
const session = await unlockWithWebAuthn(db, {
  compartment: 'acme',
  userId: 'vlanna',
  sessionPolicy: { idleTimeoutMs: 15 * 60 * 1000 },
})
```

Enrollment is additive: a user can have a passphrase AND one or more WebAuthn credentials. Losing a hardware key falls back to passphrase. Losing the passphrase falls back to... nothing — there is no recovery.

## Acceptance criteria

- [ ] **PRF requested on every enrollment.** Covered by test with a mock authenticator that doesn't return PRF → must throw `PrfExtensionRequiredError`.
- [ ] **BE flag rejected by default.** Test with a mock authData with BE=1 → must throw `SyncedCredentialRejectedError` unless `allowSynced: true`.
- [ ] **`allowSynced: true` marks the credential as `trustLevel: 'synced'`** in the keyring. Test verifies the persisted record.
- [ ] **Non-browser environment rejected at import time.** Test in Node → must throw with a pointer to `@noy-db/auth-oskeychain`.
- [ ] **`biometric.ts` in core is deprecated** and re-exported from the new package for one minor version, then removed. No breaking change for current consumers.
- [ ] **Session produced by `unlockWithWebAuthn` is indistinguishable** from a passphrase-unlocked session — same timeouts, same API, same destroy behavior. Verified by shared test suite.
- [ ] **Multiple credentials per user supported.** A user can enroll "YubiKey at desk" and "YubiKey in laptop bag" and unlock with either.
- [ ] **Revocation** removes the credential from the keyring; future `get()` calls against the revoked credential ID fail cleanly.

## Open questions

1. **Should enrollment default to `cross-platform` or `platform` attachment?** Cross-platform biases the picker toward roaming keys (YubiKey), which are always device-bound. Platform shows Touch ID / Face ID, which are device-bound on macOS today but may become syncable in future OS versions. Lean: `cross-platform` default, with a second path `enrollPlatform()` that users opt into.
2. **UV (User Verification) required vs preferred?** Required means the user must prove presence on every unlock (biometric/PIN). Preferred lets the authenticator skip if already verified recently. Lean: required, because sessions are meant to be bounded.
3. **Conditional UI / autofill** — WebAuthn's conditional mediation shows the credential picker inline with a text field. Great UX for login, awkward for compartment unlock. Probably skip in v1.
4. **Attestation** — should we verify attestation statements against a list of trusted authenticator AAGUIDs? Overkill for v1 — consumers who want this can opt in later.

## Non-goals for v1

- Node/CLI hardware-key unlock. Tracked as a separate issue under `@noy-db/auth-oskeychain` (OS keychain, not WebAuthn).
- Direct YubiKey support from headless contexts. If a real consumer asks, add a thin `libfido2` binding then — not speculatively.
- Enterprise attestation / managed device policies.
- Multi-device credential roaming via hybrid transport (caBLE). The user picker handles this already; we don't need to do anything special.
