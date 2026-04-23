# Discussion #117 — v0.7 unlock flow: passphrase as root, LINE/WebAuthn/OTP as convenience, timeout model, passphrase drill vs rotation

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **State:** closed
- **Comments:** 0
- **URL:** https://github.com/vLannaAi/noy-db/discussions/117

---

This discussion captures the **full picture of how unlock works in v0.7 "Identity & sessions"** — the admin bootstrap flow, the daily-unlock flow, the client-portal flow, the full unlock-method matrix (including the new ones we're adding based on consumer feedback), and the timeout model.

It exists because the individual v0.7 tracking issues (#109 session tokens, #110 _sync_credentials, #111 auth-webauthn, #112 auth-oidc, #113 magic-link, #114 session policies) each cover one primitive but don't on their own tell the reader what the end-to-end user experience looks like. A contributor picking up one of those issues needs to see how it fits into the larger flow.

## Core principle: passphrase is the root, everything else is convenience

This is the mental shift that distinguishes noy-db from "Firebase Auth with Google." In a normal app, "Sign in with Google" *is* your identity — Google controls access. In noy-db, "Sign in with Google" (or LINE, or Apple, or biometric) is a **convenience layer on top of a KEK that was originally derived from a passphrase**. The passphrase is the root. Everything else is an additional way to unwrap the same key.

Concretely:

- **Passphrase** → PBKDF2 @ 600K iterations → KEK. The original, canonical unlock path.
- **WebAuthn (biometric / YubiKey)** → PRF secret → HKDF → wrapping key → unwraps the SAME KEK that was originally wrapped by the passphrase.
- **LINE / Google / Apple OIDC** → ID token proves identity → key connector releases one half of the KEK → combined with device secret → unwraps the SAME KEK.
- **Magic link** → one-shot URL combines server fragment with URL-fragment device secret → unwraps a viewer-scoped KEK.
- **Email / SMS OTP** → same split-key family, different delivery channel.

Lose your YubiKey? Passphrase still works. LINE closes your account? Passphrase still works. Key connector goes down? Passphrase still works. **The passphrase is the recovery root.** You write it down on paper, put it in a safe, and hope you never need it. The convenience methods are for daily use.

## Admin bootstrap flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 1 — BOOTSTRAP (one time, at first creation)                     │
├─────────────────────────────────────────────────────────────────────┤
│   Admin: "create a compartment for ACME"                             │
│   App:   "enter a passphrase"                                        │
│   Admin: types passphrase → PBKDF2 @ 600K iterations → KEK           │
│                                                                      │
│   Library creates:                                                   │
│     - compartment                                                    │
│     - owner keyring                                                  │
│     - KEK wrapped by passphrase-derived key                          │
│                                                                      │
│   At this point: ONE unlock method exists — the passphrase.          │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ STEP 2 — ENROLL ALTERNATE UNLOCK METHODS (immediately after)         │
├─────────────────────────────────────────────────────────────────────┤
│   While admin is unlocked, they enroll any combination:              │
│                                                                      │
│   (a) WebAuthn — Touch ID / Face ID / YubiKey                        │
│       → PRF → HKDF → wrapping_key → AES-KW wrap KEK → keyring        │
│       → future unlocks require only the biometric gesture            │
│                                                                      │
│   (b) LINE login (or Google / Apple)                                 │
│       → OIDC PKCE flow → LINE ID token                               │
│       → split KEK into { device_secret (local), kek_fragment }       │
│       → send kek_fragment to self-hosted key connector               │
│       → future unlocks via "Sign in with LINE" + local device_secret │
│                                                                      │
│   (c) Both (a) AND (b) — recommended for multi-device users          │
│       → Touch ID on laptop, LINE login on phone, same compartment    │
│                                                                      │
│   At this point: MULTIPLE unlock methods exist, all valid,           │
│   all unwrap the same KEK.                                           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ STEP 3 — DAILY UNLOCK (every session thereafter)                     │
├─────────────────────────────────────────────────────────────────────┤
│   UI shows:                                                          │
│     [ Sign in with LINE ]        ← default on Thai-market mobile     │
│     [ Use Touch ID / YubiKey ]                                       │
│     [ Enter passphrase ]         ← recovery, smaller button          │
│                                                                      │
│   User picks one → session starts → compartment opens.               │
│   Passphrase is NEVER typed in normal daily use.                    │
└─────────────────────────────────────────────────────────────────────┘
```

After Step 2, the passphrase becomes a **recovery credential**, not a daily-use credential. Best practice: write it down on paper at enrollment time, store it securely offline, never type it again unless recovery is needed.

## Client portal flow (completely separate from admin flow)

Clients — the non-technical end users who read their own records — do not enroll anything, do not install anything, do not type anything. They receive a time-limited link (or code) by email and click it:

```
Admin (already unlocked, inviting a client):
  → grant(compartment, 'bob@acme.com', role: 'viewer', scope: ['invoices'])
  → issueMagicLink(compartment, grantedTo: 'bob', expiresInMs: 15 * 60 * 1000)
  → library returns URL: https://portal/open?t=...#...
  → admin's email service delivers it to Bob

Bob (no account, no enrollment):
  → clicks link → portal opens
  → page reads token from URL
  → talks to magic-link server → gets viewer-scoped KEK
  → opens READ-ONLY session for 15 minutes
  → closes tab → session destroyed, link never works again
```

The admin flow (passphrase + WebAuthn + OIDC) and the client flow (magic link) are deliberately different primitives. Trying to unify them — "clients also get passphrases" — produces the Dropbox-password-protected-link UX that nobody actually uses.

## Full unlock method matrix

Based on consumer feedback, here's the complete set of unlock methods we're planning for v0.7. Some are already tracked in issues; the new ones from this discussion are marked.

| Method | Tracking | Security | Use case | Default? |
|---|---|---|---|---|
| **Passphrase** | #109 | Strong | Bootstrap, recovery | Required at day-zero |
| **WebAuthn (device-bound)** — Touch ID, YubiKey | #111 | Strongest daily | Staff on their own devices | Recommended |
| **OIDC — LINE (v1 ref)** | #112 | Strong (split-key) | Thai mobile staff | Recommended for Thai market |
| **OIDC — Google, Apple** | #112 | Strong (split-key) | International staff | Supported |
| **Magic link (URL click)** | #113 | Strong | Client portals, viewer role | Recommended for clients |
| **Email OTP (code entry)** | **new — add to #113** | Medium, weaker than magic link | Clients who struggle with links | Optional, tighter TTL |
| **"Trust this device"** (long-TTL on WebAuthn-unlocked session) | **#114 perMethodOverrides** | Strong, matches biometric-is-enough bar | Daily driver device | Opt-in policy |
| **Dev persistent unlock** (no biometric, IDB-backed) | **#119** | Weak — dev-only, hard-blocked in prod | Local development inner loop | Admin opt-in at compartment creation, hard-blocked in production |
| ~~SMS OTP~~ | ~~closed: #118~~ | ~~Weak~~ | ~~Not shipping~~ | ~~Explicitly out of scope — see "SMS OTP: explicitly out of scope" below~~ |

## The new methods in detail

### Email OTP as a delivery variant of magic-link

Structurally, email OTP is a variant of magic-link: user receives an ephemeral secret over email, combines it with a local secret, reconstructs a viewer-scoped KEK. The difference is the channel:

- **Magic link** delivers the token as a URL: `https://portal/open?t=<token>#<device_secret>`. The `#<device_secret>` lives in the URL fragment, which browsers do not send to servers and do not log. Even if an email forwarding server logs the full URL, the device_secret is preserved.
- **Email OTP** delivers a 6-to-8-digit code: `Your code is 847293.` The code IS the full token. Anyone who sees the email has everything needed to redeem it.

Email OTP is therefore **strictly weaker than magic-link** for the same delivery channel. It should be offered only to users who can't reliably click links (screen readers, very old email clients, paste-rather-than-click workflows) and should come with:

- **Tighter TTL**: 2 minutes instead of 15.
- **Stricter rate limits**: 3 redemption attempts, then the code is burned.
- **Shorter scope**: always viewer-only, never extended to write access.
- **Device binding**: the code can only be redeemed on the device that requested it (browser fingerprint match), raising the bar for email-replay attacks.

**Not a default.** Magic link is the default delivery; email OTP is a consumer opt-in per invite.

### SMS OTP — explicitly out of scope

**Update (post-#118 close)**: SMS OTP will not ship. The tradeoffs do not work out:

1. **SIM swap attacks** — attacker convinces a telco (often via social engineering) to port the target's number to an attacker-controlled SIM. Cheap, well-documented, regular occurrence especially in emerging markets.
2. **SS7 interception** — older telecom signaling protocol that lets attackers with carrier access intercept SMS without touching the target's SIM.
3. **NIST 800-63B, OWASP, and the FIDO Alliance** all moved SMS out of the "something you have" authentication category in 2017 and reaffirmed in 2020/2024.
4. **LINE exists** — the primary Thai-market consumer already has LINE messaging as a cryptographically stronger out-of-band channel. Shipping SMS would weaken the overall security posture by presenting it as comparable to LINE when it is not.
5. Every guardrail that would make SMS OTP "safe enough" also makes it so marginal (second-factor-only, viewer-scope-only, 2-minute TTL, tight rate limits) that shipping it sends the wrong signal.

Consumers who need SMS-based verification flows can implement them in their own application layer using the existing OIDC or magic-link primitives; the library does not carry the implementation in core. The closed issue #118 preserves this decision for future reference.

### Dev-mode persistent unlock (#119)

**The one explicit "unlock once, stay unlocked forever" escape hatch — strictly for development, hard-blocked everywhere else.**

Developers building on top of noy-db hit a friction point that the session model fights: hot-reload, multi-tab dev, E2E tests, REPL exploration. Every v0.7 unlock method is correctly bounded for production and annoying for 10pm-Tuesday debugging. Issue #119 adds a **sanctioned** primitive for that case so developers stop hardcoding passphrases in `.env.development` files.

**Dev unlock is:**

- **Opt-in at compartment creation only.** The admin sets `devUnlock.enabled: true` and an `acknowledge: 'I-UNDERSTAND-THIS-DISABLES-UNLOCK-PROMPTS-FOR-THIS-BROWSER-PROFILE'` literal constant. It cannot be retroactively enabled on an existing compartment.
- **Hard-blocked in production** via `NODE_ENV`, `import.meta.env.PROD`, non-localhost origin checks, and CI-environment detection.
- **Hard-blocked with remote adapters** (Drive, S3, Dynamo) and hard-blocked when OIDC is also enabled on the same compartment.
- **Stored as a distinct envelope shape** (`_dev_unlock: true` marker) in IndexedDB, wrapped by a non-extractable AES-KW key. Tree-shaken out of production builds entirely, CI-asserted.
- **Forces stricter `requireReAuthFor`** than normal sessions — even though unlock is free, `dump()` / `grant()` / `rotate()` / `changeSecret()` still require an explicit re-auth prompt, because those are the operations that would accidentally leak the KEK into production artifacts.
- **Permanent visible banner** in every dev-unlock session via `devUnlock:active` event → scaffolder template renders a persistent red bar at the top of the page. Not dismissible for the session duration.
- **Never works on mobile** (no clean localhost analog) and **never works for non-owner roles** (operator/viewer/client cannot have dev-unlock credentials).

This is the **only** v0.7 unlock method that intentionally violates the "KEK lives only in memory during an active session" invariant. Every other method enforces that invariant; dev unlock explicitly sets it aside for local development and enforces every imaginable guardrail to prevent it from leaking into production.

Compare to **naked mode** (#106), which similarly violates an invariant (this one being "adapters only see ciphertext") for debugging purposes. The two features use the same guardrail pattern: literal acknowledgment constant, production build tree-shake, distinct envelope marker, loud runtime warnings, no remote-adapter combination, ledger-recorded enable/disable events.

**Rule of thumb**: if you find yourself typing `.env.development` and pasting a passphrase, use dev unlock instead. If you find yourself doing anything else, don't.

### "Trust this device" — long-TTL sessions on device-bound biometric

**Clarification first**: you already get "trust this device" for free when you enroll WebAuthn. Biometric unlock IS the re-prompt. What you're actually asking for is: **don't make me go through LINE / Google / OIDC every 8 hours when I'm on my own laptop with Touch ID already enrolled.**

That's a session-policy knob, not a new unlock method. Proposed addition to #114:

```ts
{
  absoluteTimeoutMs: 8 * 60 * 60 * 1000,  // default 8 hours
  perMethodOverrides: {
    'webauthn-device-bound': {
      absoluteTimeoutMs: 30 * 24 * 60 * 60 * 1000,  // 30 days for biometric
      idleTimeoutMs: 60 * 60 * 1000,                 // 1h idle
    },
    'webauthn-synced-passkey': {
      absoluteTimeoutMs: 4 * 60 * 60 * 1000,  // reduced for synced credentials
    },
    'oidc': {
      absoluteTimeoutMs: 8 * 60 * 60 * 1000,  // standard for OIDC
    },
    'passphrase': {
      absoluteTimeoutMs: 8 * 60 * 60 * 1000,
    },
    'magic-link': {
      absoluteTimeoutMs: 30 * 60 * 1000,  // client portals — tight
    },
    'email-otp': {
      absoluteTimeoutMs: 15 * 60 * 1000,  // weaker than magic-link — tighter
    },
    'dev-unlock': {
      absoluteTimeoutMs: Infinity,  // dev-only, the whole point
      idleTimeoutMs: Infinity,
      // but stricter re-auth than normal — see #119
    },
  },
}
```

This mirrors how 1Password, Bitwarden, and Authy handle the same question: biometric on a device-bound credential extends the session because the re-prompt is local and strong; synced credentials and email/SMS do not get the same treatment.

## Passphrase timeout — why the answer is "drill, not rotate"

You asked whether there's a timeout on the passphrase itself — something like "every month you must re-enter the passphrase for security." I'd push back on the "must re-enter" framing and split it into two separate mechanisms, both optional.

**Not recommended: mandatory periodic passphrase rotation.**

NIST Special Publication 800-63B, section 5.1.1.2 (published 2017, reaffirmed 2020 and 2024):

> Verifiers SHOULD NOT require memorized secrets to be changed arbitrarily (e.g., periodically).

Microsoft, CISA, UK NCSC, and every major security guidance body followed. The reasoning: forced periodic rotation causes users to pick weaker, more memorable passphrases (`Password2024!` → `Password2025!`), reuse across sites, and write them on sticky notes. Observable outcomes are strictly worse than "pick a strong passphrase once and leave it."

**Recommended: two separate configurable knobs.**

### `passphraseReAuthIntervalMs` — forced re-entry

Some consumers are subject to regulatory frameworks that still require periodic re-auth (SOC 2 Type II audits, certain EU DPA positions, some internal security policies). For them, the library should support it — disabled by default, enabled per compartment via policy:

```ts
{
  passphraseReAuthIntervalMs: 30 * 24 * 60 * 60 * 1000,  // 30 days
  // After 30 days since last passphrase unlock, next session forces
  // passphrase entry even if biometric/OIDC would normally suffice.
}
```

Default: disabled. Consumers who need it opt in.

### `passphraseDrillIntervalMs` — memory check, not unlock requirement

The **legitimately valuable** version of what you asked for. After months of biometric-only unlock, users forget their passphrases. When they actually need recovery — lost device, new machine, LINE account closed — they discover the passphrase is gone and they're locked out permanently.

A **passphrase drill** is a periodic, out-of-band prompt:

> "It's been 45 days since you last typed your recovery passphrase. Please type it now to confirm you still remember it. This does not unlock the app — you're already unlocked. It's just a memory check."

If the user types it correctly, the drill is dismissed and reset. If they get it wrong, the library offers to let them re-enroll a new passphrase (which requires unlocking the KEK first — trivially, because they're already in a session). If they skip the drill, it's persistent and becomes more insistent over time.

```ts
{
  passphraseDrillIntervalMs: 45 * 24 * 60 * 60 * 1000,  // 45 days
  passphraseDrillNagAfterMs: 60 * 24 * 60 * 60 * 1000,  // after 60 days, harder to dismiss
}
```

Default: **enabled**, at 45-day interval. This is the one knob that should be on by default because forgetting a recovery credential is a common failure mode and the drill costs almost nothing.

## Timeout summary table

All of the following live in the session policy (#114) and are configurable per compartment:

| Timer | Default | What happens when it fires | Scope |
|---|---|---|---|
| `idleTimeoutMs` | 15 min | Session destroys silently; next operation throws `SessionExpiredError` | Per session |
| `absoluteTimeoutMs` | 8 hours | Session destroys regardless of activity | Per session |
| `pagehide` / `visibilitychange→terminated` | Instant | Synchronous destroy before tab unloads | Always on |
| `perMethodOverrides.webauthn-device-bound.absoluteTimeoutMs` | 30 days | Extended ceiling when unlocked via biometric on device-bound credential | Session-specific |
| `passphraseDrillIntervalMs` | 45 days | Prompts for memory check, does NOT force unlock | Cross-session |
| `passphraseReAuthIntervalMs` | disabled | Forces passphrase re-entry at next unlock | Cross-session |

## Open questions

1. **Should `passphraseDrillIntervalMs` be on-by-default?** My lean is yes — forgotten recovery credentials are a common failure mode and the cost is low. Others may prefer zero surprises from the library and want it opt-in.
2. **Email OTP device binding** — should it be tied to a browser fingerprint? That introduces a tracking primitive we otherwise avoid. Alternatives: require the OTP to be entered on the same `localStorage`-scoped origin where it was requested (which is essentially what a session cookie would be).
3. **SMS OTP at all?** There's a reasonable argument that we should just refuse to ship SMS, document why, and point consumers at WhatsApp / LINE messaging as a cryptographically stronger out-of-band channel. The counterargument: if we don't ship it, consumers will reach for Firebase Phone Auth and defeat the zero-knowledge property entirely.
4. **Per-method overrides — how granular?** The proposed list has 7 method names. Should we add more (`webauthn-platform-synced`, `webauthn-platform-device-bound`, distinguishing Touch ID with vs without iCloud Keychain sync) or keep it simple?
5. **Trust-this-device TTL maximum**. Is 30 days the right ceiling, or should there be an absolute maximum the policy can set? Bitwarden caps biometric unlock at ~90 days; 1Password allows indefinite within a session. Lean: hard-cap at 90 days, configurable within that.

## Cross-references

This discussion is the canonical "how does unlock actually work" reference for v0.7. Individual implementations are tracked in:

- #109 — session tokens (the primitive everything else depends on)
- #110 — _sync_credentials (adapter token storage)
- #111 — @noy-db/auth-webauthn (device-bound biometric + hardware keys)
- #112 — @noy-db/auth-oidc (LINE / Google / Apple split-key)
- #113 — magic-link + email OTP variant (client portals)
- #114 — session policies (all the timeout knobs, per-method overrides, passphrase drill)
- #119 — dev-mode persistent unlock (opt-in at setup, hard-blocked in production)
- ~~#118 SMS OTP~~ — closed, not shipping

Updates to #113 and #114 based on this discussion will reference back here.


