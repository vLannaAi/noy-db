# Issue #238 — feat(on-pin): new @noy-db/on-pin — session-resume PIN / biometric quick-lock

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** Fork · On (@noy-db/on-*)
- **Labels:** type: feature, type: security

---

New package for the **session-resume unlock pattern**: the vault was opened earlier with the full passphrase; an idle timeout has locked the in-memory DEKs; the user taps a 4-digit PIN (or their device biometric) to resume within a short window.

**Security model:** the PIN derives a TRANSIENT wrapping key for the cached DEKs only, NEVER touches the KEK or re-derives from the passphrase. If the PIN is wrong, it fails fast; after N attempts the session is truly locked and the user must re-enter the full passphrase. Compromising the PIN alone cannot re-unlock from a cold start.

**API shape** (matches other on-* packages):

```ts
const resumeState = await enrollPin(keyring, { pin: "1234", ttlMs: 15 * 60 * 1000 })
// Later, after idle-lock:
const keyring = await resumePin(resumeState, { pin: "1234" })
```

Combines with `@noy-db/on-webauthn` for biometric-backed resume (tap fingerprint instead of PIN), same transient-wrapping-key design.
