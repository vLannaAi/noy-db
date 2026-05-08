# auth-landscape

> **Reference map of authentication, unlock, and sealing-key primitives.**
>
> **Status:** reference (no implementation surface). Updated alongside the `on-*` and future `seal-*` families.
> **Cluster:** collaboration-and-auth
> **Cross-cuts:** every `@noy-db/on-*` package, the planned `seal-*` family, `@noy-db/hub` core (KEK derivation, keyring layout, policy gates).
> **Companion:** [`session-tiers.md`](./session-tiers.md) — how the primitives below compose into a session lifecycle.

## What this doc is

A landscape map of every authentication, unlock, and sealing-key primitive commonly adopted in 2026, scored on the dimensions that matter for a zero-knowledge offline-first vault, and cross-referenced with current `on-*` coverage and planned `seal-*` work.

It exists so that the next time someone asks *"can we do login with Cognito / Active Directory / Windows / Touch ID / BankID?"* the answer is one table lookup, not a re-derivation.

## Three distinct functions get conflated as "auth"

| Function | What it does | noy-db family |
|---|---|---|
| **Authenticator** | Proves the user knows / has / is something. Produces a cryptographic proof or releases a wrap key. | `on-*` (this doc, sections 1–5) |
| **Identity provider (IdP)** | Federates identity. Issues tokens. Does not by itself produce wrap-key material. | `on-oidc` bridges (section 6) |
| **Sealing-key store** | Protects the wrap key under OS-account or KMS guarantees. Does not authenticate the user. | `seal-*` (planned, sections 8–9) |

Conflating these is the single most common source of misdesign in this space. A `seal-windows-dpapi` is **not** an authenticator. `on-google` would **not** be different from `on-oidc`.

## Dimensions

| Dimension | What it tests |
|---|---|
| **Online?** | Network required *at unlock time*. TOTP needs network only at enrollment, so it scores ❌ here. |
| **Personal device** | Suits a phone/laptop bound to one user. |
| **Shared device** | Suits a kiosk / clinic terminal / shared family iPad. Implicitly tests *credential portability* — methods that work well on shared hardware are ones where the credential travels with the user. |
| **Factor** | **K** = knowledge · **D** = possession/device · **B** = biometric/inherence. Multi-factor methods list all that apply. |
| **noy-db match** | Existing `on-*` package, planned `seal-*`, deliberately omitted (with reason), or genuine gap. |

**Legend:** ✅ good fit · ⚠️ works with caveats · ❌ poor fit / breaks model

---

## 1. Knowledge factors

| Method | Online? | Personal | Shared | Factor | noy-db match |
|---|:--:|:--:|:--:|:--:|---|
| Master passphrase (Diceware) | ❌ | ✅ | ⚠️ shoulder-surf | K | **tier-1, internal to hub** (no `on-*`) |
| Daily password | ❌ | ✅ | ⚠️ | K | `on-password` |
| Numeric PIN (4–6 digits) | ❌ | ✅ | ❌ low entropy | K | `on-pin` (**tier 3 only**) |
| Pattern lock (Android-style) | ❌ | ⚠️ | ❌ | K weak | ❌ deliberately omitted |
| Security questions | varies | ⚠️ | ❌ | K weak | ❌ deliberately omitted (social-engineerable, low entropy) |

## 2. Possession — software OTP / link

| Method | Online? | Personal | Shared | Factor | noy-db match |
|---|:--:|:--:|:--:|:--:|---|
| TOTP (Google Auth, Authy, 1Password) | ❌ post-enrol | ✅ | ✅ phone-borne | D | `on-totp` |
| HOTP (RFC 4226) | ❌ | ✅ | ✅ | D | ❌ (TOTP supersedes) |
| Email OTP | ✅ | ✅ | ✅ | D (mailbox) | `on-email-otp` |
| SMS OTP | ✅ | ✅ | ⚠️ SIM-swap | D weakened | ❌ deliberately omitted (NIST SP 800-63B deprecates) |
| Magic link | ✅ | ✅ | ⚠️ | D (mailbox) | `on-magic-link` |
| Push notification (Duo, Okta Verify, MS Authenticator number-match) | ✅ | ✅ | ✅ goes to personal phone | D | ❌ (vendor; reachable via `on-oidc`) |
| WhatsApp / Telegram / Signal OTP | ✅ | ✅ | ⚠️ | D | ❌ |

## 3. Possession — hardware

