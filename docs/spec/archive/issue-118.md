# Issue #118 — feat(auth-sms): SMS OTP as explicitly weaker, second-factor-only, viewer-scoped unlock path

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-08
- **Milestone:** v0.7.0
- **Labels:** type: feature, type: security, priority: low, area: core

---

## Summary

Ship **SMS OTP** as an **explicitly weaker, second-factor-only** unlock method for consumers whose end users expect it (common in many Asian markets including Thailand). SMS is the weakest unlock primitive in the v0.7 lineup, and this issue exists to document that explicitly and to ensure the implementation cannot be misused as a sole unlock method.

**This is filed as a separate issue (rather than folded into #113 magic-link) so the security tradeoff is visible in the tracker, not buried in sibling design.** A contributor who reads only the SMS OTP issue should see the caveats on the first screen.

## Motivation

SMS OTP is **expected UX** in many markets. Thai consumers in particular are used to receiving 6-digit codes over SMS for banking, government services, and LINE account verification. Refusing to ship any SMS path pushes consumers toward Firebase Phone Auth or equivalent, which silently defeats the zero-knowledge property.

At the same time, every major security guidance body has moved SMS out of "something you have":

- **NIST 800-63B (2017, reaffirmed 2024)**: Section 5.1.3.3 restricts out-of-band SMS due to "risks inherent in the public switched telephone network" — specifically SIM swap and SS7 interception.
- **FIDO Alliance**: explicitly recommends hardware keys or platform authenticators over SMS.
- **OWASP Authentication Cheat Sheet**: flags SMS as "not recommended" for high-security contexts.

The two attack vectors:

1. **SIM swap** — attacker social-engineers a telco carrier into porting the victim's number to an attacker-controlled SIM. Now the attacker receives SMS. Well-documented, happens regularly, very hard to defend against as an end user.
2. **SS7 interception** — attackers with telecom-network access intercept SMS in flight without touching the victim's SIM. Harder to execute but requires no social engineering.

The only honest way to ship SMS is to treat it as a **convenience signal**, not a security primitive.

## Proposed design

### Hard constraints — all enforced at the code level

1. **SMS OTP is NEVER the sole unlock method.** It must be paired with at least one stronger factor (passphrase, WebAuthn, or OIDC). Attempting to configure SMS as a sole unlock method throws `SmsSoleUnlockRefusedError` at enrollment time.
2. **SMS OTP unlocks ONLY viewer-scoped KEKs.** A compartment policy cannot configure SMS as an unlock path for owner, admin, or operator roles. Attempting to do so throws `SmsOwnerUnlockRefusedError` at configuration time.
3. **SMS OTP is disabled by default.** Every compartment starts with `allowSmsUnlock: false`. Enabling it is an explicit, auditable policy change.
4. **Consent warning on enrollment.** The enrollment flow displays a modal explaining SIM swap and SS7 risks before the user can proceed. The consent is captured in the ledger as a `sms_enrollment_acknowledged` entry.
5. **Short TTL**: 2 minutes default, hard-capped at 5 minutes maximum. Cannot be extended via policy.
6. **Tight rate limits**: 3 redemption attempts per code, 5 codes per phone per hour, 20 codes per phone per day. Enforced at the SMS server, not client-side.

### Flow

Structurally similar to email OTP (#113 with the email-OTP variant), but with SMS as the delivery channel and even tighter constraints:

```
ENROLLMENT (once, by the end user, after they've already unlocked
            via a stronger factor at least once)
─────────────────────────────────────────────────────────────────

1. User types phone number in the app.
2. Library generates device_secret (32 random bytes, stored locally).
3. Library generates kek_fragment via HKDF split of the viewer KEK.
4. Library sends kek_fragment to SMS OTP server, bound to phone number.
5. SMS OTP server sends a verification SMS ("Your code is 483921")
   to prove the user controls the phone number.
6. User types the code → enrollment confirmed.

Nothing is unlocked by enrollment. The phone number is just registered.

DAILY UNLOCK
────────────

1. User requests SMS unlock in the portal.
2. SMS OTP server generates a 6-digit code, sends via SMS.
3. User types the code within 2 minutes.
4. Server returns kek_fragment.
5. Client combines with local device_secret → viewer KEK.
6. READ-ONLY session opens.
```

### Why not unify with email OTP?

Email OTP (folded into #113) and SMS OTP share crypto primitives but differ in:

- **Threat model**: email has CSRF-like risks (email forwarding, inbox compromise); SMS has telco-level risks.
- **Rate limits**: SMS costs real money per message and has telco quotas; email is effectively free.
- **Delivery infrastructure**: SMS requires a gateway provider (Twilio, Vonage, regional Thai providers); email can use the consumer's existing SMTP.
- **Regulatory treatment**: SMS is telecom-regulated in many jurisdictions; email isn't.
- **Security warnings**: SMS needs louder warnings that would clutter the magic-link/email-OTP UX.

Keeping them separate keeps the magic-link/email-OTP path clean for the common case and lets SMS opt-in be explicit.

## Acceptance criteria

- [ ] **SMS cannot be the sole unlock method.** Configuring a compartment with only SMS enabled throws at `createCompartment()` time. Covered by test.
- [ ] **SMS cannot unlock owner/admin/operator roles.** Attempting to grant SMS unlock to those roles throws. Covered by test.
- [ ] **SMS is disabled by default.** A fresh compartment has `allowSmsUnlock: false` in its policy. Covered by test.
- [ ] **Enrollment records a consent entry in the ledger** with the timestamp and the acknowledgment payload. Covered by test.
- [ ] **OTP codes expire in 2 minutes default**, hard-capped at 5 minutes even if policy tries to extend. Covered by test.
- [ ] **Rate limits enforced server-side**: 3 attempts/code, 5 codes/phone/hour, 20 codes/phone/day. Covered by integration test against reference server.
- [ ] **Session produced by SMS unlock is read-only and viewer-scoped.** Write attempts throw `ReadOnlySessionError`. Covered by test.
- [ ] **The library refuses to run without an explicit SMS gateway configuration.** No default gateway, no hardcoded provider. Consumer must wire in their own. Covered by test.
- [ ] **Security warning modal is non-skippable** on first enrollment. Automated test verifies the consent state cannot be bypassed programmatically.

## Reference SMS gateway abstraction

We do NOT ship an SMS gateway. Consumers wire in their own:

```ts
interface SmsGateway {
  send(phoneNumber: string, message: string): Promise<{ messageId: string }>
}

const db = await createNoydb({
  sessionPolicy: {
    unlockMethods: {
      smsOtp: {
        enabled: true,                // explicit opt-in
        gateway: myTwilioGateway,     // consumer provides
        ttlMs: 2 * 60 * 1000,
        maxAttemptsPerCode: 3,
        maxCodesPerPhonePerHour: 5,
      },
    },
  },
})
```

Consumer wires `myTwilioGateway` to whatever they use (Twilio, Vonage, AWS SNS, regional Thai SMS provider, etc.). The library never imports a gateway SDK — zero dependency surface.

## Out of scope

- **WhatsApp / Telegram / LINE message OTP** — these are encrypted out-of-band channels and would actually be *stronger* than SMS. Worth a separate discussion if consumers ask. Not part of this issue.
- **Voice OTP** (call a number, listen to a code). Same telco vulnerabilities as SMS, lower usability, no reason to ship.
- **Email+SMS combined 2FA** (both required). If a consumer needs multi-factor that strong, they should use passphrase + WebAuthn instead.
- **SMS-delivered magic link URL.** SMS length limits (160 chars) and the ugly appearance of long URLs in SMS make this worse than either pure SMS OTP or pure email magic link. Skip.

## Open questions

1. **Do we ship this at all, or do we refuse and document why?** There's a defensible position that says "SMS is not good enough, we will not carry the implementation in core, and consumers who need it can implement it themselves using our existing primitives." The counterargument: consumers will reach for Firebase Phone Auth and lose zero-knowledge entirely. Lean: ship it with strong constraints, because the alternative is worse.
2. **Should the 2-minute TTL be even shorter?** Banking apps in Thailand commonly use 30-second TTLs. The tradeoff is usability — an elderly user might take 45 seconds to type the code. Lean: 2 minutes default, configurable down to 30 seconds.
3. **Phone number verification separate from unlock?** Should there be a separate "verify this is your number" step before it can be used for unlock? Current proposal folds verification into enrollment. Alternative: require a separate verification event recorded in the ledger.
4. **Rate-limit storage.** The rate limits need a server-side store that survives restarts. Redis? Just a SQL table? Lean: leave the choice to the consumer; document the required semantics in the gateway interface.

## Dependencies

Depends on:
- #109 — session tokens (sessions must exist)
- #113 — magic-link + email OTP (shares the split-key helper and the OTP machinery)
- #114 — session policies (the `unlockMethods.smsOtp` config surface lives there)

## Priority

**Low** for v0.7. Ship after the stronger unlock methods (WebAuthn, OIDC, magic-link) are stable. If v0.7 ships without SMS OTP, that's fine — consumers can still use all the other methods. Include it only if bandwidth permits and a consumer is asking for it.
