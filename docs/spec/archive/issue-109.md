# Issue #109 — feat(core): session tokens — unlock-once JWE, non-extractable WebCrypto session key, tab-scoped lifetime

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-09
- **Milestone:** v0.7.0
- **Labels:** type: feature, type: security, area: core, epic

---

## Summary

Introduce **session tokens** as the foundational primitive for v0.7 "Identity & sessions." After the user unlocks a compartment once (via passphrase, WebAuthn, OIDC, or magic link), the KEK is wrapped with a **session-scoped, non-extractable WebCrypto key** and held in memory for a bounded lifetime. Subsequent operations within the session do not re-prompt for the passphrase. Tab close, idle timeout, and absolute timeout all destroy the session cleanly.

This is the primitive that every other v0.7 issue depends on. File first, implement first.

## Motivation

Today every `unlock()` call re-derives the KEK from the passphrase via PBKDF2@600K iterations. That's ~1 second on mid-range mobile — acceptable once per session, punishing on every operation. The current workaround is "hold the unlocked `Compartment` in memory and hope the caller doesn't drop it."

Real consumer flows need a session abstraction:

- A bookkeeper opens a compartment in the morning and works in it for 4 hours. They should not re-enter a passphrase on every save.
- A client portal user opens a read-only view, goes to lunch, comes back. The session should expire silently, not leave the plaintext sitting in memory forever.
- A mobile PWA gets backgrounded for 30 seconds while the user answers a call. The session should survive that round trip without prompting again.
- The tab crashes or the user closes it. The session must not persist to disk anywhere.

## Proposed design

### Session shape

```ts
interface NoydbSession {
  readonly id: string                    // opaque, random, logged for audit
  readonly compartmentName: string
  readonly userId: string
  readonly createdAt: Date
  readonly expiresAt: Date                // absolute timeout
  readonly idleTimeoutMs: number          // rolling idle window
  readonly lastActivityAt: Date
  isActive(): boolean
  touch(): void                           // resets idle timer
  destroy(): Promise<void>                // zero the wrapped KEK, fire 'session:destroyed'
}
```

Session lifetime is bounded by two timers — whichever fires first:

1. **Idle timeout** (default: 15 minutes) — resets on every touch().
2. **Absolute timeout** (default: 8 hours) — hard ceiling, no matter how active the user is.

### Session-scoped wrapping key

The KEK is not held as a raw `CryptoKey` reference for the duration of the session. Instead:

1. On unlock, derive the KEK normally (PBKDF2 for passphrase auth, or the appropriate path for WebAuthn/OIDC/magic-link).
2. Generate a **session wrapping key** with `crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey'])`. The critical flag is `extractable: false` — the browser will not let any code read the raw bytes of this key, not even our own.
3. Wrap the KEK with the session wrapping key → `wrappedKek: ArrayBuffer`.
4. Zero the original KEK bytes.
5. Hold only `{ sessionWrappingKey, wrappedKek, expiresAt, idleTimeoutMs }` for the session.

Every operation that needs the KEK does a fresh `unwrapKey()` call against the session wrapping key. If the session is destroyed, the wrapping key is dropped; the wrapped KEK becomes permanently unreadable even if a memory dump recovers its bytes.

This matches the pattern used by **1Password's session vault** and **Bitwarden's biometric unlock** — the session key is the only thing that can unwrap the KEK, and it cannot be exfiltrated.

### Destroying sessions

Sessions destroy on:

- Explicit `session.destroy()` call
- Idle timeout expiry (`lastActivityAt + idleTimeoutMs < now`)
- Absolute timeout expiry (`expiresAt < now`)
- `pagehide` event (tab about to be discarded)
- `visibilitychange` → `terminated` state
- `beforeunload` (last-resort)

Browser tab lifecycle events are the part most likely to be gotten wrong. The implementation must listen for all of them and must not wait for idle-timeout to catch a closed tab — an abandoned session that survived tab close could leave the wrapped KEK in a service worker or a BroadcastChannel context indefinitely.

### API surface

```ts
const db = await createNoydb({ adapter: file({ dir: './data' }) })

// Unlock creates a session.
const session = await db.unlock({
  compartment: 'acme',
  userId: 'vlanna',
  passphrase: 'correct horse battery staple',
  sessionPolicy: {
    idleTimeoutMs: 15 * 60 * 1000,        // 15m
    absoluteTimeoutMs: 8 * 60 * 60 * 1000, // 8h
  },
})

// All collection operations go through the session.
const compartment = session.compartment()
await compartment.collection('invoices').put({ id: 'inv-1', amount: 100 })

// Manual destroy.
await session.destroy()
```

Collections obtained from a destroyed session throw `SessionExpiredError` on any operation. They do not silently succeed against stale state.

## Acceptance criteria (security-critical)

- [ ] **Session wrapping key MUST be non-extractable.** `generateKey(..., false, [...])` — no exceptions. Test verifies `.extractable === false`.
- [ ] **Raw KEK MUST be zeroed** after wrapping with the session key. Test asserts the KEK `Uint8Array` is all zeros after unlock completes.
- [ ] **All three timers MUST trigger destroy**: idle, absolute, tab-lifecycle. Each covered by its own test.
- [ ] **`pagehide` / `visibilitychange→terminated` MUST destroy synchronously.** No awaiting network, no awaiting disk — the destroy must complete before the tab is allowed to unload.
- [ ] **Operations on destroyed sessions MUST throw** `SessionExpiredError`, not return stale data.
- [ ] **Sessions MUST NOT be serializable to disk** — no JSON.stringify path, no storage adapter interaction. Test verifies that attempting to persist a session throws.
- [ ] **Session IDs MUST be cryptographically random** (not incrementing, not timestamp-based). 128 bits minimum from `crypto.getRandomValues`.
- [ ] **Concurrent sessions on the same compartment MUST each have their own wrapping key.** Destroying one must not affect another.

## Open questions

1. **Do sessions survive page reload?** Browser page reload drops all in-memory state by definition, so "no" is the only safe default. But PWAs may want to survive a reload via `sessionStorage`-backed session IDs — rejecting this avoids a category of bugs, but may frustrate users. Lean: no, document the tradeoff.
2. **Do we emit session events to the consumer?** `session:created`, `session:destroyed`, `session:idle-warning` — useful for UI but adds surface area. Lean: yes, via the existing event emitter.
3. **Multi-compartment sessions** — should one unlock cover multiple compartments, or one session per compartment? Lean: one per compartment, to keep the trust boundary obvious.
4. **Does the session encrypt its own wrapped KEK with a CSPRNG IV that's also kept in the non-extractable key?** Over-engineering or necessary? AES-KW does not need an IV (it's deterministic wrapping), but if we ever switch to AES-GCM for wrapping we'd need to make this decision.

## Downstream issues that depend on this

- `@noy-db/auth-webauthn` — hardware-key unlock produces a session the same way passphrase unlock does
- `@noy-db/auth-oidc` — OIDC split-key unlock produces a session
- Magic-link unlock — produces a read-only session
- `_sync_credentials` reserved collection — decrypts adapter OAuth tokens lazily using the session-held KEK
- Session policies issue — adds policy knobs on top of the session primitive