| Method | Online? | Personal | Shared | Factor | noy-db match |
|---|:--:|:--:|:--:|:--:|---|
| FIDO2 / WebAuthn — **roaming** (YubiKey, SoloKeys, Titan) | ❌ | ✅ | ✅ bring the key | D (+ B if biometric key) | `on-webauthn` |
| FIDO2 / WebAuthn — **platform** (Hello, Touch/Face ID, Android) | ❌ | ✅ | ❌ device-bound | D + B | `on-webauthn` |
| Passkey — synced (iCloud Keychain, Google Password Manager, 1Password) | ✅ at sync | ✅ | ⚠️ via QR cross-device | D (synced) | `on-webauthn` (hybrid transport) |
| Smart cards — PIV / CAC / e-Residency | ❌ | ✅ | ✅ bring the card | D + K (card PIN) | ❌ (potential `on-piv`) |
| Hardware OTP tokens (RSA SecurID, classic Yubikey OTP) | ❌ | ✅ | ✅ | D | ❌ (legacy; FIDO2 covers) |
| Bluetooth proximity (Apple Watch unlock, Pixel Smart Lock) | ❌ | ✅ | ❌ wearable-bound | D | ❌ |
| Recovery codes (printable) | ❌ | ✅ paper safe | ⚠️ emergency only | D | `on-recovery` |
| NFC / contactless ID cards (eID, MyKad, Aadhaar w/ NFC) | ❌ | ✅ | ✅ | D + K (PIN) | ❌ |

## 4. Inherence — biometrics

Biometrics never *are* the secret — they gate access to a local credential. So the noy-db match is always indirect.

| Method | Online? | Personal | Shared | Factor | noy-db match |
|---|:--:|:--:|:--:|:--:|---|
| Touch ID / Face ID (Apple) | ❌ | ✅ | ❌ | B (gates passkey/keychain) | `on-webauthn` (platform); planned `seal-macos-keychain` |
| Windows Hello (PIN/fingerprint/face/iris) | ❌ | ✅ | ❌ | B + K | `on-webauthn` (platform); planned `seal-windows-dpapi` |
| Android Biometric (BiometricPrompt) | ❌ | ✅ | ❌ | B | `on-webauthn` (platform); planned `seal-android-keystore` |
| Voice biometrics (banking IVR) | ✅ | ✅ | ⚠️ replay-attackable | B weak | ❌ |
| Iris / vein / palm (industrial / clinical) | ❌ | ✅ | ✅ if scanner shared | B | ❌ |

## 5. Threshold / split secrets

| Method | Online? | Personal | Shared | Factor | noy-db match |
|---|:--:|:--:|:--:|:--:|---|
| Shamir Secret Sharing (K-of-N) | ❌ | ⚠️ coordination | ⚠️ | D × N | `on-shamir` |
| Multi-channel 2-of-3 (recovery profile C) | partial | ✅ | ⚠️ | K + D mix | composed: `on-recovery` + `on-email-otp` + `on-pin` |
| Admin-mediated magic-link grant (recovery profile D) | ✅ | ✅ | ✅ | D + admin | `team/magic-link-grant` |
| MPC / threshold signing (Fireblocks, Web3Auth tssLib) | ✅ | ⚠️ | ⚠️ | D × parties | ❌ |

## 6. OIDC / federated identity providers

All require **online at auth time**. All map to `on-oidc` with different issuer URLs. Differences are ecosystem fit and built-in 2FA strength, not protocol.

