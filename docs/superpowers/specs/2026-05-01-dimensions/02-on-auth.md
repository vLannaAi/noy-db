# Dimension 02 — Authentication paths (`on-*`)

## Purpose

Cover the entire spectrum of unlock methods so apps can choose the auth method that matches their threat model and friction budget — from highest-security passkeys for regulated data down to low-friction password unlock for personal notebooks. Make each tier honest about what it protects against.

## Current state

9 packages: `on-webauthn` (passkeys + PRF), `on-oidc` (OAuth split-key), `on-magic-link` (one-shot viewer session), `on-recovery` (printable codes), `on-shamir` (k-of-n secret share), `on-totp`, `on-email-otp`, `on-pin` (session resume), `on-threat` (lockout / duress / honeypot triad). Plus the always-available passphrase unlock built into core.

## Target state

A complete tradeoff curve: every reasonable point between "highest security, highest friction" (Shamir + WebAuthn-PRF + OIDC split) and "lowest security, lowest friction" (password). Apps pick by *audited tier*, not by guesswork. Each `on-*` package declares its security tier in capability metadata so the keyring layer can refuse to combine incompatible unlock paths (e.g., reject pairing high-security data with `on-password`).

## Concrete additions

**Filling out the curve:**
- `on-password` — deliberate low-security baseline. Single passphrase, no PBKDF2 hardening above default, explicit warning UX. For personal notebooks where convenience outweighs threat.
- `on-sms-otp` — SMS one-time codes. Lower security than email-OTP (SIM swap), but ubiquitous in markets without smartphone adoption. Cross-border friendly.
- `on-mtls` — mutual TLS client cert unlock. For B2B / EDI scenarios.
- `on-jwt-broker` — accept a JWT from an external IdP, derive split-key from claims. Generalises `on-oidc`.
- `on-saml` — enterprise IdP federation (low priority for the SME mission, but blocks zero adoption stories).
- `on-ldap` — corporate directory unlock, often the only option in regulated SMEs.

**New paradigms:**
- `on-token` — proof-of-token-ownership unlock (any chain, ERC-20/721/1155). Reframed from "to-blockchain" — the chain is the auth oracle, not the storage backend.
- `on-biometric` — Touch ID / Face ID / Android keystore via Capacitor / Tauri / Electron native bridges. Distinct from WebAuthn (works without browser).
- `on-qr-handoff` — visual handoff between two devices for first-time pairing.
- `on-paired-device` — pairing-based unlock where one already-authenticated device approves another via a side channel (`by-peer`).

**Threat-model and ergonomics:**
- `on-duress-distinct` — extension of `on-threat` where a duress passphrase unlocks a *different vault* (decoy mode), not just throws.
- `on-rate-limited` — composable wrapper that adds exponential-backoff to any `on-*`.

## Non-goals & tradeoffs

- **Master keys, recovery backdoors, vendor key escrow.** No. Every recovery path must be user-controlled (Shamir, recovery codes, paired devices).
- **"Remember me forever" without explicit opt-in.** Session resume is `on-pin` and is opt-in.
- **Hardcoded role bypass.** No dev-mode, no superuser, no break-glass admin. Owner is the only privileged role and the keyring proves it.
- **Hidden auth strength.** Every `on-*` package self-declares its security tier; the keyring layer publishes the *minimum* tier across enabled paths.

## Dependencies / sequencing

- Capability metadata for security tier (`tier: 'low' | 'medium' | 'high' | 'paranoid'`) must precede most additions.
- `on-token` depends on Dimension 01's `to-anchor-eth` infrastructure (chain RPC abstraction).
- `on-biometric` depends on a host-native bridge convention (also relevant to `in-*` extensions in Dimension 04).

## Cross-references

- `features.yaml` → `auths`
- Related: Dimension 08 (tamper-evidence integrates with the threat triad)
- Spec anchor: `SUBSYSTEMS.md#auth-and-keyrings`

## Open questions

- **Where does `on-password` land on the warning UX?** Loud (ASCII banner in dev console)? Quiet capability flag only?
- **Tier classification.** Who decides? Consensus heuristic, third-party audit, or self-declared with audit annotation?
- **Combinations.** Should the keyring expose "current security tier = min(enabled paths)", or refuse combinations that mix tiers?
- **Cross-border considerations.** SMS-OTP works in some markets where email-OTP doesn't (and vice-versa). Should noy-db ship locale-aware defaults?
