# Issue #119 — feat(core): dev-mode persistent unlock — admin opt-in at setup, no biometric, heavy guardrails (dev-only)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-09
- **Milestone:** v0.7.0
- **Labels:** type: feature, type: security, priority: low, area: core

---

## Summary

Add **persistent dev-mode unlock** — an opt-in, development-only session mode where the wrapped KEK is stored locally in the browser and the compartment auto-unlocks on every load without any biometric, passphrase, or OIDC prompt. Exists purely so that developers building on top of noy-db can hot-reload, refresh, and iterate without re-entering a passphrase every 15 minutes.

**This is a loaded footgun.** Like naked mode (#106), the issue is as much about the guardrails as the feature itself. Done wrong, it becomes a one-flag path to shipping an app where the KEK is essentially public. Done right, it's a scoped dev convenience that cannot escape a local machine.

## Motivation

During development the session-timeout model fights the inner-loop:

- Hot-reload on every save → session destroyed by page-navigation semantics → re-prompt
- Running the same compartment across multiple dev tabs → each needs its own unlock
- E2E tests that open the app → can't type passphrases in headless runs
- Playing with the REPL / Vue devtools → constant re-auth interrupts exploration

Every v0.7 unlock method is designed to bound exposure. That's right for production and wrong for 10pm-on-a-Tuesday-debugging. The existing workaround is "hardcode a passphrase in a `.env.development` and read it from `createNoydb()` options." That works, but:

- It's ad-hoc per project
- The passphrase ends up in git history sooner or later
- It doesn't actually match what "unlock once, stay unlocked" should feel like
- There's no library-level mechanism to refuse it in production

This issue replaces the ad-hoc workaround with a sanctioned primitive that cannot accidentally ship.

## Proposed design

### Opt-in at compartment creation only, never retroactively

```ts
const db = await createNoydb({
  auth: { userId: 'dev', passphrase: 'dev' },
  adapter: memory(),
  devUnlock: {
    enabled: true,
    acknowledge: 'I-UNDERSTAND-THIS-DISABLES-UNLOCK-PROMPTS-FOR-THIS-BROWSER-PROFILE',
    reason: 'local development — hot reload iteration',
  },
})

// After the initial createCompartment, dev unlock is persisted.
// Subsequent calls to createNoydb() in the same browser auto-unlock
// without any passphrase/biometric/OIDC prompt.
```

The `acknowledge` constant is a **literal string** (same pattern as naked mode #106):
- Grep-discoverable in code review
- Impossible to set via env var expansion accidentally
- Forces the developer to consciously type out a sentence confessing what they're doing

**Dev unlock cannot be enabled after the compartment exists.** Retroactively turning it on would let a malicious dep silently downgrade a production compartment — the same vector the naked-mode guardrails exist to prevent. It must be set at `createNoydb()` time, and attempting to change it later throws `DevUnlockMustBeSetAtCreationError`.

### Hard-blocked by environment checks

Dev unlock **refuses to initialize** if any of these are true:

1. `process.env.NODE_ENV === 'production'` (Node) — hard throw `DevUnlockInProductionError`
2. `import.meta.env.PROD === true` (Vite/Nuxt/Vitest) — hard throw
3. Running in a browser on a non-localhost origin — `window.location.hostname` not in `['localhost', '127.0.0.1', '::1']` → hard throw
4. Any CI environment variable set without explicit `NOYDB_DEV_UNLOCK_ALLOW_IN_CI=1` escape hatch — hard throw (for E2E runs that legitimately need it)
5. The adapter is `@noy-db/drive`, `@noy-db/s3`, or `@noy-db/dynamo` — hard throw `DevUnlockRemoteAdapterError`. Dev unlock and remote adapters cannot be combined, full stop. Only `memory`, `file` (under a debug directory prefix), and `browser` (with localhost check) are allowed.
6. OIDC is also configured on the same compartment — hard throw `DevUnlockWithOidcError`. OIDC implies production use; dev unlock implies local dev. Attempting both is a configuration mistake.

Each block throws a distinct error type so tests can assert on them individually.

### Storage mechanism

The wrapped KEK lives in IndexedDB under a reserved database + object-store name, with a distinct envelope shape:

```ts
// IndexedDB: noydb-dev-unlock / credentials / <compartment-handle>
{
  _dev_unlock: true,              // marker — distinct from normal credential envelopes
  _warning: 'DEV UNLOCK — DO NOT USE IN PRODUCTION',
  compartment: '01HXG...',        // handle only, never the human-readable name
  wrappedKek: ArrayBuffer,        // AES-KW wrap of the KEK
  wrappingKeyHandle: 'non-extractable-cryptokey-ref',
  enabledAt: '2026-04-08T...',
  enabledBy: 'user-id',
  reason: 'local development — hot reload iteration',
  origin: 'http://localhost:3000',  // enforced on load
}
```

On load:
1. Library reads the dev-unlock envelope from IndexedDB
2. Verifies `window.location.origin === envelope.origin` — if the origin changed (e.g. moved from `localhost:3000` to `localhost:5173`), refuses with `DevUnlockOriginMismatchError`
3. Verifies `envelope._dev_unlock === true` — if someone tampered with this to look like a normal credential, the parser trips on the marker and refuses
4. Unwraps the KEK with the non-extractable wrapping key
5. Emits `⚠️ DEV UNLOCK ACTIVE — this browser profile has the KEK` to console
6. Proceeds with compartment open

**The wrapping key itself is a non-extractable `AES-KW` CryptoKey generated via `crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey'])` and stored in IndexedDB via the structured clone mechanism.** This doesn't add cryptographic strength (the wrapping key and the wrapped KEK are in the same database), but it matches the browser's permission model for IDB and ensures that even if an attacker reads the IDB file from disk, they can't trivially extract the wrapping key bytes without running JS in the same origin.

### Loud runtime signals

Every dev-unlock session emits:

- **Console warning on every load**: `console.warn('⚠️ NOYDB DEV UNLOCK — this browser has the compartment KEK. Never deploy this to production.')` — uncatchable, unsuppressable
- **Persistent DOM banner** via an emitted event `devUnlock:active` that the Vue composable (and scaffolder template) renders as a red bar at the top of the page. The banner is NOT dismissible for the duration of the session.
- **Every `dump()` call carries a `_dev_unlock: true` flag** in the bundle header so `noydb inspect` displays it prominently: "This bundle was exported from a dev-unlock session."
- **The compartment's ledger records a `dev_unlock_enabled` entry** at the moment dev unlock is first configured. Disabling it records `dev_unlock_disabled`. These entries are tamper-evident via the existing ledger chain.

### Policy enforcement

Dev unlock slots into the session policy (#114) as a new unlock method with forced policy constraints that cannot be overridden:

```ts
{
  sessionPolicy: {
    perMethodOverrides: {
      'dev-unlock': {
        // These are HARD-CODED — policy cannot override them looser
        absoluteTimeoutMs: Infinity,       // no timeout — that's the point
        idleTimeoutMs: Infinity,
        requireReAuthFor: [                // but re-auth is MORE strict
          'export',
          'grant',
          'revoke',
          'rotate',
          'changeSecret',
          'deleteCompartment',
        ],
        // Export prompt is the critical one — even in dev unlock,
        // dumping the compartment to a file must require a real
        // acknowledgment, because dump() is the vector for accidentally
        // ending up with the KEK in a production artifact.
      },
    },
  },
}
```

So a dev-unlock session **stays open forever** (that's the feature) but **cannot export** without an explicit re-auth prompt that forces the dev to confirm.

## Acceptance criteria (security-critical)

- [ ] **Every production guard throws a distinct error type** with a test. `NODE_ENV=production`, `import.meta.env.PROD`, non-localhost origin, CI without opt-in, remote adapter, OIDC-also-enabled.
- [ ] **The `acknowledge` constant is a literal string check**, not a boolean coerce. Passing `true` or any other value throws `DevUnlockMissingAcknowledgmentError`.
- [ ] **Dev unlock cannot be enabled after compartment creation.** Attempting `enableDevUnlock()` on an existing compartment throws `DevUnlockMustBeSetAtCreationError`.
- [ ] **Origin check on every load.** Changing `window.location.origin` between sessions invalidates the stored credential. Covered by test.
- [ ] **The `_dev_unlock: true` marker is on every stored envelope**, every dumped bundle header, and every emitted session event. Grep-discoverable.
- [ ] **Production build tree-shakes the entire dev-unlock code path.** CI-asserted via a bundle analyzer check that no `dev_unlock` or `devUnlock` symbol appears in the production bundle.
- [ ] **A dev-unlock session cannot be upgraded to a production session.** Once a compartment has dev unlock enabled, its keyring is marked, and attempting to load it with `devUnlock.enabled: false` in a production environment throws `CompartmentWasDevUnlockedError` — requiring an explicit `rotateSecret()` call to erase the dev-unlock credential before production use.
- [ ] **The ledger chain records enable/disable events.** Covered by test.
- [ ] **The stored wrapping key is non-extractable** (`extractable: false` on the CryptoKey). Test verifies the extractable flag.
- [ ] **Dump() from a dev-unlock session refuses unless passed `allowDevUnlockExport: true`.** The resulting bundle carries `_dev_unlock: true` in its header.
- [ ] **The DOM banner emitted via `devUnlock:active` cannot be suppressed** by the library consumer without manually muting the event. Default scaffolder template renders it as a persistent red bar.

## The "what if I accidentally enabled this in staging" recovery path

If a developer ships a build with dev unlock configured (they shouldn't, the guards should prevent it, but defense in depth), the recovery is:

1. The production guards throw on app start → the app doesn't load at all → the dev-unlock credential is never touched
2. Developer rolls back the build
3. Developer calls `db.rotateSecret(compartment)` locally to invalidate the stored dev-unlock KEK wrap
4. Developer re-enrolls normal unlock methods
5. Ledger entry records the rotation, audit trail is intact

The worst-case outcome of a dev-unlock misconfiguration reaching staging is **the app refuses to run until the build is fixed**, not silent KEK exposure.

## Out of scope

- **Dev unlock on mobile.** localhost checks don't have a clean analog on mobile PWAs. Dev unlock is desktop-browser-only.
- **Dev unlock with multiple compartments.** Each dev-unlocked compartment is independent; there's no "dev unlock all compartments" mode.
- **Dev unlock for non-owner roles.** Only owners can enable it. Operator/viewer/client roles cannot have dev-unlock credentials.
- **Sharing dev-unlock credentials across devs.** Each developer on a team sets up their own. The credential is machine-local by construction.
- **Dev unlock for the CLI.** The CLI has a separate story — `NOYDB_PASSPHRASE` env var + explicit `--insecure` flag if the consumer wants it. Not part of this issue.

## Open questions

1. **Should dev unlock auto-disable after N days?** E.g., "this dev-unlock credential is 90 days old, prompt to re-confirm." Protects against abandoned dev setups. Probably yes — default 30 days, configurable.
2. **Should the banner be silenceable by power users?** E.g., environment variable `NOYDB_SUPPRESS_DEV_UNLOCK_BANNER=1`. The counterargument: the whole point of the banner is that it's annoying enough to prevent accidental production use. Lean: not silenceable.
3. **Should dev unlock be per-origin (localhost:3000 vs localhost:5173) or shared across localhost ports?** Per-origin is safer; cross-port is friendlier for devs who run multiple apps. Lean: per-origin, with clear error messages when the port changes.
4. **Should there be a devtool / browser extension command that nukes all dev-unlock credentials at once?** "Revoke dev unlock everywhere" as a panic button. Probably yes — useful for "I'm about to demo this to a client, make sure nothing is auto-unlocked."

## Why this is filed as `type: security` despite being a dev convenience

Same reasoning as naked mode (#106): the threat model for noy-db is "adapters are untrusted, crypto is the trust boundary, KEK lives in memory only during an active session." Dev unlock relaxes the last clause — the KEK lives in IndexedDB across sessions. Every guardrail in this issue exists to make that relaxation discoverable, auditable, and geographically confined to a dev machine. If any guardrail can be silently bypassed, dev unlock is a CVE waiting to happen.

Whoever picks this up should treat the guardrails as hard requirements and the feature as the side effect. The production-build tree-shaking check is non-negotiable.

## Dependencies

Blocked by:
- #109 — session tokens (dev unlock is a session method)
- #114 — session policies (`perMethodOverrides` must exist so dev unlock can force its own constraints)

Related:
- #106 — naked mode (same guardrail pattern, different target layer)
- #117 — v0.7 unlock flow discussion (canonical reference)