| Provider | Personal | Shared | Default factors | Notes / caveat | noy-db match |
|---|:--:|:--:|---|---|---|
| Google Sign-In | ✅ | ⚠️ leaves session | K + optional D (Google Prompt / TOTP / key) | Consumer + Workspace | `on-oidc` |
| Apple Sign-In | ✅ | ❌ Apple-bound | K + B (device) + D | Anonymizes email | `on-oidc` |
| Microsoft / Entra ID | ✅ | ✅ enterprise | K + D (Authenticator) | Conditional Access | `on-oidc` |
| AD FS (modern) | ✅ | ✅ | K + D | OIDC since Server 2016 | `on-oidc` |
| GitHub | ✅ | ⚠️ | K + D (TOTP/passkey) | Dev-tooling auth | `on-oidc` |
| GitLab | ✅ | ⚠️ | K + D | | `on-oidc` |
| Okta | ✅ | ✅ enterprise | K + D (Okta Verify push) | Workforce IdP | `on-oidc` |
| Auth0 | ✅ | ✅ | tenant-configurable | B2C / B2B SaaS IdP | `on-oidc` |
| AWS Cognito | ✅ | ⚠️ | K + optional TOTP/SMS | State-machine wrapper is real value but the wrap key still needs split-key shape | `on-oidc` |
| Firebase Auth | ✅ | ⚠️ | K + D | Mobile-first | `on-oidc` |
| Keycloak (self-host) | ✅ | ✅ | configurable | On-prem IdP | `on-oidc` |
| ForgeRock / PingOne | ✅ | ✅ enterprise | configurable | Legacy enterprise IAM | `on-oidc` |
| Facebook / Meta | ✅ | ❌ | K + optional D | Consumer; not for vault | `on-oidc` (not recommended) |
| LinkedIn / X / Discord / Slack / Notion / Atlassian | ✅ | ⚠️ | K + D | Work-app + consumer | `on-oidc` |
| LINE / Kakao / WeChat / Naver | ✅ | ⚠️ | K + D (varies) | Asia-regional | `on-oidc` |
| Authentik / Zitadel / Logto | ✅ | ✅ | configurable | Open-source Auth0/Okta | `on-oidc` |
| Clerk / Stytch / WorkOS / Frontegg | ✅ | ✅ | varies | DevX-IdP-as-SDK | `on-oidc` |
| ID.me / Login.gov / GOV.UK Verify | ✅ | ✅ | K + D + identity proofing | Government IdP | `on-oidc` |

## 7. Enterprise / directory protocols

| Method | Online? | Personal | Shared | Factor | noy-db match |
|---|:--:|:--:|:--:|:--:|---|
| LDAP simple/SASL bind (incl AD) | ✅ to DC | ⚠️ | ✅ on-prem | K | ❌ → potential `on-ldap` (split-key shape) |
| Kerberos / IWA / SPNEGO | ✅ KDC then cached | ⚠️ | ✅ | K → D (TGT) | ❌ |
| SAML 2.0 | ✅ | ✅ | ✅ | varies by IdP | ❌ → bridge to `on-oidc` typical |
| RADIUS | ✅ | ⚠️ | ✅ | K | ❌ |
| SSH cert auth (CA-signed) | ❌ | ✅ | ✅ bring key | D | ❌ |
| mTLS client certs | ❌ | ✅ | ⚠️ cert provisioning | D | ❌ |

## 8. OS keychain / device-local sealing — NOT authenticators

These don't authenticate the *user* — they protect the *wrap key* under OS-account guarantees. They map to the planned `seal-*` family for managed-passphrase mode (issue [#14](https://github.com/vLannaAi/noy-db/issues/14)), not to `on-*`.

| Store | Online? | Personal | Shared | Factor | noy-db match |
|---|:--:|:--:|:--:|:--:|---|
| Windows DPAPI / Credential Manager | ❌ | ✅ | ❌ user-bound | D (OS account) | ❌ → planned `seal-windows-dpapi` |
| macOS Keychain Services | ❌ | ✅ | ❌ | D | ❌ → planned `seal-macos-keychain` |
| iOS Keychain (Secure Enclave) | ❌ | ✅ | ❌ | D + B | ❌ → planned `seal-ios-keychain` |
| Android Keystore / StrongBox / TEE | ❌ | ✅ | ❌ | D + B | ❌ → planned `seal-android-keystore` |
| Linux Secret Service (libsecret, gnome-keyring, KWallet) | ❌ | ✅ | ❌ | D | ❌ → planned `seal-linux-secret-service` |
| TPM 2.0 (sealed-to-PCR / no-export) | ❌ | ✅ | ✅ server | D | ❌ (potential `seal-tpm`) |
| Apple Secure Enclave | ❌ | ✅ | ❌ | D + B | indirectly via WebAuthn / Keychain |
| Browser CredentialStore / `navigator.credentials` | ❌ | ✅ | ❌ | D | indirectly via WebAuthn |

## 9. Cloud / centralized KMS & HSM — server-context sealing

Same family as section 8 (sealing, not auth) but server-side. Fit `SealingKeyProvider` for managed mode in server contexts.

