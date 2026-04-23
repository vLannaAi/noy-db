# Issue #114 — feat(core): session policies — idle/absolute timeouts, requireReAuthFor, lockOnBackground, role overrides

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-09
- **Milestone:** v0.7.0
- **Labels:** type: feature, type: security, area: core

---

## Summary

Add **session policies** as a configuration surface on top of the session-tokens primitive. A session policy is a small declarative object that controls timeouts, re-auth requirements, and post-unlock behavior:

```ts
{
  idleTimeoutMs: 15 * 60 * 1000,      // 15m
  absoluteTimeoutMs: 8 * 60 * 60 * 1000, // 8h
  requireBiometricForExport: true,    // dump() re-prompts
  requireBiometricForGrant: true,     // grant/revoke re-prompts
  lockOnBackground: false,            // destroy on tab hide vs just pause idle
  maxConcurrentSessions: 1,           // per user per compartment
}
```

Policies are set at compartment creation time, persisted in the compartment's keyring, and enforced by the session primitive. Changing a policy is itself a policy-governed operation (admins only, audit-logged).

This is the smallest, most config-surface-only issue in v0.7 — it's entirely shaped around the session-tokens primitive and only exists because a single `idleTimeoutMs` hardcoded in core would not survive first contact with real consumers.

## Motivation

Different deployments have legitimately different requirements:

- **Accounting firm staff** at their desks want 8-hour absolute timeouts and long idle windows — constant re-prompting is friction during a billable-hours session.
- **Client portals** want aggressive timeouts (2 minutes idle, 15 minutes absolute) because the users are non-technical and may leave tabs open indefinitely.
- **Shared-workstation setups** need "lock immediately on tab background" because a user walking away should not leave an unlocked compartment for the next person at the keyboard.
- **Mobile field use** needs the opposite — tolerate 5-minute backgrounds for phone calls without re-prompting.
- **Export-sensitive workflows** need "prompt biometric again before dump()" so an unlocked but idle session can't be silently exfiltrated by a malicious script.

A single hardcoded default cannot serve all of these. But we also don't want to litter every API call with an options bag — the policy belongs to the compartment, not to each call site.

## Proposed design

### Policy shape

```ts
interface SessionPolicy {
  // Timeouts (see session-tokens issue for the primitive behavior)
  idleTimeoutMs: number               // default: 15 * 60 * 1000
  absoluteTimeoutMs: number           // default: 8 * 60 * 60 * 1000

  // Re-auth requirements — operations that require a fresh biometric/passphrase
  // prompt even inside an active session
  requireReAuthFor: ReAuthOperation[]
  // Options: 'export' | 'grant' | 'revoke' | 'rotate' | 'changeSecret'
  //          | 'deleteCompartment' | 'oidcEnroll' | 'webauthnEnroll'

  // Background behavior
  lockOnBackground: boolean           // default: false
  //   true  → destroy session on visibilitychange→hidden
  //   false → pause idle timer on hidden, resume on visible

  // Concurrency
  maxConcurrentSessions: number       // default: 1 per user per compartment
  //   >1 is allowed for multi-tab workflows but discouraged

  // Per-unlock-method overrides — see discussion #117
  // Sessions unlocked via device-bound biometric credentials have a
  // different risk profile than sessions unlocked via OIDC or OTP.
  // This lets a single compartment policy express "biometric is
  // enough for 30 days, but OTP gets 15 minutes."
  perMethodOverrides?: Partial<Record<UnlockMethod, Partial<SessionPolicy>>>
  //   'passphrase' | 'webauthn-device-bound' | 'webauthn-synced-passkey'
  //   | 'oidc' | 'magic-link' | 'email-otp' | 'dev-unlock'
  //   (sms-otp removed — see closed #118)

  // Passphrase drill — periodic memory check (default: enabled)
  // Prompts the user to re-type the passphrase occasionally to prove
  // they still remember it. Does NOT force unlock — it's a recovery
  // credential drill. If the user has been biometric-only for months
  // and has forgotten the passphrase, they discover it during a drill
  // while still unlocked, not during an actual lockout emergency.
  passphraseDrillIntervalMs?: number    // default: 45 * 24 * 60 * 60 * 1000 (45 days)
  passphraseDrillNagAfterMs?: number    // default: 60 * 24 * 60 * 60 * 1000 (60 days)

  // Passphrase forced re-auth — periodic required re-entry (default: disabled)
  // For consumers subject to regulatory frameworks (SOC 2, some EU DPA
  // positions) that still require periodic password re-entry despite
  // NIST 800-63B deprecating the practice. Disabled by default because
  // forced rotation produces weaker passphrases on average.
  passphraseReAuthIntervalMs?: number   // default: undefined (disabled)

  // Role-specific overrides
  roleOverrides?: Partial<Record<RoleName, Partial<SessionPolicy>>>
  //   e.g. { viewer: { idleTimeoutMs: 2 * 60 * 1000 } }
  //   Lets client portals tighten timeouts for viewer roles without
  //   affecting staff.
}
```