| Service | Online? | Personal | Shared | Factor | noy-db match |
|---|:--:|:--:|:--:|:--:|---|
| AWS KMS (incl. Nitro Enclaves attestation) | ✅ | ⚠️ | ✅ server | D (IAM) | ❌ → planned `seal-aws-kms` |
| GCP Cloud KMS / Cloud HSM | ✅ | ⚠️ | ✅ | D | ❌ → planned `seal-gcp-kms` |
| Azure Key Vault / Managed HSM | ✅ | ⚠️ | ✅ | D | ❌ → planned `seal-azure-key-vault` |
| HashiCorp Vault Transit | ✅ | ⚠️ | ✅ | D (token) | ❌ → planned `seal-hashicorp-vault` |
| Cloudflare Keyless SSL / Turnstile | ✅ | ⚠️ | ✅ | D | ❌ |
| PKCS#11 HSM (Thales, YubiHSM, SoftHSMv2) | ❌ | ⚠️ | ✅ | D | ❌ → potential `seal-pkcs11` |
| AWS Nitro Enclaves / GCP Confidential Space / Azure Confidential | ✅ | ⚠️ | ✅ | D + attestation | ❌ |

## 10. Password managers / personal vaults

Out of scope for `on-*` — users compose them upstream by *storing their passphrase there*. Listed for completeness; not a wrap-key target.

| Tool | Online? | Personal | Shared | Factor | noy-db match |
|---|:--:|:--:|:--:|:--:|---|
| 1Password | ⚠️ sync | ✅ | ❌ | K + D + B | ❌ |
| Bitwarden / Vaultwarden | ⚠️ sync | ✅ | ⚠️ self-host kiosk | K + D + B | ❌ |
| Dashlane / LastPass / NordPass / Proton Pass | ⚠️ sync | ✅ | ❌ | K + D + B | ❌ |
| Apple Passwords / Google Password Manager | ⚠️ sync | ✅ | ❌ | K/B (device) | indirectly via Keychain |
| KeePass / KeePassXC (offline) | ❌ | ✅ | ⚠️ portable | K + D (key file) | ❌ |

## 11. Threat / context layers (modify, don't replace, the above)

| Mechanism | noy-db match |
|---|---|
| Lockout / duress code / honeypot vault | `on-threat` |
| Risk-based / adaptive auth (Okta Risk, Auth0 Anomaly, Cloudflare Turnstile) | ❌ (provider-side; layer above `on-oidc`) |
| Device attestation (Play Integrity, App Attest, ASWebAuthSession) | ❌ |
| Behavioral biometrics (typing cadence, mouse) | ❌ |
| Geofencing / IP allowlists | ❌ (policy-layer, not auth-layer) |

## 12. Emerging / specialized

| Method | Online? | Personal | Shared | Factor | noy-db match |
|---|:--:|:--:|:--:|:--:|---|
| Passkeys cross-device (BLE hybrid transport, FIDO CTAP 2.2) | partial | ✅ | ✅ via QR + phone | D + B | `on-webauthn` |
| Decentralized Identifiers — DID/VC (W3C), `did:key`, `did:web`, `did:ion` | varies | ✅ | ✅ | D | ❌ |
| mDL (ISO/IEC 18013-5 mobile driver license) | ❌ BLE | ✅ | ✅ | D + B | ❌ |
| EUDI Wallet (EU Digital Identity, eIDAS 2) | varies | ✅ | ✅ | D + B + K | ❌ |
| BankID (SE/NO/DK/FI) / ItsMe (BE) | ✅ | ✅ | ✅ phone-borne | D + K + B | ❌ (regional `on-bankid` candidate) |
| Web3 wallet (SIWE — Sign-In with Ethereum / Solana) | ✅ | ✅ | ⚠️ | D (priv key) + K (wallet PIN) | ❌ |
| WebOTP API (browser-mediated SMS auto-fill) | ✅ | ✅ | ⚠️ | D | ❌ |

---

## What this map says about `on-*` coverage