### Where the policy lives

Policies are stored in the compartment keyring as a reserved field. They travel with the compartment (included in `dump()`, restored on `load()`), so a compartment migrated to a new device retains its security posture.

Changing a policy is itself a sensitive operation:

- Only owners and admins can change policies.
- Policy changes are ledger entries — auditable, tamper-evident.
- Tightening a policy takes effect immediately for all new sessions; loosening requires re-auth of the owner/admin making the change.
- Policies can only become **stricter** in roleOverrides than the base policy, never looser. A viewer override cannot say "longer idle timeout than owners" — that would be a privilege escalation.

### Re-auth semantics

`requireReAuthFor` is the policy's most interesting knob. Operations on the list force a fresh biometric / passphrase prompt even inside an active session. Implementation:

```ts
// When an operation listed in requireReAuthFor is invoked:
await session.reAuth({ operation: 'export' })
// → prompts the user via the original unlock path (passphrase / WebAuthn / OIDC)
// → on success, issues a short-lived "re-auth grant" token valid for 60 seconds
// → the operation proceeds using that grant
// → grant is consumed on first use, cannot be reused for a second operation
```

The re-auth grant is a separate, short-lived credential from the session itself. This means:

- A session that can read invoices all day does not automatically have permission to `dump()` them — export is gated separately.
- An XSS that steals the session cannot use it to exfiltrate data via `dump()` without also triggering a user-visible re-auth prompt.
- The re-auth grant is single-use and expires fast, so a compromised grant buys the attacker ~60 seconds of one operation.

Default `requireReAuthFor` set is `['export', 'grant', 'revoke', 'rotate', 'changeSecret', 'deleteCompartment']`. Consumers who find this too strict can shorten the list; there is no way to make it stricter than "every operation" because that would make the session primitive pointless.

### API surface

```ts
// Setting a policy at compartment creation
const compartment = await db.createCompartment('acme', {
  sessionPolicy: {
    idleTimeoutMs: 15 * 60 * 1000,
    absoluteTimeoutMs: 8 * 60 * 60 * 1000,
    requireReAuthFor: ['export', 'grant', 'revoke'],
    lockOnBackground: false,
    maxConcurrentSessions: 1,

    // Per-method overrides — biometric is treated as stronger
    perMethodOverrides: {
      'webauthn-device-bound': {
        absoluteTimeoutMs: 30 * 24 * 60 * 60 * 1000, // 30d for device-bound biometric
        idleTimeoutMs: 60 * 60 * 1000,                // 1h idle
      },
      'webauthn-synced-passkey': {
        absoluteTimeoutMs: 4 * 60 * 60 * 1000,  // tighter for synced credentials
      },
      'magic-link':  { absoluteTimeoutMs: 30 * 60 * 1000 },
      'email-otp':   { absoluteTimeoutMs: 15 * 60 * 1000 },

      // Dev-only unlock (#119) — infinite TTL is intentional, but this
      // override is only honored in non-production builds. The entire
      // dev-unlock code path tree-shakes out of production, and the
      // perMethodOverride for 'dev-unlock' is ignored outside localhost
      // contexts. See #119 for the full guardrail list.
      'dev-unlock':  {
        absoluteTimeoutMs: Infinity,
        idleTimeoutMs: Infinity,
        // requireReAuthFor is HARDCODED stricter for dev-unlock
        // regardless of what the policy says — the library enforces
        // export/grant/rotate/changeSecret always require a fresh
        // acknowledgment even in dev mode.
      },
    },

    // Passphrase drill — enabled by default, nags harder after 60d
    passphraseDrillIntervalMs: 45 * 24 * 60 * 60 * 1000,
    passphraseDrillNagAfterMs: 60 * 24 * 60 * 60 * 1000,

    // Passphrase forced re-auth — disabled by default (NIST 800-63B)
    // Uncomment only if your compliance framework requires it:
    // passphraseReAuthIntervalMs: 30 * 24 * 60 * 60 * 1000,

    roleOverrides: {
      viewer: { idleTimeoutMs: 2 * 60 * 1000, lockOnBackground: true },
      client: { idleTimeoutMs: 2 * 60 * 1000, lockOnBackground: true },
    },
  },
})

// Updating a policy later (requires re-auth)
await db.updateSessionPolicy('acme', {
  ...currentPolicy,
  idleTimeoutMs: 30 * 60 * 1000,  // extending — requires re-auth
}, { reAuth: await session.reAuth({ operation: 'changeSecret' }) })

// Reading the current policy
const policy = await db.getSessionPolicy('acme')
```

## Acceptance criteria

- [ ] **Policy is persisted in the keyring** and survives `dump()` / `load()` round trips. Covered by test.
- [ ] **Policy changes are ledger entries.** Covered by test — the ledger contains a `policy_changed` entry with before/after hashes.
- [ ] **`requireReAuthFor` operations throw `ReAuthRequiredError`** when called without a valid re-auth grant. Covered per-operation.
- [ ] **Re-auth grants are single-use.** A grant used once cannot be reused for a second operation even within its TTL. Covered by test.
- [ ] **Re-auth grants expire within 60 seconds** of issuance regardless of use. Covered by test.
- [ ] **Role overrides can only tighten**, never loosen. An override that loosens throws `InvalidPolicyError`. Covered by test.
- [ ] **Tightening takes effect on new sessions immediately**; existing sessions are re-evaluated against the new policy at their next idle-timer check (i.e. a session whose owner just tightened the timeout from 1h to 15m may have its effective timeout shortened mid-session).
- [ ] **Loosening requires a re-auth grant** from the user making the change. Covered by test.
- [ ] **`perMethodOverrides` are evaluated at session-creation time** based on which unlock method produced the session. A session unlocked via WebAuthn does not switch to OIDC limits mid-flight if the user also has OIDC enrolled. Covered by test.
- [ ] **`perMethodOverrides` can only tighten within limits** — the maximum `absoluteTimeoutMs` for any method is **90 days hard-cap**, matching Bitwarden's biometric ceiling. Configuring longer throws `InvalidPolicyError`. Covered by test.
- [ ] **`passphraseDrillIntervalMs` defaults to 45 days, enabled**. After the interval, the next session shows a non-blocking prompt asking the user to verify they still remember the passphrase. Dismissing the prompt does NOT prevent unlock; it reschedules the drill.
- [ ] **Passphrase drill is NOT a required re-auth** — if the user answers correctly, the drill is reset; if they answer wrong, the library offers to re-enroll a new passphrase using the currently-unlocked KEK; if they dismiss, the drill fires again at `passphraseDrillNagAfterMs`.
- [ ] **`passphraseReAuthIntervalMs` defaults to undefined (disabled)**. When set, the next unlock after the interval forces passphrase entry even if a stronger unlock method would normally succeed. Covered by test.
- [ ] **Passphrase drill and forced re-auth are independent**. Having one does not imply the other.
- [ ] **`maxConcurrentSessions`** enforced across tabs via BroadcastChannel. Opening a third session when `max=2` either refuses or destroys the oldest. Covered by test.

## Open questions

1. **Should `lockOnBackground` have a grace period?** "Lock after 5 seconds of being hidden" rather than "lock instantly on visibilitychange"? The instant version handles shared workstations but causes false alarms on mobile when the OS briefly backgrounds for a notification. Lean: configurable, default 0 (instant) for strict mode, configurable up to 30s for mobile-friendly.
2. **Re-auth via a different method than the original unlock?** If the user unlocked via OIDC, should re-auth require the OIDC flow again, or is a local WebAuthn enough? Lean: local WebAuthn is enough — re-auth is about proving *presence*, not re-establishing *identity*.
3. **Per-collection policies.** Should some collections have stricter re-auth rules than others? (E.g. financial records require re-auth on every read.) Probably YAGNI for v1, leave as a v0.8+ extension.
4. **Enterprise policy push.** Should there be a way for an admin to push a policy update to all devices that have unlocked a compartment? Nice to have, but requires a communication channel we don't have yet. Defer.
5. **Default policy for the `client` role.** Clients using magic-link unlock need different defaults than clients using OIDC. Lean: the default policy set is keyed on role, not on unlock method, and magic-link unlock always tightens further than the stored client policy.

## Non-goals

- Centralized policy management across multiple compartments. Each compartment owns its own policy.
- Policy inheritance from some global "organization policy." One compartment, one policy.
- Runtime policy tuning from DevTools or an admin console. Policies change via the same API as any other secure operation — through the keyring, with ledger entries, under re-auth.

## Dependencies

Blocked by:
- Session-tokens issue (policies configure session behavior; the primitive has to exist first)
- Re-auth infrastructure overlaps with WebAuthn unlock (re-auth prompts use the same path)

Does not block anything else directly, but enables:
- `requireBiometricForExport` is what makes the naked-mode issue's "dump() refuses in naked mode unless explicit" policy enforceable in production mode too.