- **Coverage is strong on offline-first primitives** (TOTP, WebAuthn, recovery codes, Shamir, PIN, password) — the parts where zero-knowledge actually buys you something. That's deliberate.
- **Coverage is uniform on OIDC.** One `on-oidc` package handles ~20 named providers because the protocol is the unit of abstraction, not the brand. Resist the urge to ship `on-cognito`, `on-okta`, `on-google`.
- **Two real gaps exist** — the `seal-*` family for OS keychain / cloud KMS (the managed-passphrase #14 work), and on-prem directory bind (`on-ldap` / `on-kerberos`) for air-gapped enterprise. Everything else is either covered, deliberately omitted (SMS, security questions, pattern lock), or upstream of noy-db (password managers).
- **`on-threat` is structurally unique.** It's the only `on-*` that doesn't authenticate; it modifies how others authenticate. That factoring is correct — don't try to make it parallel.

## Concrete gaps worth tracking

| Gap | Severity | Notes |
|---|---|---|
| `seal-*` family (DPAPI, macOS/iOS Keychain, Android Keystore, Linux Secret Service) | **high** post-1.0 | Required for managed-passphrase mode (#14). Without these, "Windows login to unlock" remains impossible. |
| `seal-*` cloud (AWS KMS / GCP / Azure / Vault) | **medium** post-1.0 | Same family, server contexts. |
| `on-ldap` (with split-key, AD-compatible) | **medium**, demand-driven | Only build if a regulated on-prem consumer asks. Same wrap-key problem as `on-oidc` — solve once, generically. |
| `on-piv` / smart cards | **low** | WebAuthn roaming covers most use cases. |
| Push-notification factor (Duo / Okta Verify / MS Authenticator number-match) | **low** | Reachable via `on-oidc`; standalone package only if a consumer needs out-of-IdP push. |
| `on-bankid` / regional ID wallets (BankID, ItsMe, EUDI) | **low** | Niche; spin up if a Nordic/EU consumer materializes. |

## Decision rules — when to ship a new `on-*` package

When evaluating a new authenticator request, walk this checklist before reaching for `pnpm create`:

1. **Is it an authenticator, an IdP, or a sealing-key store?** Mis-classification → wrong package family → wrong threat model. See "Three distinct functions" above.
2. **Does the protocol already have a generic package?** Vendor-flavored OIDC → `on-oidc` config, not a new package. Vendor-flavored OS keychain → `seal-*`, not `on-*`.
3. **Can it carry wrap-key material on its own?** If no (LDAP bind, Kerberos, Cognito tokens), the only honest shape is **split-key** — same pattern as `on-oidc` — or **gate-only composition** with a real authenticator.
4. **Does it work on shared devices?** If only on personal devices, document the constraint loudly. Tier 3 (`on-pin`) is *never* safe on shared workstations regardless.
5. **Is there a consumer asking for it?** Most regional / vendor-specific providers should stay theoretical until demand materializes. A landscape-map row is cheaper than a published package with no users.

## Common questions this map answers

| Question | Where to look | One-line answer |
|---|---|---|
| "Login with Google?" | §6 | `on-oidc` with Google issuer. |
| "Login with Apple?" | §6 | `on-oidc` with Apple issuer. Apple-ecosystem only on personal device. |
| "Login with Microsoft / work account?" | §6 | `on-oidc` with Entra ID issuer. |
| "Login with AWS Cognito?" | §6 | `on-oidc` with the Cognito hosted-UI issuer; state-machine sugar can live as a small helper inside the consumer app. |
| "Login with Active Directory?" | §6, §7 | Modern AD FS or Entra → `on-oidc`. Raw on-prem AD (LDAP/Kerberos) → not yet covered; would need `on-ldap` with split-key. |
| "Login with Windows / Windows Hello?" | §3, §4, §8 | Windows Hello *is* WebAuthn → `on-webauthn`. "Use my Windows account to unlock" → planned `seal-windows-dpapi`. |
| "Login with Touch ID / Face ID?" | §4 | Platform passkey via `on-webauthn`. |
| "Login with my YubiKey?" | §3 | Roaming WebAuthn via `on-webauthn`. |
| "SMS as a 2FA factor?" | §2 | Deliberately omitted. SIM-swap and SS7 attacks make it unfit for vault auth. Use `on-totp` or `on-email-otp`. |
| "BankID / EUDI Wallet?" | §12 | Not yet covered. Regional candidate, demand-driven. |
| "Decentralized identity (DID/VC, SIWE)?" | §12 | Not yet covered. No active consumer ask. |

## See also

- [`docs/subsystems/session-tiers.md`](./session-tiers.md) — how the primitives compose into the three-tier session lifecycle and policy gates.
- [`CLAUDE.md`](../../CLAUDE.md) → "Authentication / Session Tiers" — repository-level reference.
- [`SPEC.md`](../../SPEC.md) — primary spec (key hierarchy, encryption invariants).
- Per-package READMEs: [`on-webauthn`](../../packages/on-webauthn), [`on-oidc`](../../packages/on-oidc), [`on-pin`](../../packages/on-pin), [`on-totp`](../../packages/on-totp), [`on-email-otp`](../../packages/on-email-otp), [`on-recovery`](../../packages/on-recovery), [`on-shamir`](../../packages/on-shamir), [`on-magic-link`](../../packages/on-magic-link), [`on-password`](../../packages/on-password), [`on-threat`](../../packages/on-threat).
- Issue [#14](https://github.com/vLannaAi/noy-db/issues/14) — managed-passphrase mode + `SealingKeyProvider` (drives the `seal-*` family).
